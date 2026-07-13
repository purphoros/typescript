// The two ways a client can be attached, and the one interface that hides the
// difference.
//
// Everything above this module - the handler, the bus listeners, the whole chat
// logic - deals in `ChatClient` and never learns which of these it has. A line
// typed into `nc` lands in a browser tab because both of these classes know how
// to put a ServerMessage on their own wire, and nobody else has to care how.

import type net from "node:net";
import { WebSocket } from "ws";
import {
  CATALOG,
  ConnectionState,
  encodeServerMessage,
  type RoomName,
  type ServerMessage,
  type Timestamp,
  type Transport,
} from "./protocol.js";
import { ErrorCode, StateError } from "./errors.js";
import { clientId } from "./types.js";
import type { ChatClient, ClientId, ClientState, PeerKind, User } from "./types.js";

// How many bytes may be waiting to go out to one client before we give up on it.
//
// This number exists because of a bug the server has had since Chapter 5.
// `socket.write()` returns `false` when the kernel's send buffer is full - the
// runtime telling you, plainly, that the client is not reading as fast as you are
// writing. We have never once looked at that return value.
//
// Node does not drop the data. It queues it, in *our* process, forever. So one
// laptop that suspends mid-conversation, in a busy room, is a memory leak with a
// heartbeat: every broadcast appends to a buffer nobody is draining, and the
// process grows until it dies. The client is fine. We are the casualty.
//
// A megabyte is roughly a thousand chat messages behind. A client that far behind
// is not slow, it is gone, and the honest thing is to say so.
const MAX_BACKLOG_BYTES = 1_000_000;

// And how many bytes we will hold from a client before we have one complete
// thing to act on.
//
// A chat message is capped at 1KB by the schema (Chapter 14). An HTTP head plus
// a modest body is a few KB. 256KB is enormously generous for both - which is
// the point: anything past it is not a large message, it is a client that has
// stopped sending newlines, and we are the one paying for it.
const MAX_INBOX_BYTES = 256 * 1024;

// The identity and room bookkeeping every client needs, regardless of how it is
// attached. The two transports differ only in how bytes leave and arrive.
export abstract class BaseClient implements ChatClient {
  readonly connectedAt: Timestamp = Date.now();

  // One field, not two. See ClientState in types.ts for the bug this closes.
  protected presence: ClientState = { status: "anonymous" };

  constructor(
    readonly id: ClientId,
    readonly transport: Transport,
    // The *socket's* state. Deliberately a different field from `presence` above:
    // one is about the wire, the other about the conversation, and conflating them
    // is how you end up unable to say "connected, but has not spoken".
    protected connection: ConnectionState,
  ) {}

  abstract send(message: ServerMessage): void;
  abstract end(message: ServerMessage): void;

  // Bytes written but not yet accepted by the far end. Each transport measures
  // this differently; both of them can.
  abstract get backlog(): number;

  // Hang up, now, without trying to say anything first - there is already too
  // much unsent.
  protected abstract destroy(): void;

  private dropped?: string;

  // Called before every write. If the client is too far behind, we stop, because
  // continuing means buffering their mail in our heap indefinitely.
  protected accepts(): boolean {
    if (this.dropped !== undefined) {
      return false;
    }
    if (this.backlog > MAX_BACKLOG_BYTES) {
      this.dropped = `not reading - ${Math.round(this.backlog / 1024)}KB unsent`;
      this.markClosing();
      this.destroy();
      return false;
    }
    return true;
  }

  // Why this client was hung up on, if it was. The server reads this in its close
  // handler, so a dropped slow client is a line in the log and not a mystery.
  get dropReason(): string | undefined {
    return this.dropped;
  }

  get status(): ConnectionState {
    return this.connection;
  }

  get state(): ClientState {
    return this.presence;
  }

  // `user` and `room` are *derived*. They are not storage, so they cannot
  // disagree with anything - the union already decided.
  get user(): User | undefined {
    return this.presence.status === "anonymous" ? undefined : this.presence.user;
  }

  get room(): RoomName | undefined {
    return this.presence.status === "chatting" ? this.presence.room : undefined;
  }

  // What to *call* this client. Note that this changes when they pick a name -
  // which is precisely why rooms must never key membership on it. `id` is
  // immutable; `label` is a display name. Chapter 16 learned the difference the
  // hard way.
  get label(): string {
    return this.user?.name ?? this.id;
  }

  get uptime(): number {
    return Date.now() - this.connectedAt;
  }

  // Legal from any state. Renaming while in a room keeps you in the room - you
  // are the same connection, you just answer to something else now.
  identifyAs(user: User): void {
    this.presence =
      this.presence.status === "chatting"
        ? { status: "chatting", user, room: this.presence.room }
        : { status: "identified", user };
  }

  // The one transition the state machine actually forbids. You cannot be in a
  // room without being somebody, because `chatting` carries a `user` and there is
  // no way to construct it without one.
  enterRoom(name: RoomName): void {
    if (this.presence.status === "anonymous") {
      throw new StateError(
        `Log in first, e.g. ${CATALOG.login.example}`,
        ErrorCode.NotIdentified,
      );
    }
    this.presence = { status: "chatting", user: this.presence.user, room: name };
  }

  exitRoom(): void {
    if (this.presence.status !== "chatting") {
      throw new StateError("You are not in a room.");
    }
    this.presence = { status: "identified", user: this.presence.user };
  }

