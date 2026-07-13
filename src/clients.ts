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
  ConnectionState,
  encodeServerMessage,
  type RoomName,
  type ServerMessage,
  type Timestamp,
  type Transport,
} from "./protocol.js";
import type { ChatClient, PeerKind, User } from "./types.js";

// The identity and room bookkeeping every client needs, regardless of how it is
// attached. The two transports differ only in how bytes leave and arrive.
export abstract class BaseClient implements ChatClient {
  readonly connectedAt: Timestamp = Date.now();
  protected identity?: User;
  protected currentRoom?: RoomName;

  constructor(
    readonly id: string,
    readonly transport: Transport,
    protected state: ConnectionState,
  ) {}

  abstract send(message: ServerMessage): void;
  abstract end(message: ServerMessage): void;

  get status(): ConnectionState {
    return this.state;
  }

  get user(): User | undefined {
    return this.identity;
  }

  get room(): RoomName | undefined {
    return this.currentRoom;
  }

  // Who this client is, for logging: the chosen nick, else the connection id.
  get label(): string {
    return this.identity?.name ?? this.id;
  }

  get uptime(): number {
    return Date.now() - this.connectedAt;
  }

  identifyAs(user: User): void {
    this.identity = user;
  }

  enterRoom(name: RoomName): void {
    this.currentRoom = name;
  }

  exitRoom(): void {
    this.currentRoom = undefined;
  }

  // The transitions the server can drive. A connection walks Connecting →
  // Connected → Closing → Disconnected and never goes back, which is why
  // ConnectionState has no "reconnecting": that is the client's business.
  markConnected(): void {
    this.state = ConnectionState.Connected;
  }

  markClosing(): void {
    this.state = ConnectionState.Closing;
  }

  markClosed(): void {
    this.state = ConnectionState.Disconnected;
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
  private inbox: Buffer = Buffer.alloc(0);

  constructor(private readonly socket: net.Socket, sequence: number) {
    // Accepted, but we do not yet know whether this is curl or a person.
    super(`c${sequence}`, "tcp", ConnectionState.Connecting);
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

  append(chunk: Buffer): void {
    this.inbox = Buffer.concat([this.inbox, chunk]);
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

  // Newline-delimited JSON. The trailing \n is not decoration: it is the frame
  // marker the other end splits on.
  send(message: ServerMessage): void {
    this.socket.write(`${encodeServerMessage(message)}\n`);
  }

  // Raw write: HTTP builds its own bytes, headers and all.
  write(raw: string): void {
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
    super(`w${sequence}`, "ws", ConnectionState.Connected);
  }

  // A client may be mid-disconnect: sending to a closing socket throws.
  send(message: ServerMessage): void {
    if (this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(encodeServerMessage(message));
    }
  }

  end(message: ServerMessage): void {
    this.send(message);
    this.markClosing();
    this.ws.close();
  }
}
