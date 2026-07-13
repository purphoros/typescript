# Chapter 08 - Generics

Write code that works with many types while keeping full type safety. Generics are TypeScript's most powerful tool for building reusable libraries and data structures.

## Generic Functions

A generic function uses a **type parameter** - a placeholder that gets filled in when you call the function:

```typescript
// <T> is a type parameter - a placeholder for any type
function identity<T>(value: T): T {
  return value;
}

// TypeScript infers T from the argument
const num = identity(42);        // T = number, returns number
const str = identity("hello");   // T = string, returns string

// Or specify T explicitly
const bool = identity<boolean>(true);

// Practical: first element of any array
function first<T>(items: T[]): T | undefined {
  return items[0];
}

const room = first(["general", "random"]);  // string | undefined
const code = first([200, 404, 500]);         // number | undefined
```

> **Tip**
>
> Generics are like function parameters but for types. Just as `function add(a: number, b: number)` parameterizes values, `function first<T>(items: T[]): T` parameterizes the type. The caller provides the type (or TypeScript infers it).

## Generic Interfaces

```typescript
// A Result type - success or failure with typed data
interface Result<T, E = string> {
  ok: boolean;
  data?: T;
  error?: E;
}

// Usage - T is filled in at the call site
const success: Result<number> = { ok: true, data: 42 };
const failure: Result<number> = { ok: false, error: "not found" };

// A cache with typed values
interface Cache<V> {
  get(key: string): V | undefined;
  set(key: string, value: V): void;
  has(key: string): boolean;
  delete(key: string): boolean;
  size: number;
}
```

## Constraints with extends

`extends` limits what types can be used for a type parameter - the generic equivalent of "must have these properties":

```typescript
// T must have a .length property
function longest<T extends { length: number }>(a: T, b: T): T {
  return a.length >= b.length ? a : b;
}

longest("hello", "hi");       // string has .length ✓
longest([1, 2], [1, 2, 3]);   // array has .length ✓
// longest(10, 20);            // number has no .length ✗

// T must have an id property
interface HasId {
  id: string;
}

function findById<T extends HasId>(items: T[], id: string): T | undefined {
  return items.find(item => item.id === id);
}

// keyof - constrain to valid property names
function getProperty<T, K extends keyof T>(obj: T, key: K): T[K] {
  return obj[key];
}

const user = { name: "alice", age: 30 };
getProperty(user, "name");  // string
getProperty(user, "age");   // number
// getProperty(user, "foo"); // ERROR: "foo" is not in keyof typeof user
```

> **Note**
>
> `keyof T` produces a union of all property names of T. For `{ name: string; age: number }`, `keyof T` is `"name" | "age"`. Combined with generics, it ensures you can only access properties that actually exist.

## Generic Classes

```typescript
class TypedMap<K, V> {
  private data = new Map<K, V>();

  set(key: K, value: V): void {
    this.data.set(key, value);
  }

  get(key: K): V | undefined {
    return this.data.get(key);
  }

  get size(): number {
    return this.data.size;
  }
}

// Type-safe: keys are strings, values are numbers
const scores = new TypedMap<string, number>();
scores.set("alice", 100);
scores.set("bob", 85);
// scores.set(42, "wrong"); // ERROR: number not assignable to string
```

## Utility Types

TypeScript has built-in generic types for common transformations:

```typescript
interface User {
  id: string;
  name: string;
  email: string;
  isAdmin: boolean;
}

// Partial<T> - all properties become optional
type UserUpdate = Partial<User>;
// { id?: string; name?: string; email?: string; isAdmin?: boolean }

// Required<T> - all properties become required
type StrictUser = Required<UserUpdate>;

// Pick<T, K> - select specific properties
type UserPreview = Pick<User, "id" | "name">;
// { id: string; name: string }

// Omit<T, K> - remove specific properties
type UserWithoutEmail = Omit<User, "email">;
// { id: string; name: string; isAdmin: boolean }

// Record<K, V> - object with known keys and typed values
type RoomMap = Record<string, string[]>;
// { [key: string]: string[] }

// Readonly<T> - all properties become readonly
type FrozenUser = Readonly<User>;
```

| Utility | What it does | Use case |
|---|---|---|
| Partial<T> | All properties optional | Update/patch operations |
| Required<T> | All properties required | Ensure complete data |
| Pick<T, K> | Select properties | API responses, previews |
| Omit<T, K> | Remove properties | Hide sensitive fields |
| Record<K, V> | Object with typed keys/values | Lookup tables, maps |
| Readonly<T> | All properties readonly | Immutable config |

## Applying Generics: A Typed Event Emitter

Node.js's `EventEmitter` is untyped - you can emit any event name with any data. Let's build a type-safe version using generics:

A first attempt, and the one you will find in most tutorials. It is *not* `src/events.ts` on this branch - read the Note underneath it, and then the real listing at the end. This version reaches for `any` twice, and Chapter 3 was right about that.

