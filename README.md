# Chapter 02 - TypeScript Fundamentals

Variables, types, functions, arrays, tuples, and control flow - the core language you need before writing any real code.

## Variables: let, const, and Type Annotations

TypeScript has three ways to declare variables: `const`, `let`, and `var`. Forget `var` exists - it has scoping bugs from JavaScript's early days. Use `const` by default, `let` only when you need reassignment.

```typescript
// const - the binding cannot be reassigned
const port: number = 8080;
// port = 3000; // ERROR: Cannot assign to 'port' because it is a constant

// let - the binding can be reassigned
let connectionCount: number = 0;
connectionCount += 1; // fine

// Type annotations are optional when the type can be inferred
const host = "127.0.0.1";      // inferred as string
let isRunning = true;           // inferred as boolean
const maxClients = 100;         // inferred as number
```

> **Tip**
>
> Prefer `const` everywhere. Only use `let` when you actually need to reassign the variable. This makes your code easier to reason about - if you see `const`, you know the value never changes.

## Primitive Types

TypeScript has seven primitive types. `number` is a single type - no widths, no signedness, nothing to choose between - with one exception: `bigint`, for integers too large for `number` to hold exactly.

```typescript
// string - text
const username: string = "alice";
const greeting: string = `Hello, ${username}!`;  // template literal

// number - all numbers (integer and float, always 64-bit)
const port: number = 8080;
const pi: number = 3.14159;
const negative: number = -42;

// boolean - true or false
const isConnected: boolean = true;
const isAdmin: boolean = false;

// null - explicitly empty ("I know this is nothing")
const noValue: null = null;

// undefined - not yet assigned ("this hasn't been set")
let uninitialized: undefined = undefined;

// symbol - unique identifier (rarely used directly)
const id: symbol = Symbol("connection-id");

// bigint - integers beyond number's safe range (note the n suffix)
const huge: bigint = 9007199254740993n;
```

