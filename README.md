# Chapter 04 - Interfaces, Objects & Classes

Define shapes for data with interfaces, add behavior with classes, and know when to use each - the building blocks for our chat server's types.

## Defining Interfaces for Object Shapes

An `interface` describes the shape of an object - what properties it has and what types they are. It's a compile-time contract, erased from the JavaScript output.

```typescript
interface User {
  id: string;
  name: string;
  joinedAt: number;
}

// Objects must match the shape exactly
const alice: User = {
  id: "u1",
  name: "alice",
  joinedAt: Date.now(),
};

// Missing or extra properties are compile errors:
// const bad: User = { id: "u2", name: "bob" };
//   ERROR: Property 'joinedAt' is missing
// const extra: User = { id: "u3", name: "carol", age: 25 };
//   ERROR: 'age' does not exist in type 'User'
```

> **Note**
>
> `interface` vs `type`: both define object shapes. Interfaces can be **extended** and **merged**(two declarations with the same name combine). Types support unions and intersections. For object shapes, prefer `interface`. For unions and complex types, use `type`.

## Optional Properties and Readonly

```typescript
interface Message {
  readonly id: string;       // can't be changed after creation
  sender: string;
  text: string;
  room: string;
  replyTo?: string;          // optional - may or may not exist
  editedAt?: number;         // optional
}

const msg: Message = {
  id: "m1",
  sender: "alice",
  text: "Hello!",
  room: "general",
  // replyTo and editedAt omitted - they're optional
};

// msg.id = "m2";  // ERROR: Cannot assign to 'id' because it is read-only
msg.text = "Hello, edited!";  // fine - not readonly
```

`readonly` prevents reassignment after creation. It's a compile-time check only - not enforced at runtime (JavaScript has no concept of readonly properties on plain objects).

`?` makes a property optional. Its type becomes `T | undefined` - you must check for `undefined` before using it.

## Extending Interfaces

```typescript
interface User {
  id: string;
  name: string;
}

// AdminUser has everything User has, plus adminLevel
interface AdminUser extends User {
  adminLevel: number;
  permissions: string[];
}

const admin: AdminUser = {
  id: "u1",
  name: "alice",
  adminLevel: 2,
  permissions: ["kick", "ban", "mute"],
};

// AdminUser IS-A User - you can pass it anywhere a User is expected
function greet(user: User): string {
  return `Hello, ${user.name}!`;
}

greet(admin);  // fine - AdminUser extends User
```

> **Tip**
>
> TypeScript uses **structural typing** (duck typing). If an object has all the required properties, it satisfies the interface - even without an explicit `implements`. An `AdminUser` works as a `User` because it has `id` and `name`.

## Classes with Typed Properties and Methods

Classes combine data and behavior. In our chat server, we'll use classes for stateful objects like rooms and connections:

```typescript
class ChatRoom {
  name: string;
  private members: Set<string> = new Set();
  readonly createdAt: number;

  constructor(name: string) {
    this.name = name;
    this.createdAt = Date.now();
  }

  join(userId: string): void {
    this.members.add(userId);
  }

  leave(userId: string): boolean {
    return this.members.delete(userId);
  }

  hasMember(userId: string): boolean {
    return this.members.has(userId);
  }

  get memberCount(): number {
    return this.members.size;
  }

  get memberList(): string[] {
    return [...this.members];
  }
}

const room = new ChatRoom("general");
room.join("alice");
room.join("bob");
console.log(room.memberCount);   // 2
console.log(room.memberList);    // ["alice", "bob"]
// room.members;  // ERROR: 'members' is private
```

## Access Modifiers: public, private, protected

| Modifier | Accessible from | Use for |
|---|---|---|
| public | Anywhere (default) | API surface - methods callers use |
| private | Same class only | Internal state - implementation details |
| protected | Same class + subclasses | Extension points - things subclasses override |
| readonly | Anywhere (read), constructor (write) | Immutable after construction |

```typescript
class Connection {
  // Constructor parameter shorthand - declares AND initializes properties
  constructor(
    public readonly id: string,
    private socket: unknown,
    protected authenticated: boolean = false,
  ) {}

  // public - anyone can call
  send(data: string): void {
    console.log(`[${this.id}] Sending: ${data}`);
  }

  // private - only this class
  private resetSocket(): void {
    this.socket = null;
  }

  // protected - this class + subclasses
  protected setAuthenticated(value: boolean): void {
    this.authenticated = value;
  }
}
```

> **Tip**
>
> The constructor shorthand `constructor(public readonly id: string)` declares the property, sets its visibility, makes it readonly, AND assigns the constructor parameter - all in one line. This is a TypeScript-only feature, not JavaScript.

## Implementing Interfaces

```typescript
interface Serializable {
  serialize(): string;
}

interface Identifiable {
  readonly id: string;
}

// A class can implement multiple interfaces
class ChatMessage implements Serializable, Identifiable {
  readonly id: string;
  constructor(
    public sender: string,
    public text: string,
    public room: string,
  ) {
    this.id = crypto.randomUUID();
  }

  serialize(): string {
    return JSON.stringify({
      id: this.id,
      sender: this.sender,
      text: this.text,
      room: this.room,
    });
  }
}

// Both interfaces are satisfied
const msg = new ChatMessage("alice", "Hello!", "general");
console.log(msg.serialize());
```

## Interfaces vs Classes - When to Use Which

#### Use Interfaces when:

- Defining data shapes (no behavior)
- Type-checking function parameters
- API contracts between modules
- You need zero runtime overhead

#### Use Classes when:

- Data + behavior together (methods)
- Need `instanceof` checks at runtime
- Internal state that should be private
- Stateful objects (rooms, connections, sessions)

> **Note**
>
> In our chat server: `interface` for message shapes, event types, and handler signatures. `class` for ChatRoom, Connection, and Server - things with internal state and methods.

## Putting It Together

Interfaces describe shapes; classes give them behaviour and encapsulation. Both are on the `chapter4` branch; here are the pieces this chapter adds.

The domain as interfaces. `AdminUser extends User` and structural typing means an admin can go anywhere a user is expected:

```typescript
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
```

And `ChatRoom` - state plus behaviour, with `private` members the outside cannot touch:

```typescript
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
```

> **Tip**
>
> The complete, runnable file is `src/index.ts` on the `chapter4` branch. You are not meant to paste it wholesale - build your own as you follow along, and use the reference to check yourself.

## Exercise

1. Define a `Message` interface with `id` (readonly), `sender`, `text`, `room`, and optional `replyTo`. Create a message object and try to modify `id`.
2. Create `AdminUser extends User` with `adminLevel: number` and `permissions: string[]`. Pass an AdminUser to a function that accepts User - it should work (structural typing).
3. Build a `ChatRoom` class with private `members: Set<string>`, public `join/leave/hasMember` methods, and a `memberCount` getter. Try accessing `members` from outside - it should be a compile error.
4. Use the constructor shorthand: `constructor(public readonly id: string, private name: string)`. Verify `id` is accessible and readonly, and `name` is inaccessible from outside.
5. Create a `Serializable` interface with a `serialize(): string` method. Implement it on both `ChatMessage` and `ChatRoom`.

## What's Next

You now have interfaces for data shapes and classes for stateful objects. Our chat server will use both - interfaces for messages and events, classes for rooms and connections.

In the next chapter, we write actual networking code - a TCP server using Node.js's `net` module, accepting connections and exchanging data over the wire.

---

Source: <https://purphoros.com/howto/typescript/interfaces-classes>
