// Chat server - startup.
//
// Nothing here listens on a socket yet; that arrives in Chapter 5. For now the
// server parses its configuration, reports what it would do, and prints the
// command set it intends to support.

const DEFAULT_HOST = "127.0.0.1";
const DEFAULT_PORT = 8080;

// Parse a port from a string, falling back when it is missing or out of range.
function parsePort(input: string, fallback: number = DEFAULT_PORT): number {
  const parsed = parseInt(input, 10);
  if (isNaN(parsed) || parsed <= 0 || parsed > 65535) {
    return fallback;
  }
  return parsed;
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

// The port is optional: `??` supplies the default when it is null or undefined.
function address(host: string, port?: number): string {
  return `${host}:${port ?? DEFAULT_PORT}`;
}

// A connected user: name, port, isAdmin.
type User = [string, number, boolean];

// The commands the server will accept, as [command, description] pairs.
const commands: [string, string][] = [
  ["/join", "Join a chat room"],
  ["/leave", "Leave the current room"],
  ["/msg", "Send a direct message"],
  ["/help", "Show available commands"],
];

const port = parsePort("3000");
const host = DEFAULT_HOST;

console.log(`Starting chat server on ${address(host, port)}`);

const users: User[] = [
  ["alice", 49152, true],
  ["bob", 49153, false],
];

console.log(`\n${users.length} user(s) seeded:`);
for (const [userName, userPort, isAdmin] of users) {
  const role = isAdmin ? "admin" : "member";
  console.log(`  ${userName.padEnd(8)} ${address(host, userPort)}  (${role})`);
}

console.log("\nSupported commands:");
for (const [index, [cmd, description]] of commands.entries()) {
  console.log(`  [${index}] ${cmd.padEnd(8)} - ${description}`);
}

const codes: number[] = [200, 201, 204, 301, 400, 401, 403, 404, 500];
console.log("\nStatus codes understood:");
for (const code of codes) {
  console.log(`  ${code} → ${statusLine(code)}`);
}
