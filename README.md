# Chapter 03 - The Type System

Union types, narrowing, literal types, type aliases, and type guards - the tools that make TypeScript more than "JavaScript with annotations."

## Type Inference - When You Don't Need Annotations

TypeScript infers types from context. You don't need to annotate everything - the compiler figures it out from the value, the return statement, or how a variable is used:

```typescript
// Inferred from the value
const port = 8080;           // type: number (not just "number" - literally 8080, see below)
const host = "localhost";    // type: "localhost" (literal type!)
let count = 0;               // type: number (let widens the type)

// Inferred from the return statement
function double(n: number) {
  return n * 2;              // return type inferred as number
}

// Inferred from array contents
const rooms = ["general", "random"];  // type: string[]
const mixed = [1, "two", true];       // type: (string | number | boolean)[]
```

> **Tip**
>
> `const` declarations get **literal types**: `const port = 8080` has type `8080`, not `number`. `let` declarations get widened types: `let port = 8080` has type `number`. This is because `let` can be reassigned - the compiler keeps the type broad.

## Union Types and Narrowing

A **union type** says "this value can be one of several types." It's written with `|`:

```typescript
// This value can be a string or a number
type MessageId = string | number;

let id: MessageId = "abc-123";
id = 42;  // also fine

// Function that accepts multiple types
function formatId(id: string | number): string {
  // Can't call string methods directly - id might be a number!
  // id.toUpperCase(); // ERROR

  // "Narrowing" - check the type at runtime, compiler refines the type
  if (typeof id === "string") {
    return id.toUpperCase();  // OK - TypeScript knows id is string here
  } else {
    return `#${id}`;          // OK - TypeScript knows id is number here
  }
}
```

**Narrowing** is TypeScript's killer feature. When you check the type with `typeof`, `instanceof`, or a property check, the compiler refines the type inside that branch. You get autocompletion and type safety that follows your runtime logic.

> **Note**
>
> Narrowing is what makes unions usable. You declare the variants in the type, then distinguish them with an ordinary runtime check - `typeof`, `instanceof`, a property test. The compiler follows that check and refines the type inside each branch, so the safety falls out of code you would have written anyway.

## Literal Types and as const

A literal type is a type that represents a specific value, not just a category:

```typescript
// Literal types - exact values, not just categories
type Direction = "north" | "south" | "east" | "west";
type StatusCode = 200 | 404 | 500;
type Toggle = true | false;  // same as boolean, but explicit

function move(dir: Direction): void {
  console.log(`Moving ${dir}`);
}

move("north");  // OK
// move("up");  // ERROR: "up" is not assignable to Direction

// as const - makes an object/array deeply readonly with literal types
const config = {
  host: "localhost",
  port: 8080,
  rooms: ["general", "dev"],
} as const;

// config.host has type "localhost" (not string)
// config.port has type 8080 (not number)
// config.rooms has type readonly ["general", "dev"] (not string[])
// config.port = 3000;  // ERROR: Cannot assign to 'port' because it is read-only
```

> **Tip**
>
> `as const` is powerful for configuration objects and lookup tables. It gives you the narrowest possible types and prevents accidental mutation. Use it whenever you have a fixed set of values known at compile time.

## Type Aliases with type

`type` creates a name for any type - unions, objects, tuples, functions:

```typescript
// Simple alias
type Port = number;
type Host = string;

// Union alias
type MessageId = string | number;

// Object shape
type User = {
  name: string;
  port: number;
  isAdmin: boolean;
};

// Function type
type MessageHandler = (sender: string, text: string) => void;

// Tuple alias
type HostPort = [string, number];

// Using the aliases
const user: User = { name: "alice", port: 8080, isAdmin: false };
const handler: MessageHandler = (sender, text) => {
  console.log(`${sender}: ${text}`);
};
```

Type aliases are **erased at runtime** - like all TypeScript types. `type User =...` doesn't create a class or a constructor. It's just a name the compiler uses for checking. The JavaScript output has no trace of it.

## The unknown and never Types

Two special types that sit at opposite ends of the type system:

```typescript
// unknown - "I don't know what this is yet"
// You MUST narrow it before using it. Safe alternative to 'any'.
function handleInput(data: unknown): string {
  // data.toUpperCase();  // ERROR - can't use unknown directly

  if (typeof data === "string") {
    return data.toUpperCase();  // OK - narrowed to string
  }
  if (typeof data === "number") {
    return data.toString();     // OK - narrowed to number
  }
  return String(data);          // fallback
}

