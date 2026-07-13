// Chat server - TCP, HTTP, and now WebSocket, all on one port.
//
// Chapter 6 ended with a promise: a WebSocket connection *begins* as an HTTP
// request carrying `Upgrade: websocket`. This chapter collects on it. The same
// listener still sniffs the first line, and now there are three outcomes:
//
//   GET / HTTP/1.1 ...                      → serve HTML or JSON, hang up
//   GET / HTTP/1.1 ... Upgrade: websocket   → 101, hand the socket to `ws`
//   anything else                           → a person typing chat commands
//
// So `ws` runs in noServer mode: it never opens a port of its own. We do the
// listening, we parse the request, and we hand over the raw socket.
//
// The payoff is broadcasting. A message typed into `nc` reaches a browser, and
// a message from the browser reaches `nc` - the two transports meet in a room.

import net from "node:net";
import { IncomingMessage } from "node:http";
import { WebSocketServer, WebSocket } from "ws";

// --- Configuration -------------------------------------------------------

// `as const` gives every field its literal type and makes the object readonly:
// CONFIG.port has type 8080, not number, and cannot be reassigned.
const CONFIG = {
  host: "127.0.0.1",
  port: 8080,
  rooms: ["general", "random", "dev"],
} as const;

// A client that connects and says nothing is assumed to be a human at a
// terminal, and gets greeted. curl and browsers send their request at once.
const GREETING_DELAY_MS = 200;

// --- Domain types --------------------------------------------------------

type Host = string;
type Port = number;
type UserId = string;
type RoomName = string;
type Timestamp = number;

// A connection is in exactly one of these three states - nothing else.
type ConnectionState = "connecting" | "connected" | "disconnected";

// What the peer turned out to be. "unknown" until the first line arrives.
type Protocol = "unknown" | "chat" | "http";

// How a client is attached. Used only for display - the chat logic does not
// care, which is the whole point of the ChatClient interface below.
type Transport = "tcp" | "ws";

// Interfaces describe shape. `type` stays for unions, which interfaces cannot express.
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

// Anyone the server can talk to, however they got here. handleLine() and
// broadcast() work in terms of this and nothing else, so a telnet user and a
// browser tab are interchangeable to them.
interface ChatClient extends Identifiable {
  readonly transport: Transport;
  readonly connectedAt: Timestamp;
  readonly label: string;
  readonly uptime: number;
  readonly status: ConnectionState;
  readonly user: User | undefined;
  readonly room: RoomName | undefined;
  send(line: string): void;
  end(line: string): void;
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

// The reason phrase is not stored: it is derived from the status code by
// statusLine(), so the two can never disagree.
interface HttpResponse {
  status: number;
  headers: Record<string, string>;
  body: string;
}

// What reading the buffer produced. A discriminated union again: the caller
// switches on `kind` and the compiler hands it exactly the right fields.
type HttpOutcome =
  | { kind: "incomplete" }                                       // still arriving
  | { kind: "handled" }                                          // answered, closing
  | { kind: "upgrade"; request: HttpRequest; head: Buffer };     // hand off to ws

// Every event the server can emit. The `type` field is the discriminant:
// switching on it tells the compiler which other fields exist.
type ChatEvent =
  | { type: "message"; user: UserId; room: RoomName; text: string; at: Timestamp }
  | { type: "join"; user: UserId; room: RoomName; at: Timestamp }
  | { type: "leave"; user: UserId; room: RoomName; at: Timestamp }
  | { type: "system"; text: string; at: Timestamp };

// --- Classes -------------------------------------------------------------

// State plus behaviour: a room owns its membership and decides who may see it.
class ChatRoom implements Serializable, Identifiable {
  readonly id: string;
  readonly createdAt: Timestamp;
  private members: Set<UserId> = new Set();

