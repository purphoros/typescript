// Chat server - TCP, now speaking HTTP as well.
//
// HTTP is just text over TCP: a request line, headers, a blank line, a body.
// So the same listener can serve both protocols. We read the first line and
// decide: `GET / HTTP/1.1` is a browser or curl, anything else is a person at
// a terminal typing chat commands.
//
// That sniffing is not a party trick - it is exactly what Chapter 7 needs. A
// WebSocket connection *begins* as an HTTP request carrying `Upgrade:
// websocket`, on this very port.

import net from "node:net";

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

// One Connection wraps one TCP socket. The socket stays private: callers speak
// to the client through send()/end(), never by touching the stream directly.
//
// TCP is a byte stream, not a sequence of messages. What arrives in one "data"
// event is whatever happened to be in flight - half a line, three lines, the
// headers of a request but not its body. So bytes are buffered here until a
// whole unit is present, and only then handed on.
class Connection implements Identifiable {
  readonly id: string;
  readonly address: string;
  readonly connectedAt: Timestamp;

  private state: ConnectionState = "connecting";
  private protocol: Protocol = "unknown";
  private inbox: Buffer = Buffer.alloc(0);
  private identity?: User;
  private currentRoom?: RoomName;

  constructor(private readonly socket: net.Socket, sequence: number) {
    this.id = `c${sequence}`;
    this.address = `${socket.remoteAddress}:${socket.remotePort}`;
    this.connectedAt = Date.now();
    this.state = "connected";
  }

  get status(): ConnectionState {
    return this.state;
  }

  get mode(): Protocol {
    return this.protocol;
  }

  get user(): User | undefined {
    return this.identity;
  }

  get room(): RoomName | undefined {
    return this.currentRoom;
  }

  // Who this connection is, for logging: the chosen nick, else the socket id.
  get label(): string {
    return this.identity?.name ?? this.id;
  }