> **Note**
>
> `null` vs `undefined`: use `null` when you explicitly want "no value." Use `undefined` for "not yet set." In practice, most TypeScript code uses `undefined` (it's what you get when a property is missing). With `strict: true`, the compiler forces you to handle both.

## Arrays and Tuples

Arrays hold multiple values of the same type. Tuples hold a fixed number of values with specific types at each position.

```typescript
// Arrays - all elements must be the same type
const rooms: string[] = ["general", "random", "dev"];
const codes: number[] = [200, 404, 500];
const flags: Array<boolean> = [true, false, true]; // alternate syntax

// Array methods
rooms.push("help");           // add to end
const first = rooms[0];       // access by index: "general"
const count = rooms.length;   // 4
rooms.includes("dev");        // true

// Tuples - fixed length, typed at each position
const entry: [string, number] = ["alice", 8080];
const name = entry[0];  // string
const port = entry[1];  // number
// entry[2];            // ERROR: Tuple type has no element at index '2'

// Tuples are useful for functions that return multiple values
function parseAddress(addr: string): [string, number] {
  const parts = addr.split(":");
  return [parts[0], parseInt(parts[1], 10)];
}

const [host, portNum] = parseAddress("127.0.0.1:8080");
// Destructuring: host = "127.0.0.1", portNum = 8080
```

> **Tip**
>
> Destructuring (`const [host, port] =...`) unpacks arrays and tuples into individual variables. It's used everywhere in TypeScript - function returns, imports, event handlers.

## Functions, Parameter Types, and Return Types

Functions in TypeScript require parameter type annotations. Return types can be inferred but are good practice to annotate explicitly.

```typescript
// Named function with explicit types
function formatMessage(sender: string, text: string): string {
  return `[${sender}]: ${text}`;
}

// Arrow function - the preferred syntax for short functions
const add = (a: number, b: number): number => a + b;

// Arrow function with block body
const greet = (name: string): string => {
  const greeting = `Welcome to the chat, ${name}!`;
  return greeting;
};

// Optional parameters - marked with ?
function connect(host: string, port: number, timeout?: number): void {
  const t = timeout ?? 5000;  // ?? is "nullish coalescing" - use right if left is null/undefined
  console.log(`Connecting to ${host}:${port} (timeout: ${t}ms)`);
}

connect("localhost", 8080);        // timeout is undefined, defaults to 5000
connect("localhost", 8080, 3000);  // timeout is 3000

// Default parameters
function createRoom(name: string, maxUsers: number = 50): void {
  console.log(`Room "${name}" created (max: ${maxUsers})`);
}

createRoom("general");       // maxUsers = 50
createRoom("vip", 10);       // maxUsers = 10

// void - function returns nothing
function logMessage(msg: string): void {
  console.log(msg);
}
```

### Arrow Functions vs Named Functions

Arrow functions (`const fn = () =>...`) and named functions (`function fn()...`) are almost identical. The main difference: arrow functions capture `this` from their enclosing scope (important for callbacks and event handlers, which we'll use heavily in the chat server). Prefer arrow functions for short expressions and callbacks.

## Control Flow

### if / else

```typescript
const status = 404;

if (status === 200) {
  console.log("OK");
} else if (status === 404) {
  console.log("Not Found");
} else {
  console.log(`Status: ${status}`);
}

// Ternary - inline if/else for expressions
const statusText = status === 200 ? "OK" : "Error";
```

> **Warning**
>
> Always use `===` (strict equality), never `==` (loose equality). `==` does type coercion: `0 == ""` is `true`, `0 === ""` is `false`. The strict version compares both value and type.

### for loops

```typescript
const rooms = ["general", "random", "dev"];

// for...of - iterate over values (preferred)
for (const room of rooms) {
  console.log(`Room: ${room}`);
}

// for...of with index using entries()
for (const [index, room] of rooms.entries()) {
  console.log(`[${index}] ${room}`);
}

// Classic for loop (when you need the index directly)
for (let i = 0; i < rooms.length; i++) {
  console.log(`Room ${i}: ${rooms[i]}`);
}

// while
let attempts = 0;
while (attempts < 3) {
  console.log(`Attempt ${attempts + 1}`);
  attempts++;
}
```

### switch

`switch` compares a value against a list of cases and runs the first that matches:

```typescript
function handleCommand(command: string): string {
  switch (command) {
    case "/join":
      return "Joining room...";
    case "/leave":
      return "Leaving room...";
    case "/help":
      return "Available commands: /join, /leave, /msg, /help";
    case "/msg":
      return "Sending message...";
    default:
      return `Unknown command: ${command}`;
  }
}
```

> **Note**
>
> A `switch` does not enforce exhaustiveness by default: forget a case and the compiler stays silent. In Chapter 9 we'll use discriminated unions, which do force every case to be handled - a missing one becomes a compile error.

## Putting It Together

Let's update our chat server's entry point to use everything from this chapter:

`src/index.ts`

```typescript
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
```

## Exercise

1. Add a `reasonPhrase` function that takes a `number` and returns a `string` for HTTP status codes. Use a `switch` statement. Add codes 201, 204, 301, 403.
2. Create a tuple type `[string, number, boolean]` representing a user: name, port, isAdmin. Destructure it into individual variables.
3. Write a function with an optional parameter: `connect(host: string, port?: number)`. Default the port to 8080 using `??`.
4. Use `for...of` with `.entries()` to print each command with its index: `[0] /join`, `[1] /leave`, etc.
5. Try using `==` instead of `===` somewhere. Does TypeScript warn you? (Hint: enable the ESLint rule `eqeqeq` to catch this.)

## What's Next

You now know how to declare variables, choose types, write functions, and control program flow. These are the basic building blocks for everything that follows.

In the next chapter, we dive into TypeScript's **type system** - union types, narrowing, type guards, and the tools that make TypeScript more than just "JavaScript with annotations."

---

Source: <https://purphoros.com/howto/typescript/fundamentals>
