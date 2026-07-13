// Chat server - TCP, HTTP and WebSocket on one port, now speaking a protocol
// instead of a pile of strings.
//
// Chapters 5-8 parsed what clients sent by splitting on whitespace and looking
// at the first word. It worked, and it was a lie: nothing in the type system
// knew that "/join" needed a room, that "/nick" needed a name, or that "/jion"
// was not a command at all. Every one of those questions was answered at
// runtime, by a string comparison, in a switch that would happily fall through
// to `default` and shrug.
//
// src/protocol.ts replaces the lot with two discriminated unions. Clients send a
// ClientMessage; the server answers with a ServerMessage. Both transports carry
// the same JSON - one object per line over TCP, one object per frame over
// WebSocket - so a `nc` session and a browser tab are now literally speaking the
// same language, not two dialects that happen to rhyme.
//
// The compiler enforces all of it. handleMessage switches on `msg.type` and
// assertNever holds it to account: add a variant to ClientMessage and this file
// stops compiling until it is handled. Not a TODO. A build error.

import net from "node:net";
import { IncomingMessage } from "node:http";
import { WebSocketServer, WebSocket } from "ws";
import { TypedEmitter, RingBuffer, pluck } from "./events";
import {
  assertNever,
  CATALOG,
  COMMANDS,
  ConnectionState,
  decodeClientMessage,
  describeState,
  encodeServerMessage,
  ErrorCode,
  type ClientMessage,
  type MessageSummary,
  type RoomName,
  type RoomSummary,
  type ServerMessage,
  type Timestamp,
  type Transport,
  type UserId,
  type UserSummary,
} from "./protocol";

// --- Domain types --------------------------------------------------------

type Host = string;
type Port = number;

// What the peer turned out to be. "unknown" until the first line arrives. This
// is the *transport* the peer is speaking, not to be confused with the message
// protocol in protocol.ts - HTTP and chat clients both end up sending JSON, they
// just wrap it differently.
type PeerKind = "unknown" | "chat" | "http";

// `Readonly<T>` marks every property immutable, so nothing can reassign the
// config after startup.
type ServerConfig = Readonly<{
  host: Host;
  port: Port;
  rooms: readonly RoomName[];
  historyLimit: number;
}>;

// --- Configuration -------------------------------------------------------

// `as const` gives every field its literal type and makes the object readonly:
// DEFAULTS.port has type 8080, not number, and cannot be reassigned.
const DEFAULTS = {
  host: "127.0.0.1",
  port: 8080,
  rooms: ["general", "random", "dev"],
  historyLimit: 50,
} as const;

// `Partial<T>` makes every property optional, which is exactly what an override
// is: supply the fields you care about, inherit the rest.
function configure(base: ServerConfig, overrides: Partial<ServerConfig>): ServerConfig {
  return { ...base, ...overrides };
}

// A client that connects and says nothing is assumed to be a human at a
// terminal, and gets greeted. curl and browsers send their request at once.
const GREETING_DELAY_MS = 200;

// How much history a joining client is shown.
const HISTORY_ON_JOIN = 5;

// --- Interfaces ----------------------------------------------------------

interface Identifiable {
  readonly id: string;
}

interface Serializable {
  serialize(): string;
}

interface User extends Identifiable {
  name: string;
  joinedAt: Timestamp;
}

// An admin IS-A user with more besides. Structural typing means an AdminUser
// can be passed anywhere a User is expected, with no `implements` needed.
interface AdminUser extends User {
  adminLevel: number;
  permissions: string[];
}

interface Message extends Identifiable {
  sender: UserId;
  text: string;
  room: RoomName;
  replyTo?: string;   // optional: string | undefined
  editedAt?: Timestamp;
}

// Anyone the server can talk to, however they got here.
//
// Note what send() now takes. It is not a string - it is a ServerMessage. The
// transport decides how to put it on the wire; the chat logic never builds a
// line of output by hand again, and cannot send a shape no client understands.
interface ChatClient extends Identifiable {
  readonly transport: Transport;
  readonly connectedAt: Timestamp;
  readonly label: string;
  readonly uptime: number;
  readonly status: ConnectionState;
  readonly user: User | undefined;
  readonly room: RoomName | undefined;
  send(message: ServerMessage): void;
  end(message: ServerMessage): void;
  identifyAs(user: User): void;
  enterRoom(name: RoomName): void;
  exitRoom(): void;
}

// One parsed HTTP request. Header names are lowercased: HTTP header names are
// case-insensitive, so `Content-Length` and `content-length` must not differ.
interface HttpRequest {
  method: string;
  path: string;
  version: string;
  headers: Map<string, string>;
  body: string | undefined;
}

// `Record<K, V>` is an object with keys of one type and values of another -
// here, header name to header value.
interface HttpResponse {
  status: number;
  headers: Record<string, string>;
  body: string;
}

