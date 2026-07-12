// Chat server - startup.
//
// The server still does not listen on a socket; that arrives in Chapter 5.
// What it gains here is structure: interfaces describe the data that flows
// through the server, and classes own the state that persists - rooms,
// connections, and messages.

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
  port: Port;
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

class ChatMessage implements Serializable, Identifiable {
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

// The constructor shorthand declares, scopes, and assigns each property in one
// line. `socket` is `unknown` for now - Chapter 5 replaces it with a real one.
class Connection {
  constructor(
    public readonly id: string,
    private socket: unknown,
    protected state: ConnectionState = "connecting",
  ) {}

  send(data: string): void {
    console.log(`  [${this.id}] → ${data}`);
  }

  get status(): ConnectionState {
    return this.state;
  }

  close(): void {
    this.state = "disconnected";
    this.resetSocket();
  }

  // private: this class only.
  private resetSocket(): void {
    this.socket = null;
  }

  // protected: this class and its subclasses, but not outside callers.
  protected transitionTo(next: ConnectionState): void {
    this.state = next;
  }
}

// A subclass can reach `protected` members; outside code cannot.
class AuthenticatedConnection extends Connection {
  constructor(id: string, socket: unknown, public readonly user: User) {
    super(id, socket);
  }

  authenticate(): void {
    this.transitionTo("connected");
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

// Accepts a User; an AdminUser satisfies it structurally.
function greet(user: User): string {
  return `Hello, ${user.name}!`;
}

// --- Startup -------------------------------------------------------------

const port = parsePort("3000");
const host: Host = CONFIG.host;

console.log(`Starting chat server on ${address(host, port)}`);

// One ChatRoom instance per configured room, keyed by name.
const rooms = new Map<RoomName, ChatRoom>();
for (const name of CONFIG.rooms) {
  rooms.set(name, new ChatRoom(name));
}
console.log(`Rooms: ${[...rooms.keys()].join(", ")}`);

const alice: AdminUser = {
  id: "u1",
  name: "alice",
  port: 49152,
  joinedAt: Date.now(),
  adminLevel: 2,
  permissions: ["kick", "ban", "mute"],
};

const bob: User = {
  id: "u2",
  name: "bob",
  port: 49153,
  joinedAt: Date.now(),
};

console.log("\nUsers:");
for (const user of [alice, bob]) {
  const role = isAdmin(user) ? `admin(level ${user.adminLevel})` : "member";
  console.log(`  ${greet(user).padEnd(16)} ${address(host, user.port)}  ${role}`);
}

const general = rooms.get("general");
if (general !== undefined) {
  general.join(alice.id);
  general.join(bob.id);
  general.leave(bob.id);

  console.log(`\nRoom "${general.name}":`);
  console.log(`  members:   ${general.memberCount}`);
  console.log(`  has alice: ${general.hasMember(alice.id)}`);
  console.log(`  has bob:   ${general.hasMember(bob.id)}`);
  console.log(`  serialize: ${general.serialize()}`);
}

// A connection starts out unauthenticated, then transitions via its subclass.
const conn = new AuthenticatedConnection("c1", null, alice);
console.log(`\nConnection ${conn.id}: ${describeState(conn.status)}`);
conn.authenticate();
console.log(`Connection ${conn.id}: ${describeState(conn.status)}`);
conn.send("welcome");
conn.close();
console.log(`Connection ${conn.id}: ${describeState(conn.status)}`);

const message = new ChatMessage(alice.id, parseInput("  Hello!  "), "general");
console.log(`\nMessage: ${message.serialize()}`);

const events: ChatEvent[] = [
  { type: "join", user: alice.name, room: "general", at: message.at },
  { type: "message", user: alice.name, room: "general", text: message.text, at: message.at },
  { type: "system", text: "Server restarting in 5 minutes", at: message.at },
  { type: "leave", user: alice.name, room: "general", at: message.at },
];

console.log("\nEvent log:");
for (const event of events) {
  console.log(`  ${formatEvent(event)}`);
}

console.log(`\nReady. ${statusLine(200)}.`);
