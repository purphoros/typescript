// The things the server is actually about: rooms, and what was said in them.
//
// Neither class knows a socket exists. A ChatRoom cannot send anything to
// anybody - it holds membership and history and answers questions. That is why
// it is testable in three lines, and why `state.ts` (which does know about
// clients) sits above it rather than inside it.

import { RingBuffer } from "./events.js";
import type { MessageSummary, RoomName, Timestamp, UserId } from "./protocol.js";
import type { Identifiable, Message, Serializable } from "./types.js";

// State plus behaviour: a room owns its membership and its history, and decides
// what of either it will show.
export class ChatRoom implements Serializable, Identifiable {
  readonly id: string;
  readonly createdAt: Timestamp;

  private members: Set<UserId> = new Set();
  private history: RingBuffer<ChatMessage>;

  constructor(public readonly name: RoomName, historyLimit: number) {
    this.id = crypto.randomUUID();
    this.createdAt = Date.now();
    this.history = new RingBuffer<ChatMessage>(historyLimit);
  }

  join(userId: UserId): void {
    this.members.add(userId);
  }

  leave(userId: UserId): boolean {
    return this.members.delete(userId);
  }

  hasMember(userId: UserId): boolean {
    return this.members.has(userId);
  }

  remember(message: ChatMessage): void {
    this.history.push(message);
  }

  recent(count: number): readonly ChatMessage[] {
    return this.history.recent(count);
  }

  // A getter exposes derived state without exposing the Set itself.
  get memberCount(): number {
    return this.members.size;
  }

  get memberList(): UserId[] {
    return [...this.members];
  }

  get messageCount(): number {
    return this.history.size;
  }

  serialize(): string {
    return JSON.stringify({ id: this.id, name: this.name, members: this.memberList });
  }
}

export class ChatMessage implements Message, Serializable {
  readonly id: string;
  readonly at: Timestamp;

  constructor(
    public sender: UserId,
    public text: string,
    public room: RoomName,
    public readonly replyTo?: string,
    at: Timestamp = Date.now(),
  ) {
    this.id = crypto.randomUUID();
    this.at = at;
  }

  // A message read back from disk did not happen just now.
  //
  // This exists because of a bug that only showed up by running the thing: the
  // first version rebuilt the archive with `new ChatMessage(sender, text, room)`
  // at startup, and `at` defaulted to Date.now(). Every restart quietly restamped
  // the entire history with the boot time - the file on disk was right, and
  // everything the server said about it was wrong. Persistence means preserving
  // *when*, not just what.
  static restore(summary: MessageSummary): ChatMessage {
    return new ChatMessage(summary.sender, summary.text, summary.room, undefined, summary.at);
  }

  serialize(): string {
    return JSON.stringify({
      id: this.id,
      sender: this.sender,
      text: this.text,
      room: this.room,
      replyTo: this.replyTo,
    });
  }
}