// What reading the buffer produced. A discriminated union: the caller switches
// on `kind` and the compiler hands it exactly the right fields.
type HttpOutcome =
  | { kind: "incomplete" }                                       // still arriving
  | { kind: "handled" }                                          // answered, closing
  | { kind: "upgrade"; request: HttpRequest; head: Buffer };     // hand off to ws

// What the server writes to its own console. This is *not* ServerMessage: the
// log records things no client is ever told - an HTTP request, a socket error, a
// protocol violation - and deliberately omits things clients do see, like the
// text of a private whisper. Two audiences, two unions.
type ChatEvent =
  | { type: "message"; user: UserId; room: RoomName; text: string; at: Timestamp }
  | { type: "whisper"; from: UserId; to: UserId; at: Timestamp }
  | { type: "join"; user: UserId; room: RoomName; at: Timestamp }
  | { type: "leave"; user: UserId; room: RoomName; at: Timestamp }
  | { type: "kick"; by: UserId; target: UserId; reason: string; at: Timestamp }
  | { type: "system"; text: string; at: Timestamp };

// The bus's contract: event name → the handler that listens for it. Every
// bus.emit and bus.on in this file is checked against this map. Misspell an
// event, or pass a room where a client belongs, and it does not compile.
//
// This must be a `type`, not an `interface`. An interface has no implicit index
// signature, so it does not satisfy `EventMap`'s `Record<string, ...>`
// constraint, and `TypedEmitter<ServerEvents>` fails with TS2344. A type alias
// does. It is a one-word difference and an unhelpful error message.
type ServerEvents = {
  connect: (client: ChatClient) => void;
  disconnect: (client: ChatClient, remaining: number) => void;
  join: (client: ChatClient, room: RoomName) => void;
  leave: (client: ChatClient, room: RoomName) => void;
  message: (message: ChatMessage) => void;
  whisper: (from: ChatClient, to: ChatClient, text: string) => void;
  kick: (by: ChatClient, target: ChatClient, reason: string) => void;
  request: (method: string, path: string, status: number) => void;
  upgrade: (id: string) => void;
  notice: (text: string) => void;
  failure: (source: string, error: Error) => void;
};

// --- Classes -------------------------------------------------------------

// State plus behaviour: a room owns its membership and its history, and decides
// what of either it will show.
class ChatRoom implements Serializable, Identifiable {
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

class ChatMessage implements Message, Serializable {
  readonly id: string;
  readonly at: Timestamp;