```typescript
// The event map defines: event name → handler signature.
// This MUST be a `type`, not an `interface` - see the warning below.
type ChatEvents = {
  message: (sender: string, text: string) => void;
  join: (user: string, room: string) => void;
  leave: (user: string, room: string) => void;
  error: (error: Error) => void;
};

// Generic typed emitter - T is the event map
class TypedEmitter<T extends Record<string, (...args: any[]) => void>> {
  private handlers = new Map<keyof T, Set<Function>>();

  on<K extends keyof T>(event: K, handler: T[K]): void {
    if (!this.handlers.has(event)) {
      this.handlers.set(event, new Set());
    }
    this.handlers.get(event)!.add(handler);
  }

  emit<K extends keyof T>(event: K, ...args: Parameters<T[K]>): void {
    const handlers = this.handlers.get(event);
    if (handlers) {
      for (const handler of handlers) {
        (handler as Function)(...args);
      }
    }
  }
}

// Usage - fully type-safe
const chat = new TypedEmitter<ChatEvents>();

chat.on("message", (sender, text) => {
  // sender: string, text: string - inferred from ChatEvents
  console.log(`${sender}: ${text}`);
});

chat.emit("message", "alice", "Hello!");     // ✓ correct types
// chat.emit("message", 42);                 // ✗ ERROR: number not string
// chat.emit("unknown", "data");             // ✗ ERROR: "unknown" not in ChatEvents
```

> **Tip**
>
> `Parameters<T[K]>` extracts the parameter types of a function type. If `T[K]` is `(sender: string, text: string) => void`, then `Parameters<T[K]>` is `[string, string]`. This is how `emit` knows exactly what arguments to accept for each event.

> **Warning**
>
> The event map has to be a `type`, not an `interface`. Write `interface ChatEvents { ... }` and `new TypedEmitter<ChatEvents>()` fails to compile:
>
> ```
> error TS2344: Type 'ChatEvents' does not satisfy the constraint
>   'Record<string, (...args: any[]) => void>'.
>   Index signature for type 'string' is missing in type 'ChatEvents'.
> ```
>
> A type alias for an object gets an *implicit index signature*; an interface does not, because an interface can be reopened and merged later, so TypeScript cannot promise its keys are all strings mapping to handlers. `Record<string, ...>` demands exactly that promise. The two declarations look interchangeable and are not - this is the one place the difference bites.

> **Note**
>
> The emitter above uses `any` twice - in the constraint, and in the `Function` casts inside `emit`. Chapter 3 said never to use `any`, and it was right. Our `src/events.ts` below constrains with `(...args: never[]) => void` instead: parameters are contravariant, so `never` accepts every concrete handler signature while still refusing a non-function. It says "some function, I don't care which" without switching off type checking for the people who write the handlers.

## Putting It Together

The two generic tools this chapter builds live in `src/events.ts`, and the server on the `chapter8` branch is wired through them. Here is the heart of each; the complete files are on the branch.

`TypedEmitter<T>` is parameterised by an event map, so `on` and `emit` are checked against it - `emit("mesage", ...)` with a typo does not compile:

```typescript
export class TypedEmitter<T extends EventMap> {
  private readonly listeners = new Map<keyof T, Set<StoredListener>>();

  // `K extends keyof T` ties the handler to the event: pass "message" and the
  // compiler demands exactly T["message"], with its parameter names and types.
  on<K extends keyof T>(event: K, listener: T[K]): this {
    let set = this.listeners.get(event);
    if (set === undefined) {
      set = new Set();
      this.listeners.set(event, set);
    }
    set.add(listener);
    return this;
  }
```

And `pluck` extracts one property from every item, with the key checked against the element type, so `pluck(rooms, "nmae")` is a build error:

```typescript
export function pluck<T, K extends keyof T>(items: readonly T[], key: K): T[K][] {
  return items.map((item) => item[key]);
}
```

> **Tip**
>
> The complete, runnable file is `src/events.ts` on the `chapter8` branch. You are not meant to paste it wholesale - build your own as you follow along, and use the reference to check yourself.

## Exercise

1. Write a generic `function last<T>(items: T[]): T | undefined` that returns the last element. Test with string and number arrays.
2. Create a generic `Cache<V>` class with `get`, `set`, `has`, and `delete` methods. Use it with `Cache<string>` and `Cache<number>`.
3. Use `Partial<User>` for an update function: `function updateUser(id: string, changes: Partial<User>): User`.
4. Add a `"disconnect"` event to `ChatEvents` with a `(userId: string, reason: string)` handler. Register and emit it.
5. Use `keyof` + generic constraint to write `function pluck<T, K extends keyof T>(items: T[], key: K): T[K][]` that extracts one property from an array of objects.

## What's Next

You now have generics - type parameters, constraints, generic classes, utility types, and a typed event emitter. These are the tools for building reusable, type-safe code.

In the next chapter, we learn **enums and discriminated unions** - modeling the different message types our chat server handles, with exhaustive pattern matching.

---

Source: <https://purphoros.com/howto/typescript/generics>