  // How long this client has been connected, in milliseconds.
  get uptime(): number {
    return Date.now() - this.connectedAt;
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

  identifyAs(user: User): void {
    this.identity = user;
  }

  enterRoom(name: RoomName): void {
    this.currentRoom = name;
  }

  exitRoom(): void {
    this.currentRoom = undefined;
  }

  // Flush what is queued, then close politely.
  end(line: string): void {
    this.send(line);
    this.socket.end();
  }

  close(): void {
    this.socket.end();
  }

  // Mark closed. The socket itself is already gone by the time this runs.
  markClosed(): void {
    this.state = "disconnected";
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

// The server's own state, served over HTTP. The chat rooms and the web page are
// the same rooms - one process, two protocols.
function handleRequest(req: HttpRequest): HttpResponse {
  if (req.path === "/" && req.method === "GET") {
    const roomRows = [...rooms.values()]
      .map((room) => `<li>${room.name} - ${room.memberCount} member(s)</li>`)
      .join("");
    return html(
      200,
      `<h1>Chat server</h1>
<p>${clients.size} chat client(s) connected.</p>
<ul>${roomRows}</ul>
<p>Talk to it: <code>nc ${CONFIG.host} ${port}</code></p>`,
    );
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

// Consume as much of the buffer as forms a complete request, answer it, hang
// up. Returns without doing anything if the request is still arriving.
function drainHttp(conn: Connection): void {
  const buffered = conn.pending;
  const headerEnd = buffered.indexOf(HEADERS_END);
  if (headerEnd === -1) {
    return; // headers still in flight
  }

  const head = buffered.subarray(0, headerEnd).toString("utf8");
  const bodyStart = headerEnd + HEADERS_END.length;

  // Peek at Content-Length before parsing properly: we may not have the body.
  const lengthHeader = /^content-length:\s*(\d+)/im.exec(head);
  const contentLength = lengthHeader?.[1] !== undefined ? parseInt(lengthHeader[1], 10) : 0;

  if (buffered.length < bodyStart + contentLength) {
    return; // body still in flight
  }

  const body = contentLength > 0
    ? buffered.subarray(bodyStart, bodyStart + contentLength).toString("utf8")
    : undefined;

  conn.consume(bodyStart + contentLength);

  const request = parseRequest(head, body);
  const response = request === null
    ? json(400, { error: "Bad Request" })
    : handleRequest(request);

  emit({
    type: "system",
    text: `${request?.method ?? "?"} ${request?.path ?? "?"} → ${response.status} ${statusLine(response.status)}`,
    at: Date.now(),
  });

  conn.write(serializeResponse(response));
  conn.close(); // we said Connection: close, so honour it
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

// Every live *chat* connection, keyed by its id. HTTP clients come and go
// within a single request and are never listed here.
const clients = new Map<string, Connection>();
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

// --- Command handling ----------------------------------------------------

// One line from one client. Returns nothing; everything it does is a side
// effect on the connection, the rooms, or the log.
function handleLine(conn: Connection, line: string): void {
  const [command, ...rest] = line.split(/\s+/);
  const argument = rest.join(" ");

  switch (command) {
    case "/help":
      conn.send("Commands:");
      for (const [name, description] of commands) {
        conn.send(`  ${name.padEnd(8)} ${description}`);
      }
      return;

    case "/who":
      conn.send(`Connected clients: ${clients.size}`);
      for (const other of clients.values()) {
        const user = other.user;
        const role = user !== undefined && isAdmin(user) ? " (admin)" : "";
        const where = other.room !== undefined ? ` in ${other.room}` : "";
        const you = other.id === conn.id ? " ← you" : "";
        conn.send(`  ${other.label}${role}${where}${you}`);
      }
      return;

    case "/rooms":
      for (const room of rooms.values()) {
        conn.send(`  ${room.name.padEnd(8)} ${room.memberCount} member(s)`);
      }
      return;

    case "/nick": {
      const user = knownUsers.get(argument);
      if (user === undefined) {
        conn.send(`Unknown user "${argument}". Try: ${[...knownUsers.keys()].join(", ")}`);
        return;
      }
      conn.identifyAs(user);
      const role = isAdmin(user) ? ` You are an admin (level ${user.adminLevel}).` : "";
      conn.send(`You are now ${user.name}.${role}`);
      return;
    }

    case "/join": {
      const room = rooms.get(argument);
      if (room === undefined) {
        conn.send(`No such room "${argument}". Try: ${[...rooms.keys()].join(", ")}`);
        return;
      }
      const previous = conn.room;
      if (previous !== undefined) {
        rooms.get(previous)?.leave(conn.label);
      }
      room.join(conn.label);
      conn.enterRoom(room.name);
      conn.send(`Joined ${room.name} (${room.memberCount} member(s)).`);
      emit({ type: "join", user: conn.label, room: room.name, at: Date.now() });
      return;
    }

    case "/leave": {
      const current = conn.room;
      if (current === undefined) {
        conn.send("You are not in a room.");
        return;
      }
      rooms.get(current)?.leave(conn.label);
      conn.exitRoom();
      conn.send(`Left ${current}.`);
      emit({ type: "leave", user: conn.label, room: current, at: Date.now() });
      return;
    }

    case "/time":
      conn.send(`Server time: ${new Date().toISOString()}`);
      return;

    case "/uptime":
      conn.send(`Connected for ${formatDuration(conn.uptime)}.`);
      return;

    case "/status":
      conn.send(`Connection ${conn.id}: ${describeState(conn.status)}`);
      return;

    case "/quit":
      conn.end("Goodbye!");
      return;

    default:
      break;
  }

  if (command !== undefined && command.startsWith("/")) {
    conn.send(`Unknown command: ${command}. Try /help.`);
    return;
  }

  // Not a command - an ordinary chat message. It is echoed to its sender for
  // now; Chapter 7 broadcasts it to everyone else in the room.
  const room = conn.room;
  if (room === undefined) {
    conn.send("Join a room first: /join general");
    return;
  }

  const message = new ChatMessage(conn.label, line, room);
  emit({ type: "message", user: message.sender, room: message.room, text: message.text, at: message.at });
  conn.send(`Echo: ${message.text}`);
}

// --- Protocol detection --------------------------------------------------

// Look at the first complete line. Undefined means it has not arrived yet.
function sniff(conn: Connection): Protocol | undefined {
  const newline = conn.pending.indexOf(0x0a);
  if (newline === -1) {
    return undefined;
  }
  const firstLine = conn.pending.subarray(0, newline).toString("utf8").replace(/\r$/, "");
  return HTTP_REQUEST_LINE.test(firstLine) ? "http" : "chat";
}

function startChat(conn: Connection): void {
  conn.becomes("chat");
  clients.set(conn.id, conn);
  conn.send(`Welcome! You are ${conn.id}. Type /help for commands.`);
}

// --- The server ----------------------------------------------------------

// The callback runs once per connection. Everything inside it belongs to that
// one client; the event loop interleaves them all on a single thread.
const server = net.createServer((socket) => {
  const conn = new Connection(socket, ++sequence);
  emit({ type: "system", text: `${conn.id} connected from ${conn.address}`, at: Date.now() });

  // A browser or curl sends its request immediately, so we can read it and
  // know. A person at a terminal sends nothing until they type - so if the
  // line never comes, assume a human and greet them.
  const greeting = setTimeout(() => {
    if (conn.mode === "unknown") {
      startChat(conn);
    }
  }, GREETING_DELAY_MS);

  socket.on("data", (chunk: Buffer) => {
    conn.append(chunk);

    if (conn.mode === "unknown") {
      const detected = sniff(conn);
      if (detected === undefined) {
        return; // not even one line yet
      }
      clearTimeout(greeting);
      if (detected === "http") {
        conn.becomes("http");
      } else {
        startChat(conn);
      }
    }

    if (conn.mode === "http") {
      drainHttp(conn);
      return;
    }

    for (const line of conn.takeLines()) {
      const text = parseInput(line);
      if (text.length > 0) {
        handleLine(conn, text);
      }
    }
  });

  socket.on("close", () => {
    clearTimeout(greeting);
    conn.markClosed();

    if (conn.mode !== "chat") {
      return; // an HTTP request, already answered and logged
    }

    const room = conn.room;
    if (room !== undefined) {
      rooms.get(room)?.leave(conn.label);
    }
    clients.delete(conn.id);
    emit({ type: "system", text: `${conn.label} disconnected (${clients.size} remaining)`, at: Date.now() });
  });

  // Always handle this. An unhandled socket error takes the whole process down.
  socket.on("error", (err: Error) => {
    emit({ type: "system", text: `${conn.id} error: ${err.message}`, at: Date.now() });
  });
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
  for (const conn of clients.values()) {
    conn.end("Server shutting down.");
  }
  server.close(() => process.exit(0));
});

const port = parsePort(process.argv[2] ?? "");
const host: Host = CONFIG.host;

server.listen(port, host, () => {
  console.log(`Chat server listening on ${address(host, port)}`);
  console.log(`Rooms: ${[...rooms.keys()].join(", ")}`);
  console.log(`Chat: nc ${host} ${port}`);
  console.log(`HTTP: curl http://${address(host, port)}/`);
});