  constructor(
    public sender: UserId,
    public text: string,
    public room: RoomName,
    public readonly replyTo?: string,
  ) {
    this.id = crypto.randomUUID();
    this.at = Date.now();
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

// The identity and room bookkeeping every client needs, regardless of how it
// is attached. The two transports differ only in how bytes leave and arrive.
abstract class BaseClient implements ChatClient {
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

  // The three transitions the server can drive. A connection walks Connecting →
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
// That framing work, done back in Chapter 5, is exactly what earns us JSON here:
// one object per line. The newline is the frame.
class TcpClient extends BaseClient {
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

  // Every *complete* line in the buffer. A trailing partial line stays put
  // until the rest of it arrives - a half-delivered JSON object is not JSON.
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
class WsClient extends BaseClient {
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

// --- Functions -----------------------------------------------------------

// Parse a port from a string, falling back when it is missing or out of range.
function parsePort(input: string, fallback: Port = DEFAULTS.port): Port {
  const parsed = parseInt(input, 10);
  if (isNaN(parsed) || parsed <= 0 || parsed > 65535) {
    return fallback;
  }
  return parsed;
}

// The port is optional: `??` supplies the default when it is null or undefined.
function address(host: Host, port?: Port): string {
  return `${host}:${port ?? config.port}`;
}

// The reason phrase for an HTTP status code - the text after the number on the
// response's first line.
function statusLine(code: number): string {
  switch (code) {
    case 101: return "Switching Protocols";
    case 200: return "OK";
    case 201: return "Created";
    case 204: return "No Content";
    case 301: return "Moved Permanently";
    case 400: return "Bad Request";
    case 401: return "Unauthorized";
    case 403: return "Forbidden";
    case 404: return "Not Found";
    case 405: return "Method Not Allowed";
    case 500: return "Internal Server Error";
    default:  return "Unknown";
  }
}

// A custom type guard. AdminUser is the only variant carrying `adminLevel`, so
// the `in` check is enough to narrow - no discriminant field required.
function isAdmin(user: User): user is AdminUser {
  return "adminLevel" in user;
}

// Data off the wire has no type. `unknown` forces us to narrow before use -
// unlike `any`, which would wave anything through unchecked.
function parseInput(input: unknown): string {
  if (typeof input === "string") return input.trim();
  if (typeof input === "number") return input.toString();
  if (typeof input === "boolean") return input ? "true" : "false";
  if (input === null) return "<null>";
  if (input === undefined) return "<undefined>";
  return "<unsupported>";
}

// Narrowing by discriminant: each branch sees only that variant's fields. Add a
// ChatEvent variant and the assertNever call below names it as the one you have
// not handled.
function formatEvent(event: ChatEvent): string {
  switch (event.type) {
    case "message": return `[${event.room}] ${event.user}: ${event.text}`;
    case "whisper": return `${event.from} → ${event.to} (private)`;
    case "join":    return `→ ${event.user} joined ${event.room}`;
    case "leave":   return `← ${event.user} left ${event.room}`;
    case "kick":    return `⚡ ${event.by} kicked ${event.target}: ${event.reason}`;
    case "system":  return `[SYSTEM] ${event.text}`;
    default:        return assertNever(event);
  }
}

function formatDuration(ms: number): string {
  const seconds = Math.floor(ms / 1000);
  const minutes = Math.floor(seconds / 60);
  return minutes > 0 ? `${minutes}m ${seconds % 60}s` : `${seconds}s`;
}

// The class knows its own id and how to serialize itself. The wire needs neither.
function summarize(message: ChatMessage): MessageSummary {
  return { sender: message.sender, text: message.text, room: message.room, at: message.at };
}

function describeClient(client: ChatClient): UserSummary {
  const user = client.user;
  return {
    id: client.id,
    label: client.label,
    transport: client.transport,
    room: client.room ?? null,
    admin: user !== undefined && isAdmin(user),
  };
}

function describeRoom(room: ChatRoom): RoomSummary {
  return { name: room.name, members: room.memberCount, messages: room.messageCount };
}

// --- Server state --------------------------------------------------------

const config = configure(
  DEFAULTS,
  process.argv[2] !== undefined ? { port: parsePort(process.argv[2]) } : {},
);

const rooms = new Map<RoomName, ChatRoom>();
for (const name of config.rooms) {
  rooms.set(name, new ChatRoom(name, config.historyLimit));
}

// Users the server already knows about. Chapter 17 replaces this with real
// authentication; for now a "nick" message simply claims an identity.
const knownUsers = new Map<string, User | AdminUser>([
  ["alice", { id: "u1", name: "alice", joinedAt: Date.now(), adminLevel: 2, permissions: ["kick", "ban", "mute"] }],
  ["bob", { id: "u2", name: "bob", joinedAt: Date.now() }],
]);

// Every live chat client, TCP or WebSocket alike. HTTP requests come and go
// within a single exchange and are never listed here.
const clients = new Map<string, ChatClient>();
let sequence = 0;

// --- The event bus -------------------------------------------------------

const bus = new TypedEmitter<ServerEvents>();

// Send to everyone in a room, optionally skipping one client (usually the
// sender). Transport is irrelevant here: a message typed into nc lands in a
// browser, and vice versa, because both are just ChatClients being handed a
// ServerMessage that each knows how to put on its own wire.
function broadcast(room: RoomName, message: ServerMessage, except?: ChatClient): void {
  for (const client of clients.values()) {
    if (client.room === room && client !== except) {
      client.send(message);
    }
  }
}

function log(event: ChatEvent): void {
  console.log(formatEvent(event));
}

// Listener 1: the log. Every event becomes a ChatEvent record and is printed.
bus.on("connect", (client) =>
  log({ type: "system", text: `${client.id} connected [${client.transport}]`, at: Date.now() }));
bus.on("disconnect", (client, remaining) =>
  log({ type: "system", text: `${client.label} disconnected (${remaining} remaining)`, at: Date.now() }));
bus.on("join", (client, room) =>
  log({ type: "join", user: client.label, room, at: Date.now() }));
bus.on("leave", (client, room) =>
  log({ type: "leave", user: client.label, room, at: Date.now() }));
bus.on("message", (message) =>
  log({ type: "message", user: message.sender, room: message.room, text: message.text, at: message.at }));
// The log records *that* a whisper happened. It does not record what it said.
bus.on("whisper", (from, to) =>
  log({ type: "whisper", from: from.label, to: to.label, at: Date.now() }));
bus.on("kick", (by, target, reason) =>
  log({ type: "kick", by: by.label, target: target.label, reason, at: Date.now() }));
bus.on("request", (method, path, status) =>
  log({ type: "system", text: `${method} ${path} → ${status} ${statusLine(status)}`, at: Date.now() }));
bus.on("upgrade", (id) =>
  log({ type: "system", text: `${id} upgrading to WebSocket → 101 ${statusLine(101)}`, at: Date.now() }));
bus.on("notice", (text) =>
  log({ type: "system", text, at: Date.now() }));
bus.on("failure", (source, error) =>
  log({ type: "system", text: `${source} error: ${error.message}`, at: Date.now() }));

// Listener 2: the room's memory. Messages are kept so a late joiner can catch up.
bus.on("message", (message) => {
  rooms.get(message.room)?.remember(message);
});

// Listener 3: the wire. This is what actually delivers chat to other people -
// and every line of it now hands over a ServerMessage, not a formatted string.
bus.on("message", (message) => {
  broadcast(message.room, {
    type: "chat",
    sender: message.sender,
    text: message.text,
    room: message.room,
    at: message.at,
  });
});
bus.on("whisper", (from, to, text) => {
  const delivered: ServerMessage = {
    type: "whisper",
    from: from.label,
    to: to.label,
    text,
    at: Date.now(),
  };
  to.send(delivered);
  from.send(delivered); // the sender sees their own whisper land
});
bus.on("join", (client, room) => {
  broadcast(room, { type: "joined", user: client.label, room, members: rooms.get(room)?.memberCount ?? 0 }, client);
});
bus.on("leave", (client, room) => {
  broadcast(room, { type: "left", user: client.label, room }, client);
});
bus.on("kick", (by, target, reason) => {
  const room = target.room;
  if (room !== undefined) {
    broadcast(room, { type: "system", text: `${target.label} was kicked by ${by.label}: ${reason}` }, target);
  }
  target.end({ type: "kicked", by: by.label, reason });
});

// Four listeners across "message", "whisper" and "kick", and the code that emits
// them knows about none of them. That is still the point: handleMessage
// announces, it does not orchestrate.

// --- HTTP ----------------------------------------------------------------

// `GET /path HTTP/1.1` - the shape of an HTTP request's first line. Anything
// else on the wire is a chat client. A JSON object never matches this, so the
// sniffing from Chapter 6 survives the protocol change untouched.
const HTTP_REQUEST_LINE = /^(GET|HEAD|POST|PUT|PATCH|DELETE|OPTIONS) \S+ HTTP\/1\.[01]$/;

const CRLF = "\r\n";
const HEADERS_END = "\r\n\r\n";

// Split the head of a request into a method, a path, and headers. Returns null
// if the request line is malformed - a 400, not a crash.
function parseRequest(head: string, body: string | undefined): HttpRequest | null {
  const lines = head.split(CRLF);
  const requestLine = lines[0] ?? "";
  const [method, path, version] = requestLine.split(" ");

  if (method === undefined || path === undefined || version === undefined) {
    return null;
  }

  const headers = new Map<string, string>();
  for (const line of lines.slice(1)) {
    const colon = line.indexOf(":");
    if (colon > 0) {
      // Header names are case-insensitive; normalise so lookups always hit.
      headers.set(line.slice(0, colon).trim().toLowerCase(), line.slice(colon + 1).trim());
    }
  }

  return { method, path, version, headers, body };
}

// Content-Length counts BYTES, not characters. One emoji is a single character
// but four bytes in UTF-8; get this wrong and the client hangs waiting for the
// rest of a body that already arrived.
function serializeResponse(res: HttpResponse): string {
  const headers: Record<string, string> = {
    "Content-Length": String(Buffer.byteLength(res.body)),
    Connection: "close",
    ...res.headers,
  };

  let out = `HTTP/1.1 ${res.status} ${statusLine(res.status)}${CRLF}`;
  for (const [name, value] of Object.entries(headers)) {
    out += `${name}: ${value}${CRLF}`;
  }
  return out + CRLF + res.body;
}

function json(status: number, payload: unknown): HttpResponse {
  return {
    status,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload, null, 2),
  };
}

function html(status: number, body: string): HttpResponse {
  return { status, headers: { "Content-Type": "text/html; charset=utf-8" }, body };
}

// This is the whole handshake, as far as we are concerned: a GET that says it
// wants to become a WebSocket. `ws` validates the key and version for us.
function isWebSocketUpgrade(req: HttpRequest): boolean {
  return (
    req.method === "GET" &&
    req.headers.get("upgrade")?.toLowerCase() === "websocket" &&
    (req.headers.get("connection")?.toLowerCase().includes("upgrade") ?? false)
  );
}

// A browser client, served from the same port it will connect back to.
//
// This is the other half of the protocol, and it is worth reading as such. The
// page builds a ClientMessage from what you type and switches over every
// ServerMessage it might be sent - the same two unions, from the other end. The
// slash commands are gone from the server and live here instead, which is where
// they always belonged: they are input sugar for a human, not part of the wire.
function chatPage(): string {
  return `<!doctype html>
<meta charset="utf-8">
<title>Chat</title>
<h1>Chat server</h1>
<p>${clients.size} client(s) connected across ${rooms.size} rooms.</p>
<p><small>Type a message, or /join general, /nick alice, /who, /rooms, /history,
/w bob hello, /leave, /status, /help</small></p>
<div id="log" style="font-family:monospace;white-space:pre-wrap"></div>
<input id="input" style="width:30em" placeholder="/join general" autofocus>
<script>
  const logEl = document.getElementById("log");
  const log = (line) => { logEl.textContent += line + "\\n"; };

  // A client-side ConnectionState. This is where "reconnecting" lives - the
  // server never has that state, because a server does not reconnect.
  let state = "connecting";
  let ws = null;

  // What you typed → a ClientMessage. The server no longer parses slashes;
  // this does, and sends it a well-formed object.
  const toMessage = (input) => {
    if (!input.startsWith("/")) return { type: "chat", text: input };
    const [command, ...rest] = input.slice(1).split(" ");
    switch (command) {
      case "join":    return { type: "join", room: rest[0] ?? "" };
      case "nick":    return { type: "nick", name: rest[0] ?? "" };
      case "leave":   return { type: "leave" };
      case "who":     return { type: "who" };
      case "rooms":   return { type: "rooms" };
      case "history": return { type: "history" };
      case "status":  return { type: "status" };
      case "help":    return { type: "help" };
      case "quit":    return { type: "quit" };
      case "w":
      case "whisper": return { type: "whisper", to: rest[0] ?? "", text: rest.slice(1).join(" ") };
      case "kick":    return { type: "kick", target: rest[0] ?? "", reason: rest.slice(1).join(" ") || "no reason" };
      default:        return null;
    }
  };

  // A ServerMessage → a line on screen. Every variant the server can send is
  // handled here; anything else is a bug worth seeing rather than swallowing.
  const render = (msg) => {
    const time = (at) => new Date(at).toLocaleTimeString();
    switch (msg.type) {
      case "welcome":  return msg.text;
      case "system":   return "[system] " + msg.text;
      case "chat":     return "[" + time(msg.at) + "] " + msg.sender + ": " + msg.text;
      case "whisper":  return "(private) " + msg.from + " → " + msg.to + ": " + msg.text;
      case "joined":   return "→ " + msg.user + " joined " + msg.room + " (" + msg.members + " here)";
      case "left":     return "← " + msg.user + " left " + msg.room;
      case "userList": return msg.users.length + " connected:\\n" + msg.users
        .map((u) => "  " + u.label + " [" + u.transport + "]" + (u.admin ? " (admin)" : "") + (u.room ? " in " + u.room : ""))
        .join("\\n");
      case "roomList": return msg.rooms
        .map((r) => "  " + r.name + " - " + r.members + " member(s), " + r.messages + " message(s)")
        .join("\\n");
      case "history":  return msg.messages.length === 0
        ? "(no history in " + msg.room + ")"
        : "--- last " + msg.messages.length + " in " + msg.room + " ---\\n" + msg.messages
            .map((m) => "  " + m.sender + ": " + m.text)
            .join("\\n");
      case "commands": return "The server understands:\\n" + msg.commands
        .map((c) => "  " + c.type.padEnd(8) + " " + c.description + "\\n           " + c.example)
        .join("\\n");
      case "kicked":   return "You were kicked by " + msg.by + ": " + msg.reason;
      case "error":    return "[error: " + msg.code + "] " + msg.message;
      default:         return "[unknown message] " + JSON.stringify(msg);
    }
  };

  const connect = () => {
    ws = new WebSocket("ws://" + location.host);

    ws.onopen = () => {
      if (state === "reconnecting") log("[reconnected]");
      state = "connected";
    };

    ws.onmessage = (event) => {
      try {
        log(render(JSON.parse(event.data)));
      } catch {
        log("[unparseable] " + event.data);
      }
    };

    ws.onclose = () => {
      if (state === "closed") return;
      state = "reconnecting";
      log("[disconnected - retrying in 2s]");
      setTimeout(connect, 2000);
    };
  };

  connect();

  document.getElementById("input").addEventListener("keydown", (event) => {
    if (event.key !== "Enter" || !event.target.value) return;
    const message = toMessage(event.target.value);
    if (message === null) {
      log("[error] unknown command. Try /help");
    } else if (state !== "connected") {
      log("[error] not connected");
    } else {
      if (message.type === "quit") state = "closed";
      ws.send(JSON.stringify(message));
    }
    event.target.value = "";
  });
</script>`;
}

// The server's own state, served over HTTP. The chat rooms and the web page are
// the same rooms - one process, three protocols.
function handleRequest(req: HttpRequest): HttpResponse {
  if (req.path === "/" && req.method === "GET") {
    return html(200, chatPage());
  }

  if (req.path === "/api/status" && req.method === "GET") {
    return json(200, {
      status: "running",
      uptime: process.uptime(),
      clients: clients.size,
      rooms: rooms.size,
    });
  }

  // The protocol, served from the protocol. CATALOG is a Record keyed by every
  // ClientMessage variant, so this endpoint cannot describe a message the server
  // does not accept, nor omit one it does.
  if (req.path === "/api/protocol" && req.method === "GET") {
    return json(200, { clientMessages: COMMANDS });
  }

  if (req.path === "/api/rooms" && req.method === "GET") {
    return json(200, [...rooms.values()].map(describeRoom));
  }

  if (req.path === "/api/history" && req.method === "GET") {
    const recent: MessageSummary[] = [...rooms.values()]
      .flatMap((room) => room.recent(10).map(summarize));
    return json(200, recent);
  }

  if (req.path === "/api/echo") {
    if (req.method !== "POST") {
      return json(405, { error: "Use POST" });
    }
    return json(200, { echo: req.body ?? "", bytes: Buffer.byteLength(req.body ?? "") });
  }

  return json(404, { error: "Not Found", path: req.path });
}

// Consume as much of the buffer as forms a complete request. Either the request
// is still arriving, or it has been answered, or it wants to become a WebSocket
// and the caller must hand the socket over.
function readHttp(conn: TcpClient): HttpOutcome {
  const buffered = conn.pending;
  const headerEnd = buffered.indexOf(HEADERS_END);
  if (headerEnd === -1) {
    return { kind: "incomplete" }; // headers still in flight
  }

  const head = buffered.subarray(0, headerEnd).toString("utf8");
  const bodyStart = headerEnd + HEADERS_END.length;

  // Peek at Content-Length before parsing properly: we may not have the body.
  const lengthHeader = /^content-length:\s*(\d+)/im.exec(head);
  const contentLength = lengthHeader?.[1] !== undefined ? parseInt(lengthHeader[1], 10) : 0;

  if (buffered.length < bodyStart + contentLength) {
    return { kind: "incomplete" }; // body still in flight
  }

  const body = contentLength > 0
    ? buffered.subarray(bodyStart, bodyStart + contentLength).toString("utf8")
    : undefined;

  const request = parseRequest(head, body);

  if (request !== null && isWebSocketUpgrade(request)) {
    // Anything after the request is the start of the WebSocket stream. It
    // belongs to `ws`, not to us.
    const leftover = buffered.subarray(bodyStart + contentLength);
    conn.consume(buffered.length);
    return { kind: "upgrade", request, head: leftover };
  }

  conn.consume(bodyStart + contentLength);

  const response = request === null ? json(400, { error: "Bad Request" }) : handleRequest(request);

  bus.emit("request", request?.method ?? "?", request?.path ?? "?", response.status);

  conn.write(serializeResponse(response));
  conn.close(); // we said Connection: close, so honour it
  return { kind: "handled" };
}

// --- Message handling ----------------------------------------------------

function fail(client: ChatClient, code: ErrorCode, message: string): void {
  client.send({ type: "error", code, message });
}

// Find a client by the name it goes by. Whisper and kick both need this, and
// both must cope with it not being there.
function findByLabel(label: string): ChatClient | undefined {
  for (const client of clients.values()) {
    if (client.label === label) {
      return client;
    }
  }
  return undefined;
}

// Show a client what it missed.
function replay(client: ChatClient, room: ChatRoom, count: number): void {
  client.send({
    type: "history",
    room: room.name,
    messages: room.recent(count).map(summarize),
  });
}

// One message from one client.
//
// This is the chapter in a single function. `message` arrives as a
// ClientMessage - already decoded, already checked - and the switch narrows it
// variant by variant, so `message.room` exists in the "join" branch and nowhere
// else. The assertNever at the bottom is the guarantee: every variant of
// ClientMessage is handled here, and the compiler has checked that claim.
function handleMessage(client: ChatClient, message: ClientMessage): void {
  switch (message.type) {
    case "help":
      client.send({ type: "commands", commands: COMMANDS });
      return;

    case "who":
      client.send({ type: "userList", users: [...clients.values()].map(describeClient) });
      return;

    case "rooms":
      client.send({ type: "roomList", rooms: [...rooms.values()].map(describeRoom) });
      return;

    case "history": {
      const current = client.room;
      const room = current !== undefined ? rooms.get(current) : undefined;
      if (room === undefined) {
        fail(client, ErrorCode.NotInRoom, `Join a room first, e.g. ${CATALOG.join.example}`);
        return;
      }
      // `limit` is optional, so it is `number | undefined` here - and the
      // compiler will not let us forget the second case.
      replay(client, room, message.limit ?? room.messageCount);
      return;
    }

    case "nick": {
      const user = knownUsers.get(message.name);
      if (user === undefined) {
        fail(
          client,
          ErrorCode.UnknownUser,
          `Unknown user "${message.name}". Try: ${[...knownUsers.keys()].join(", ")}`,
        );
        return;
      }
      client.identifyAs(user);
      const role = isAdmin(user) ? ` You are an admin (level ${user.adminLevel}).` : "";
      client.send({ type: "system", text: `You are now ${user.name}.${role}` });
      return;
    }

    case "join": {
      const room = rooms.get(message.room);
      if (room === undefined) {
        // pluck: one property out of every room, type-checked against ChatRoom.
        fail(
          client,
          ErrorCode.UnknownRoom,
          `No such room "${message.room}". Try: ${pluck([...rooms.values()], "name").join(", ")}`,
        );
        return;
      }
      const previous = client.room;
      if (previous !== undefined) {
        rooms.get(previous)?.leave(client.label);
        client.exitRoom();
        bus.emit("leave", client, previous);
      }
      room.join(client.label);
      client.enterRoom(room.name);
      client.send({ type: "joined", user: client.label, room: room.name, members: room.memberCount });
      replay(client, room, HISTORY_ON_JOIN);
      bus.emit("join", client, room.name);
      return;
    }

    case "leave": {
      const current = client.room;
      if (current === undefined) {
        fail(client, ErrorCode.NotInRoom, "You are not in a room.");
        return;
      }
      rooms.get(current)?.leave(client.label);
      client.exitRoom();
      client.send({ type: "left", user: client.label, room: current });
      bus.emit("leave", client, current);
      return;
    }

    case "chat": {
      const room = client.room;
      if (room === undefined) {
        fail(client, ErrorCode.NotInRoom, `Join a room first, e.g. ${CATALOG.join.example}`);
        return;
      }
      // Announce it. The log, the room's history, and the broadcast are all
      // listeners - handleMessage does not know or care that they exist.
      bus.emit("message", new ChatMessage(client.label, message.text, room));
      return;
    }

    case "whisper": {
      const target = findByLabel(message.to);
      if (target === undefined) {
        fail(client, ErrorCode.NoSuchTarget, `Nobody here is called "${message.to}".`);
        return;
      }
      bus.emit("whisper", client, target, message.text);
      return;
    }

    case "kick": {
      const user = client.user;
      // Two things must be true, and the type guard proves the second: you must
      // have said who you are, and who you are must be an admin.
      if (user === undefined || !isAdmin(user)) {
        fail(client, ErrorCode.NotPermitted, "Only admins may kick. Identify yourself first.");
        return;
      }
      const target = findByLabel(message.target);
      if (target === undefined) {
        fail(client, ErrorCode.NoSuchTarget, `Nobody here is called "${message.target}".`);
        return;
      }
      if (target === client) {
        fail(client, ErrorCode.NotPermitted, "You cannot kick yourself.");
        return;
      }
      bus.emit("kick", client, target, message.reason);
      return;
    }

    case "status":
      client.send({
        type: "system",
        text:
          `${client.id} [${client.transport}]: ${describeState(client.status)}. ` +
          `Connected for ${formatDuration(client.uptime)}. ` +
          `Server time ${new Date().toISOString()}.`,
      });
      return;

    case "quit":
      client.end({ type: "system", text: "Goodbye!" });
      return;

    default:
      // Unreachable, and the compiler knows it. Add a variant to ClientMessage
      // and this line is where the build breaks.
      return assertNever(message);
  }
}

// One line off a socket. Decode it, or explain why it could not be decoded.
function handleLine(client: ChatClient, line: string): void {
  const decoded = decodeClientMessage(line);
  switch (decoded.kind) {
    case "ok":
      handleMessage(client, decoded.message);
      return;
    case "invalid":
      fail(client, ErrorCode.InvalidMessage, decoded.reason);
      return;
    default:
      return assertNever(decoded);
  }
}

// Everything a client needs when it arrives, whatever transport brought it.
//
// BaseClient, not ChatClient: this is the moment a connection stops being a
// mystery and becomes a participant, and markConnected is the server's business,
// not something every ChatClient must expose.
function welcome(client: BaseClient): void {
  clients.set(client.id, client);
  client.markConnected();
  bus.emit("connect", client);
  client.send({
    type: "welcome",
    id: client.id,
    transport: client.transport,
    text: `Welcome. You are ${client.id}. Send ${CATALOG.help.example} to see what I understand.`,
  });
}

// ...and everything it needs when it leaves.
function farewell(client: ChatClient): void {
  const room = client.room;
  if (room !== undefined) {
    rooms.get(room)?.leave(client.label);
    bus.emit("leave", client, room);
  }
  clients.delete(client.id);
  bus.emit("disconnect", client, clients.size);
}

// --- WebSocket -----------------------------------------------------------

// noServer: `ws` opens no port and does no listening. It only ever receives
// sockets we have already accepted, parsed, and decided to upgrade.
const wss = new WebSocketServer({ noServer: true });

wss.on("connection", (ws: WebSocket, request: IncomingMessage) => {
  const client = new WsClient(ws, ++sequence, request.socket.remoteAddress ?? "unknown");
  welcome(client);

  // `ws` reassembles frames, so a message arrives whole: one frame, one JSON
  // object. No buffering here - that work was only ever needed because raw TCP
  // has no message boundaries.
  ws.on("message", (data: Buffer) => {
    const text = parseInput(data.toString("utf8"));
    if (text.length > 0) {
      handleLine(client, text);
    }
  });

  ws.on("close", () => {
    client.markClosed();
    farewell(client);
  });

  ws.on("error", (err: Error) => {
    bus.emit("failure", client.id, err);
  });
});

// --- Protocol detection --------------------------------------------------

// Look at the first complete line. Undefined means it has not arrived yet.
function sniff(conn: TcpClient): PeerKind | undefined {
  const newline = conn.pending.indexOf(0x0a);
  if (newline === -1) {
    return undefined;
  }
  const firstLine = conn.pending.subarray(0, newline).toString("utf8").replace(/\r$/, "");
  return HTTP_REQUEST_LINE.test(firstLine) ? "http" : "chat";
}

// --- The server ----------------------------------------------------------

// The callback runs once per connection. Everything inside it belongs to that
// one client; the event loop interleaves them all on a single thread.
const server = net.createServer((socket) => {
  const conn = new TcpClient(socket, ++sequence);

  // A browser or curl sends its request immediately, so we can read it and
  // know. A person at a terminal sends nothing until they type - so if the
  // line never comes, assume a human and greet them.
  const greeting = setTimeout(() => {
    if (conn.mode === "unknown") {
      conn.becomes("chat");
      welcome(conn);
    }
  }, GREETING_DELAY_MS);

  const onData = (chunk: Buffer): void => {
    conn.append(chunk);

    if (conn.mode === "unknown") {
      const detected = sniff(conn);
      if (detected === undefined) {
        return; // not even one line yet
      }
      clearTimeout(greeting);
      conn.becomes(detected);
      if (detected === "chat") {
        welcome(conn);
      }
    }

    if (conn.mode === "http") {
      const outcome = readHttp(conn);
      switch (outcome.kind) {
        case "incomplete":
        case "handled":
          return;

        case "upgrade": {
          // The socket stops being ours. Detach every listener before handing
          // it over, or we would keep trying to read WebSocket frames as text.
          socket.off("data", onData);
          socket.off("close", onClose);
          socket.off("error", onError);
          clearTimeout(greeting);

          // A genuine IncomingMessage, built from the request we parsed by
          // hand in Chapter 6. No cast, no lie: `ws` gets what it expects.
          const request = new IncomingMessage(socket);
          request.method = outcome.request.method;
          request.url = outcome.request.path;
          request.httpVersion = "1.1";
          request.headers = Object.fromEntries(outcome.request.headers);

          bus.emit("upgrade", conn.id);

          // ws computes Sec-WebSocket-Accept, writes the 101, and owns the
          // socket from here on.
          wss.handleUpgrade(request, socket, outcome.head, (ws) => {
            wss.emit("connection", ws, request);
          });
          return;
        }

        default:
          return assertNever(outcome);
      }
    }

    // One line, one JSON object. The framing from Chapter 5 is what makes that
    // sentence true.
    for (const line of conn.takeLines()) {
      const text = parseInput(line);
      if (text.length > 0) {
        handleLine(conn, text);
      }
    }
  };

  const onClose = (): void => {
    clearTimeout(greeting);
    conn.markClosed();
    if (conn.mode === "chat") {
      farewell(conn);
    }
  };

  // Always handle this. An unhandled socket error takes the whole process down.
  const onError = (err: Error): void => {
    bus.emit("failure", conn.id, err);
  };

  socket.on("data", onData);
  socket.on("close", onClose);
  socket.on("error", onError);
});

server.on("error", (err: NodeJS.ErrnoException) => {
  if (err.code === "EADDRINUSE") {
    console.error(`Port ${config.port} is already in use.`);
    process.exit(1);
  }
  throw err;
});

// Ctrl-C: stop accepting connections, hang up on everyone, then exit.
process.on("SIGINT", () => {
  bus.emit("notice", "Shutting down");
  for (const client of clients.values()) {
    client.end({ type: "system", text: "Server shutting down." });
  }
  server.close(() => process.exit(0));
});

server.listen(config.port, config.host, () => {
  console.log(`Chat server listening on ${address(config.host, config.port)}`);
  console.log(`Rooms: ${pluck([...rooms.values()], "name").join(", ")}`);
  console.log("");
  console.log("Clients now speak JSON - one object per line over TCP, one per frame over WebSocket:");
  console.log(`  ${CATALOG.join.example}`);
  console.log(`  ${CATALOG.chat.example}`);
  console.log("");
  console.log(`Chat:    nc ${config.host} ${config.port}`);
  console.log(`HTTP:    curl http://${address(config.host, config.port)}/api/protocol`);
  console.log(`Browser: http://${address(config.host, config.port)}/`);
  console.log(`WebSock: wscat -c ws://${address(config.host, config.port)}`);
});