  constructor(public readonly name: RoomName) {
    this.id = crypto.randomUUID();
    this.createdAt = Date.now();
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

  // A getter exposes derived state without exposing the Set itself.
  get memberCount(): number {
    return this.members.size;
  }

  get memberList(): UserId[] {
    return [...this.members];
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
  protected state: ConnectionState = "connected";
  protected identity?: User;
  protected currentRoom?: RoomName;

  constructor(readonly id: string, readonly transport: Transport) {}

  abstract send(line: string): void;
  abstract end(line: string): void;

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

  markClosed(): void {
    this.state = "disconnected";
  }
}

// A raw TCP client: telnet, nc, a person at a terminal.
//
// TCP is a byte stream, not a sequence of messages. What arrives in one "data"
// event is whatever happened to be in flight - half a line, three lines, the
// headers of a request but not its body. So bytes are buffered here until a
// whole unit is present, and only then handed on.
class TcpClient extends BaseClient {
  readonly address: string;

  private protocol: Protocol = "unknown";
  private inbox: Buffer = Buffer.alloc(0);

  constructor(private readonly socket: net.Socket, sequence: number) {
    super(`c${sequence}`, "tcp");
    this.address = `${socket.remoteAddress}:${socket.remotePort}`;
  }

  get mode(): Protocol {
    return this.protocol;
  }

  // Bytes received but not yet consumed.
  get pending(): Buffer {
    return this.inbox;
  }

  becomes(protocol: Protocol): void {
    this.protocol = protocol;
  }

  append(chunk: Buffer): void {
    this.inbox = Buffer.concat([this.inbox, chunk]);
  }

  // Drop the first `count` bytes - they have been dealt with.
  consume(count: number): void {
    this.inbox = this.inbox.subarray(count);
  }

  // Every *complete* line in the buffer. A trailing partial line stays put
  // until the rest of it arrives.
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

  send(line: string): void {
    this.socket.write(`${line}\n`);
  }

  // Raw write: HTTP builds its own bytes, newlines and all.
  write(raw: string): void {
    this.socket.write(raw);
  }

  end(line: string): void {
    this.send(line);
    this.socket.end();
  }

  close(): void {
    this.socket.end();
  }
}

// A WebSocket client: a browser tab, or wscat. `ws` has already done the
// framing, so a message arrives whole - no buffering, no newline hunting.
class WsClient extends BaseClient {
  constructor(
    private readonly ws: WebSocket,
    sequence: number,
    readonly address: string,
  ) {
    super(`w${sequence}`, "ws");
  }

  // A client may be mid-disconnect: sending to a closing socket throws.
  send(line: string): void {
    if (this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(line);
    }
  }

  end(line: string): void {
    this.send(line);
    this.ws.close();
  }
}

// --- Exhaustiveness ------------------------------------------------------

// Reaching this is impossible once every variant is handled, so `value` narrows
// to `never`. Add a ChatEvent variant and forget a switch case, and the call
// below stops compiling - the compiler finds the gap for us.
function assertNever(value: never): never {
  throw new Error(`Unexpected value: ${String(value)}`);
}

// --- Functions -----------------------------------------------------------

// Parse a port from a string, falling back when it is missing or out of range.
function parsePort(input: string, fallback: Port = CONFIG.port): Port {
  const parsed = parseInt(input, 10);
  if (isNaN(parsed) || parsed <= 0 || parsed > 65535) {
    return fallback;
  }
  return parsed;
}

// The port is optional: `??` supplies the default when it is null or undefined.
function address(host: Host, port?: Port): string {
  return `${host}:${port ?? CONFIG.port}`;
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

function describeState(state: ConnectionState): string {
  switch (state) {
    case "connecting":   return "handshake in progress";
    case "connected":    return "ready to send and receive";
    case "disconnected": return "socket closed";
    default:             return assertNever(state);
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

// Narrowing by discriminant: each branch sees only that variant's fields.
function formatEvent(event: ChatEvent): string {
  switch (event.type) {
    case "message": return `[${event.room}] ${event.user}: ${event.text}`;
    case "join":    return `→ ${event.user} joined ${event.room}`;
    case "leave":   return `← ${event.user} left ${event.room}`;
    case "system":  return `[SYSTEM] ${event.text}`;
    default:        return assertNever(event);
  }
}

// The server's log. Every state change goes through here.
function emit(event: ChatEvent): void {
  console.log(formatEvent(event));
}

function formatDuration(ms: number): string {
  const seconds = Math.floor(ms / 1000);
  const minutes = Math.floor(seconds / 60);
  return minutes > 0 ? `${minutes}m ${seconds % 60}s` : `${seconds}s`;
}

// --- HTTP ----------------------------------------------------------------

// `GET /path HTTP/1.1` - the shape of an HTTP request's first line. Anything
// else on the wire is a chat client.
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
function chatPage(): string {
  return `<!doctype html>
<meta charset="utf-8">
<title>Chat</title>
<h1>Chat server</h1>
<p>${clients.size} client(s) connected across ${rooms.size} rooms.</p>
<div id="log" style="font-family:monospace;white-space:pre-wrap"></div>
<input id="input" style="width:30em" placeholder="/join general" autofocus>
<script>
  const ws = new WebSocket("ws://" + location.host);
  const log = (line) => {
    document.getElementById("log").textContent += line + "\\n";
  };
  ws.onmessage = (event) => log(event.data);
  ws.onclose = () => log("[disconnected]");
  document.getElementById("input").addEventListener("keydown", (event) => {
    if (event.key === "Enter" && event.target.value) {
      ws.send(event.target.value);
      event.target.value = "";
    }
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

  if (req.path === "/api/rooms" && req.method === "GET") {
    return json(200, [...rooms.values()].map((room) => ({
      name: room.name,
      members: room.memberList,
      memberCount: room.memberCount,
    })));
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

  emit({
    type: "system",
    text: `${request?.method ?? "?"} ${request?.path ?? "?"} → ${response.status} ${statusLine(response.status)}`,
    at: Date.now(),
  });

  conn.write(serializeResponse(response));
  conn.close(); // we said Connection: close, so honour it
  return { kind: "handled" };
}

// --- Server state --------------------------------------------------------

const rooms = new Map<RoomName, ChatRoom>();
for (const name of CONFIG.rooms) {
  rooms.set(name, new ChatRoom(name));
}

// Users the server already knows about. Chapter 17 replaces this with real
// authentication; for now /nick simply claims an identity.
const knownUsers = new Map<string, User | AdminUser>([
  ["alice", { id: "u1", name: "alice", joinedAt: Date.now(), adminLevel: 2, permissions: ["kick", "ban", "mute"] }],
  ["bob", { id: "u2", name: "bob", joinedAt: Date.now() }],
]);

// Every live chat client, TCP or WebSocket alike. HTTP requests come and go
// within a single exchange and are never listed here.
const clients = new Map<string, ChatClient>();
let sequence = 0;

const commands: [string, string][] = [
  ["/help", "Show available commands"],
  ["/who", "List connected clients"],
  ["/rooms", "List rooms and their member counts"],
  ["/nick", "Identify yourself: /nick alice"],
  ["/join", "Join a room: /join general"],
  ["/leave", "Leave the current room"],
  ["/time", "Show the server time"],
  ["/uptime", "Show how long you have been connected"],
  ["/quit", "Disconnect"],
];

// --- Broadcast -----------------------------------------------------------

// Send to everyone in a room, optionally skipping one client (usually the
// sender). Transport is irrelevant here: a line typed into nc lands in a
// browser, and vice versa, because both are just ChatClients.
function broadcast(room: RoomName, line: string, except?: ChatClient): void {
  for (const client of clients.values()) {
    if (client.room === room && client !== except) {
      client.send(line);
    }
  }
}

// --- Command handling ----------------------------------------------------

// One line from one client. Returns nothing; everything it does is a side
// effect on the client, the rooms, or the log.
function handleLine(client: ChatClient, line: string): void {
  const [command, ...rest] = line.split(/\s+/);
  const argument = rest.join(" ");

  switch (command) {
    case "/help":
      client.send("Commands:");
      for (const [name, description] of commands) {
        client.send(`  ${name.padEnd(8)} ${description}`);
      }
      return;

    case "/who":
      client.send(`Connected clients: ${clients.size}`);
      for (const other of clients.values()) {
        const user = other.user;
        const role = user !== undefined && isAdmin(user) ? " (admin)" : "";
        const where = other.room !== undefined ? ` in ${other.room}` : "";
        const you = other.id === client.id ? " ← you" : "";
        client.send(`  ${other.label} [${other.transport}]${role}${where}${you}`);
      }
      return;

    case "/rooms":
      for (const room of rooms.values()) {
        client.send(`  ${room.name.padEnd(8)} ${room.memberCount} member(s)`);
      }
      return;

    case "/nick": {
      const user = knownUsers.get(argument);
      if (user === undefined) {
        client.send(`Unknown user "${argument}". Try: ${[...knownUsers.keys()].join(", ")}`);
        return;
      }
      client.identifyAs(user);
      const role = isAdmin(user) ? ` You are an admin (level ${user.adminLevel}).` : "";
      client.send(`You are now ${user.name}.${role}`);
      return;
    }

    case "/join": {
      const room = rooms.get(argument);
      if (room === undefined) {
        client.send(`No such room "${argument}". Try: ${[...rooms.keys()].join(", ")}`);
        return;
      }
      const previous = client.room;
      if (previous !== undefined) {
        rooms.get(previous)?.leave(client.label);
        broadcast(previous, `← ${client.label} left`, client);
        client.exitRoom();
      }
      room.join(client.label);
      client.enterRoom(room.name);
      client.send(`Joined ${room.name} (${room.memberCount} member(s)).`);
      broadcast(room.name, `→ ${client.label} joined`, client);
      emit({ type: "join", user: client.label, room: room.name, at: Date.now() });
      return;
    }

    case "/leave": {
      const current = client.room;
      if (current === undefined) {
        client.send("You are not in a room.");
        return;
      }
      rooms.get(current)?.leave(client.label);
      client.exitRoom();
      client.send(`Left ${current}.`);
      broadcast(current, `← ${client.label} left`, client);
      emit({ type: "leave", user: client.label, room: current, at: Date.now() });
      return;
    }

    case "/time":
      client.send(`Server time: ${new Date().toISOString()}`);
      return;

    case "/uptime":
      client.send(`Connected for ${formatDuration(client.uptime)}.`);
      return;

    case "/status":
      client.send(`Client ${client.id} [${client.transport}]: ${describeState(client.status)}`);
      return;

    case "/quit":
      client.end("Goodbye!");
      return;

    default:
      break;
  }

  if (command !== undefined && command.startsWith("/")) {
    client.send(`Unknown command: ${command}. Try /help.`);
    return;
  }

  // Not a command - a chat message. It now reaches the whole room, whichever
  // transport each member happens to be using.
  const room = client.room;
  if (room === undefined) {
    client.send("Join a room first: /join general");
    return;
  }

  const message = new ChatMessage(client.label, line, room);
  emit({ type: "message", user: message.sender, room: message.room, text: message.text, at: message.at });
  broadcast(room, `[${message.sender}] ${message.text}`);
}

// Everything a client needs when it arrives, whatever transport brought it.
function welcome(client: ChatClient): void {
  clients.set(client.id, client);
  emit({ type: "system", text: `${client.id} connected [${client.transport}]`, at: Date.now() });
  client.send(`Welcome! You are ${client.id}. Type /help for commands.`);
}

// ...and everything it needs when it leaves.
function farewell(client: ChatClient): void {
  const room = client.room;
  if (room !== undefined) {
    rooms.get(room)?.leave(client.label);
    broadcast(room, `← ${client.label} left`, client);
  }
  clients.delete(client.id);
  emit({
    type: "system",
    text: `${client.label} disconnected (${clients.size} remaining)`,
    at: Date.now(),
  });
}

// --- WebSocket -----------------------------------------------------------

// noServer: `ws` opens no port and does no listening. It only ever receives
// sockets we have already accepted, parsed, and decided to upgrade.
const wss = new WebSocketServer({ noServer: true });

wss.on("connection", (ws: WebSocket, request: IncomingMessage) => {
  const client = new WsClient(ws, ++sequence, request.socket.remoteAddress ?? "unknown");
  welcome(client);

  // `ws` reassembles frames, so a message arrives whole. No buffering here -
  // that work was only ever needed because raw TCP has no message boundaries.
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
    emit({ type: "system", text: `${client.id} error: ${err.message}`, at: Date.now() });
  });
});

// --- Protocol detection --------------------------------------------------

// Look at the first complete line. Undefined means it has not arrived yet.
function sniff(conn: TcpClient): Protocol | undefined {
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

          emit({
            type: "system",
            text: `${conn.id} upgrading to WebSocket → 101 ${statusLine(101)}`,
            at: Date.now(),
          });

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
    emit({ type: "system", text: `${conn.id} error: ${err.message}`, at: Date.now() });
  };

  socket.on("data", onData);
  socket.on("close", onClose);
  socket.on("error", onError);
});

server.on("error", (err: NodeJS.ErrnoException) => {
  if (err.code === "EADDRINUSE") {
    console.error(`Port ${port} is already in use.`);
    process.exit(1);
  }
  throw err;
});

// Ctrl-C: stop accepting connections, hang up on everyone, then exit.
process.on("SIGINT", () => {
  emit({ type: "system", text: "Shutting down", at: Date.now() });
  for (const client of clients.values()) {
    client.end("Server shutting down.");
  }
  server.close(() => process.exit(0));
});

const port = parsePort(process.argv[2] ?? "");
const host: Host = CONFIG.host;

server.listen(port, host, () => {
  console.log(`Chat server listening on ${address(host, port)}`);
  console.log(`Rooms: ${[...rooms.keys()].join(", ")}`);
  console.log(`Chat:    nc ${host} ${port}`);
  console.log(`HTTP:    curl http://${address(host, port)}/`);
  console.log(`Browser: http://${address(host, port)}/`);
  console.log(`WebSock: wscat -c ws://${address(host, port)}`);
});
