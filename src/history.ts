// History that survives a restart.
//
// This is the first thing in the entire server that genuinely waits. Every
// chapter until now ran to completion the moment it was called; a disk does not,
// and everything awkward about this module comes from that one fact.
//
// The shape is a write-through archive. Each room gets an append-only file of
// newline-delimited JSON - the same NDJSON framing the TCP transport uses, which
// is not a coincidence: a format that survives a half-delivered socket read also
// survives a half-completed write, because a torn last line is simply a line
// that does not parse, and we skip it.
//
//   data/general.jsonl
//   {"sender":"alice","text":"hello","room":"general","at":1783922995565}
//   {"sender":"bob","text":"hi","room":"general","at":1783922996001}
//
// Two layers, and the split is deliberate:
//
//   the RingBuffer in ChatRoom  - the last 50, in memory. What a joiner is shown.
//                                 Nobody waits for a disk to join a room.
//   this file                   - everything, on disk. What {"type":"history"}
//                                 reads when you ask for more than memory holds.
//
// Hot path in memory, deep query on disk. That is not a compromise, it is what a
// database is.

import { appendFile, mkdir, readFile } from "node:fs/promises";
import path from "node:path";
import { Serializer, withTimeout } from "./async.js";
import { asError } from "./errors.js";
import type { MessageSummary, RoomName } from "./protocol.js";

// A disk that has not answered in two seconds is a disk that has a problem, and
// waiting longer will not fix it.
const WRITE_TIMEOUT_MS = 2000;

export class FileHistory {
  // One queue per room, not one for the whole server. Writes to `general` must
  // not queue behind writes to `dev` - they are independent files, and making
  // them wait on each other would be inventing a bottleneck.
  private readonly queues = new Map<RoomName, Serializer>();

  constructor(private readonly dir: string) {}

  private file(room: RoomName): string {
    // A room name off the wire must never become `../../etc/passwd`. Rooms are
    // configured, not user-created, so this cannot currently happen - which is
    // exactly when to write the line, before someone adds a "create room"
    // message and does not think about it.
    return path.join(this.dir, `${path.basename(room)}.jsonl`);
  }

  private queue(room: RoomName): Serializer {
    let queue = this.queues.get(room);
    if (queue === undefined) {
      queue = new Serializer();
      this.queues.set(room, queue);
    }
    return queue;
  }

  async open(): Promise<void> {
    await mkdir(this.dir, { recursive: true });
  }

  // Append one message, durably.
  //
  // Two problems solved in one line, and both were invisible before this file
  // was asynchronous:
  //
  // The Serializer is why two messages sent in the same breath land in the order
  // they were sent. Fire two bare appendFile calls and the OS may interleave
  // them; the file is then a record of what happened in an order that never
  // happened.
  //
  // The timeout is why a wedged disk cannot stop the chat. The write still keeps
  // trying - a Promise cannot be un-started - but we stop waiting, the queue
  // moves on, and someone gets told.
  append(message: MessageSummary): Promise<void> {
    const line = `${JSON.stringify(message)}\n`;
    return this.queue(message.room).run(() =>
      withTimeout(appendFile(this.file(message.room), line, "utf8"), WRITE_TIMEOUT_MS, `write to ${message.room}`),
    );
  }

  // Every message a room has ever held, oldest first.
  //
  // A missing file is not an error - it is a room nobody has said anything in
  // yet. That distinction has to be made here, because to `readFile` they look
  // identical until you check the code.
  async read(room: RoomName): Promise<MessageSummary[]> {
    let raw: string;
    try {
      raw = await readFile(this.file(room), "utf8");
    } catch (thrown: unknown) {
      if ((asError(thrown) as NodeJS.ErrnoException).code === "ENOENT") {
        return []; // never written to. Not a failure.
      }
      throw thrown; // a real I/O error: permissions, a bad disk. Say so.
    }

    const messages: MessageSummary[] = [];
    for (const line of raw.split("\n")) {
      if (line.trim().length === 0) {
        continue;
      }
      try {
        messages.push(JSON.parse(line) as MessageSummary);
      } catch {
        // A torn final line - the process died mid-write. Skip it and keep the
        // rest. An append-only log degrades to "everything up to the crash",
        // which is the best any log can promise and better than throwing away
        // the file because its last 40 bytes are bad.
        continue;
      }
    }
    return messages;
  }

  // The last `limit` messages in a room.
  async recent(room: RoomName, limit: number): Promise<MessageSummary[]> {
    const all = await this.read(room);
    return all.slice(-limit);
  }

  // Everything written so far is actually on disk.
  //
  // Promise.all, not allSettled: at shutdown we want to know if a write failed,
  // and there is nothing to be best-effort about. It also fails fast, which is
  // right - the process is leaving either way.
  async flush(): Promise<void> {
    await Promise.all([...this.queues.values()].map((queue) => queue.drain()));
  }
}
