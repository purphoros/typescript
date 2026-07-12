// Chat server - startup.
//
// The server still does not listen on a socket; that arrives in Chapter 5.
// What it gains here is a type system: the domain is now described with
// literal types, unions, and the ChatEvent discriminated union that the rest
// of the server will be built around.

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

type User = {
  name: UserId;
  port: Port;
  isAdmin: boolean;
};

// An admin is a User whose isAdmin is the literal `true`, not merely a boolean.
type AdminUser = {
  name: UserId;
  port: Port;
  isAdmin: true;
};

// A connection is in exactly one of these three states - nothing else.
type ConnectionState = "connecting" | "connected" | "disconnected";

// Every event the server can emit. The `type` field is the discriminant:
// switching on it tells the compiler which other fields exist.
type ChatEvent =
  | { type: "message"; user: UserId; room: RoomName; text: string; at: Timestamp }
  | { type: "join"; user: UserId; room: RoomName; at: Timestamp }
  | { type: "leave"; user: UserId; room: RoomName; at: Timestamp }
  | { type: "system"; text: string; at: Timestamp };

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

// A custom type guard. The `user is AdminUser` return type means a true result
// narrows the argument, so callers see AdminUser inside the if-branch.
function isAdmin(user: User): user is AdminUser {
  return user.isAdmin;
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

// --- Startup -------------------------------------------------------------

const port = parsePort("3000");
const host: Host = CONFIG.host;

console.log(`Starting chat server on ${address(host, port)}`);
console.log(`Rooms: ${CONFIG.rooms.join(", ")}`);

const users: User[] = [
  { name: "alice", port: 49152, isAdmin: true },
  { name: "bob", port: 49153, isAdmin: false },
];

console.log(`\n${users.length} user(s) seeded:`);
for (const user of users) {
  const role = isAdmin(user) ? "admin" : "member";
  console.log(`  ${user.name.padEnd(8)} ${address(host, user.port)}  (${role})`);
}

const states: ConnectionState[] = ["connecting", "connected", "disconnected"];
console.log("\nConnection states:");
for (const state of states) {
  console.log(`  ${state.padEnd(13)} - ${describeState(state)}`);
}

const at: Timestamp = Date.now();
const events: ChatEvent[] = [
  { type: "join", user: "alice", room: "general", at },
  { type: "message", user: "alice", room: "general", text: "Hello!", at },
  { type: "system", text: "Server restarting in 5 minutes", at },
  { type: "leave", user: "alice", room: "general", at },
];

console.log("\nEvent log:");
for (const event of events) {
  console.log(`  ${formatEvent(event)}`);
}

// Anything arriving from the network is `unknown` until it has been narrowed.
const rawInputs: unknown[] = ["  hello  ", 42, true, null, undefined, { a: 1 }];
console.log("\nRaw input, narrowed:");
for (const raw of rawInputs) {
  console.log(`  ${String(JSON.stringify(raw)).padEnd(10)} → "${parseInput(raw)}"`);
}

console.log(`\nReady. ${statusLine(200)}.`);
