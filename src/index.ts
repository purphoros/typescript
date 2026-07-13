// Chat server - a real TCP server.
//
// Chapters 1-4 built the vocabulary: types for the domain, interfaces for the
// data, classes for the state. This chapter gives it a socket. `net` accepts
// connections, the event loop interleaves them, and a single thread serves
// every client at once.
//
// Messages are still echoed back to their sender - broadcasting to a room is
// Chapter 16.

import net from "node:net";

// --- Configuration -------------------------------------------------------

// `as const` gives every field its literal type and makes the object readonly:
// CONFIG.port has type 8080, not number, and cannot be reassigned.
const CONFIG = {
  host: "127.0.0.1",
  port: 8080,
  rooms: ["general", "random", "dev"],
} as const;

// --- Domain types --------------------------------------------------------

type Host = string;
type Port = number;
type UserId = string;
type RoomName = string;
type Timestamp = number;

// A connection is in exactly one of these three states - nothing else.
type ConnectionState = "connecting" | "connected" | "disconnected";

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
class Connection implements Identifiable {
  readonly id: string;
  readonly address: string;
  readonly connectedAt: Timestamp;

  private state: ConnectionState = "connecting";
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

  send(line: string): void {
    this.socket.write(`${line}\n`);
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

// The reason phrase for an HTTP status code. The chat server speaks HTTP before
// it upgrades to a WebSocket (Chapter 7), so it needs these.
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

// Every live connection, keyed by its id. The Map is the server's client list.
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

// --- The server ----------------------------------------------------------

// The callback runs once per connection. Everything inside it belongs to that
// one client; the event loop interleaves them all on a single thread.
const server = net.createServer((socket) => {
  const conn = new Connection(socket, ++sequence);
  clients.set(conn.id, conn);

  emit({ type: "system", text: `${conn.id} connected from ${conn.address}`, at: Date.now() });
  conn.send(`Welcome! You are ${conn.id}. Type /help for commands.`);

  // `data` is a Buffer - raw bytes. A single chunk may hold several lines, or
  // half of one; splitting on newline is enough until Chapter 15 does framing.
  socket.on("data", (data: Buffer) => {
    for (const raw of data.toString().split("\n")) {
      const line = parseInput(raw);
      if (line.length > 0) {
        handleLine(conn, line);
      }
    }
  });

  socket.on("close", () => {
    const room = conn.room;
    if (room !== undefined) {
      rooms.get(room)?.leave(conn.label);
    }
    conn.markClosed();
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
  console.log(`Connect with: nc ${host} ${port}`);
});