// never - "this can never happen"
// Used for exhaustive checks and functions that never return.
function assertNever(value: never): never {
  throw new Error(`Unexpected value: ${value}`);
}

type Command = "join" | "leave" | "msg";

function handle(cmd: Command): string {
  switch (cmd) {
    case "join": return "Joining...";
    case "leave": return "Leaving...";
    case "msg": return "Messaging...";
    default: return assertNever(cmd);  // compiler error if a case is missing
  }
}
```

> **Warning**
>
> Never use `any`. It disables all type checking - TypeScript becomes JavaScript. Use `unknown` instead and narrow it. `any` is an escape hatch that should be avoided in strict TypeScript code.

## Type Guards: typeof, instanceof, in

Type guards are runtime checks that the compiler uses to narrow types in branches:

```typescript
// typeof - for primitives (string, number, boolean)
function process(value: string | number): string {
  if (typeof value === "string") {
    return value.trim();     // string methods available
  }
  return value.toFixed(2);   // number methods available
}

// instanceof - for class instances
class ChatError extends Error {
  code: number;
  constructor(message: string, code: number) {
    super(message);
    this.code = code;
  }
}

function handleError(err: unknown): void {
  if (err instanceof ChatError) {
    console.log(`Chat error ${err.code}: ${err.message}`);
  } else if (err instanceof Error) {
    console.log(`Error: ${err.message}`);
  } else {
    console.log(`Unknown error: ${err}`);
  }
}

// "in" operator - check if a property exists on an object
type TextMessage = { type: "text"; content: string };
type ImageMessage = { type: "image"; url: string };
type Message = TextMessage | ImageMessage;

function displayMessage(msg: Message): string {
  if ("content" in msg) {
    return msg.content;  // TypeScript knows this is TextMessage
  }
  return `[Image: ${msg.url}]`;  // TypeScript knows this is ImageMessage
}

// Custom type guard - a function that returns "value is Type"
function isTextMessage(msg: Message): msg is TextMessage {
  return msg.type === "text";
}

if (isTextMessage(someMessage)) {
  console.log(someMessage.content);  // narrowed to TextMessage
}
```

## Putting It Together

This chapter is about the type system, and the server on the `chapter3` branch puts it to work. The clearest example is exhaustive narrowing over a union.

`ConnectionState` is a union of three string literals, and `describeState` switches over it. The `default` calls `assertNever`, so if you add a fourth state and forget a case, the switch stops compiling:

```typescript
function describeState(state: ConnectionState): string {
  switch (state) {
    case "connecting":   return "handshake in progress";
    case "connected":    return "ready to send and receive";
    case "disconnected": return "socket closed";
    default:             return assertNever(state);
  }
}
```

> **Tip**
>
> The complete, runnable file is `src/index.ts` on the `chapter3` branch. You are not meant to paste it wholesale - build your own as you follow along, and use the reference to check yourself.

## Exercise

1. Create a `type ConnectionState = "connecting" | "connected" | "disconnected"`. Write a function that takes a `ConnectionState` and returns a description. Use `switch` with an `assertNever` default to ensure exhaustiveness.
2. Write a function `parseInput(input: unknown): string` that safely handles string, number, boolean, null, and undefined inputs. Use `typeof` guards.
3. Create a `ChatEvent` union with "message", "join", "leave", and "system" variants. Write a `formatEvent` function that formats each type differently. Add a new variant and see what the compiler says.
4. Use `as const` on a config object. Try to modify a property and read the compiler error.
5. Write a custom type guard `isAdmin(user: User): user is AdminUser` and use it in an `if` statement.

## What's Next

You now have TypeScript's type system at your disposal - unions, narrowing, literal types, type guards, and discriminated unions. These are the tools that catch bugs at compile time.

In the next chapter, we learn **interfaces, objects, and classes** - how to define shapes for data, add methods, and build the structures our chat server needs.

---

Source: <https://purphoros.com/howto/typescript/type-system>