  // Back to being nobody. Logging out is a state transition like any other, and
  // the machine makes it exactly one line - there is no scattered set of fields
  // to remember to clear.
  forget(): void {
    this.presence = { status: "anonymous" };
  }

  // The transitions the server can drive. A connection walks Connecting →
  // Connected → Closing → Disconnected and never goes back, which is why
  // ConnectionState has no "reconnecting": that is the client's business.
  markConnected(): void {
    this.connection = ConnectionState.Connected;
  }

  markClosing(): void {
    this.connection = ConnectionState.Closing;
  }

  markClosed(): void {
    this.connection = ConnectionState.Disconnected;
  }
}

// A raw TCP client: telnet, nc, a person at a terminal.
//
// TCP is a byte stream, not a sequence of messages. What arrives in one "data"
// event is whatever happened to be in flight - half a line, three lines, the
// headers of a request but not its body. So bytes are buffered here until a
// whole unit is present, and only then handed on.
//
// That framing work, done back in Chapter 5, is exactly what earns us JSON: one
// object per line. The newline is the frame.
export class TcpClient extends BaseClient {
  readonly address: string;

  private peer: PeerKind = "unknown";

  // Buffer is Node's type for raw bytes, and it lives *outside* the V8 heap -
  // which is why an unbounded one shows up in `rss` while `heapUsed` looks
  // perfectly calm. See MAX_INBOX_BYTES.
  private inbox: Buffer = Buffer.alloc(0);

  constructor(private readonly socket: net.Socket, sequence: number) {
    // Accepted, but we do not yet know whether this is curl or a person.
    super(clientId(`c${sequence}`), "tcp", ConnectionState.Connecting);
    this.address = `${socket.remoteAddress}:${socket.remotePort}`;
  }

  get mode(): PeerKind {
    return this.peer;
  }

  // Bytes received but not yet consumed.
  get pending(): Buffer {
    return this.inbox;
  }

  becomes(peer: PeerKind): void {
    this.peer = peer;
  }

  // Returns false when the client has sent more than we are willing to hold.
  //
  // The other bug of this chapter. `inbox` grew without limit: a client that
  // opens a socket and sends 500MB with no newline in it was, until now, 500MB
  // of Buffer in our process. We would dutifully hold all of it, waiting for a
  // line ending that was never coming.
  //
  // The framing is what makes the bound possible. We only ever need enough bytes
  // to hold one complete unit - one JSON line, or one HTTP head plus body - and
  // anything past that is not a slow client, it is an attack or a bug.
  append(chunk: Buffer): boolean {
    this.inbox = Buffer.concat([this.inbox, chunk]);
    return this.inbox.length <= MAX_INBOX_BYTES;
  }

  // Drop the first `count` bytes - they have been dealt with.
  consume(count: number): void {
    this.inbox = this.inbox.subarray(count);
  }

  // Every *complete* line in the buffer. A trailing partial line stays put until
  // the rest of it arrives - a half-delivered JSON object is not JSON.
  takeLines(): string[] {
    const lines: string[] = [];
    let newline = this.inbox.indexOf(0x0a);
    while (newline !== -1) {
      lines.push(this.inbox.subarray(0, newline).toString("utf8").replace(/\r$/, ""));
      this.inbox = this.inbox.subarray(newline + 1);
      newline = this.inbox.indexOf(0x0a);
    }
    return lines;
  }

  // Bytes handed to the kernel that the far end has not acknowledged. Node keeps
  // the count for us; we have simply never asked.
  get backlog(): number {
    return this.socket.writableLength;
  }

  protected destroy(): void {
    this.socket.destroy();
  }

  // Newline-delimited JSON. The trailing \n is not decoration: it is the frame
  // marker the other end splits on.
  send(message: ServerMessage): void {
    this.write(`${encodeServerMessage(message)}\n`);
  }

  // Raw write: HTTP builds its own bytes, headers and all.
  //
  // `socket.write()` returns false when the send buffer is full. We now believe
  // it - see accepts() and MAX_BACKLOG_BYTES.
  write(raw: string): void {
    if (!this.accepts()) {
      return;
    }
    this.socket.write(raw);
  }

  end(message: ServerMessage): void {
    this.send(message);
    this.markClosing();
    this.socket.end();
  }

  close(): void {
    this.markClosing();
    this.socket.end();
  }
}

// A WebSocket client: a browser tab, or wscat. `ws` has already done the
// framing, so a message arrives whole - no buffering, no newline hunting. One
// frame is one JSON object.
export class WsClient extends BaseClient {
  constructor(
    private readonly ws: WebSocket,
    sequence: number,
    readonly address: string,
  ) {
    // The handshake is already done by the time `ws` hands us the socket.
    super(clientId(`w${sequence}`), "ws", ConnectionState.Connected);
  }

  // `ws` keeps the same count under a different name. Same disease, same cure.
  get backlog(): number {
    return this.ws.bufferedAmount;
  }

  protected destroy(): void {
    // terminate(), not close(): close() is a polite handshake that a client
    // which has stopped reading will never complete.
    this.ws.terminate();
  }

  // A client may be mid-disconnect: sending to a closing socket throws.
  send(message: ServerMessage): void {
    if (this.ws.readyState !== WebSocket.OPEN || !this.accepts()) {
      return;
    }
    this.ws.send(encodeServerMessage(message));
  }

  end(message: ServerMessage): void {
    this.send(message);
    this.markClosing();
    this.ws.close();
  }
}
