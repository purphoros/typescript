# Chapter 16 - Chat Server Core

Rooms, the client state machine, and broadcasting. Everything so far has been in service of a chat server; this chapter finally looks hard at the chat.

And it finds a bug. A real one, that has been in the code since Chapter 5, that shipped through eleven chapters of increasingly careful type-level work - and that the type system watched me write, twice, and said nothing about.

## The bug

Rooms stored their membership like this:

```typescript
room.join(client.label);      // "join"  - handler.ts
room.leave(client.label);     // "leave" - handler.ts
```

`label` is the client's display name:

```typescript
get label(): string {
  return this.identity?.name ?? this.id;    // the nickname, or the id if unnamed
}
```

Read those two together and the bug is right there. **A label is a nickname, and a nickname changes.**

Join a room before picking a name, and the room records `"c1"`. Then take the name `alice`. Then leave - and the room dutifully removes `"alice"`, which was never in it, and keeps `"c1"` **forever**:

```
  after one client joined, renamed, and left:
  general.members = 1     <-- LEAKED. Nobody is in there.
```

The room now reports a member who is not connected, was never really that name, and can never be removed. Every rename leaks another one.

## Why eleven chapters of types did not catch it

```typescript
export type UserId = string;
class TcpClient { readonly id: string; }
get label(): string { ... }
```

`room.join(client.label)` compiles perfectly, because a label is a `string` and an id is a `string`. **TypeScript is structural**: it compares shapes, and a nickname and an identifier have exactly the same shape. The compiler was never going to help, because we never told it there was anything to help with.

There are two fixes, and this chapter does both. One removes the bug. The other makes it *unrepresentable* - and that is the one worth learning.

## Fix one: rooms hold ids

```typescript
export class ChatRoom {
  // Client *ids*, not labels.
  private members: Set<ClientId> = new Set();
```

An id is handed out once, at `accept()`, and never changes. Anything that wants a *name* asks the registry, which knows who `c1` is right now:

```typescript
membersOf(room: ChatRoom): ChatClient[] {
  const members: ChatClient[] = [];
  for (const id of room.memberIds) {
    const client = this.clients.get(id);
    if (client !== undefined) members.push(client);
  }
  return members;
}
```

Notice what this buys in the `nick` handler - which is to say, notice the code that **is not there**:

```typescript
client.identifyAs(user);
// The room membership does not have to be touched. It is keyed by id, and
// the id did not change.
```

## Fix two: make it a compile error

Fixing the four call sites changes nothing structurally. `room.join(someLabel)` would still compile tomorrow. So give the compiler a name it will insist on - a **branded type**:

```typescript
declare const ClientIdBrand: unique symbol;
export type ClientId = string & { readonly [ClientIdBrand]: true };

// The only way to make one. Called once, in clients.ts, at accept().
export function clientId(raw: string): ClientId {
  return raw as ClientId;
}
```

A `ClientId` is a string with an impossible extra property - impossible because a `unique symbol` key cannot be forged. No plain `string` is assignable to it. And the moment `ChatRoom.join` took a `ClientId`, the compiler found the bug for me, in every place it lived:

```
src/handler.ts(104,44): error TS2345: Argument of type 'string' is not assignable to parameter of type 'ClientId'.
src/handler.ts(190,47): error TS2345: Argument of type 'string' is not assignable to parameter of type 'ClientId'.
src/handler.ts(194,19): error TS2345: Argument of type 'string' is not assignable to parameter of type 'ClientId'.
src/handler.ts(204,20): error TS2345: Argument of type 'string' is not assignable to parameter of type 'ClientId'.
```

Four sites. Exactly the four.

> **Tip**
>
> The cost is one assertion, in `clientId()`, at the single point where an id is minted. That is the Chapter 13 bargain again: **one line you can audit, buying a rule the compiler enforces everywhere else.** Brand the types that are "just a string" but must never be confused - `UserId` and `RoomName` and `SessionToken` and `Email` - and the class of bug where you pass the right shape and the wrong *meaning* simply stops existing.

## The Client State Machine

Chapter 15's client held two independent optionals:

```typescript
protected identity?: User;
protected currentRoom?: RoomName;
```

Two optionals are **four** combinations, and only three of them mean anything:

| identity | currentRoom | meaning |
|---|---|---|
| - | - | connected, said nothing |
| set | - | has a name, not in a room |
| set | set | chatting |
| **-** | **set** | **in a room, but nobody** |

That fourth row was reachable, and it is where the bug lived. So replace both fields with one union:

```typescript
export type ClientState =
  | { readonly status: "anonymous" }
  | { readonly status: "identified"; readonly user: User }
  | { readonly status: "chatting"; readonly user: User; readonly room: RoomName };
```

A union cannot hold the fourth row. You are in a room only in the `chatting` state, and `chatting` **carries the user with it** - there is no way to be one without the other, because there is no such value to construct.

`user` and `room` become derived, not stored, so they cannot drift:

```typescript
get user(): User | undefined {
  return this.presence.status === "anonymous" ? undefined : this.presence.user;
}

get room(): RoomName | undefined {
  return this.presence.status === "chatting" ? this.presence.room : undefined;
}
```

And the one transition the machine genuinely forbids:

```typescript
enterRoom(name: RoomName): void {
  if (this.presence.status === "anonymous") {
    throw new StateError(`Say who you are first, e.g. ${CATALOG.nick.example}`,
                         ErrorCode.NotIdentified);
  }
  this.presence = { status: "chatting", user: this.presence.user, room: name };
}
```

> **Note**
>
> Read the `join` handler and notice there is no check that the client has a name. There does not need to be one. The rule lives in the state machine: `chatting` carries a `user`, so *a client in a room without a name is not a case somebody forgot to check - it is a value that cannot be built.* That is the difference between validating a rule and encoding one.
>
> This is the same move as `assertNever` in Chapter 9 and `Result` in Chapter 10. Push the invariant into a place where breaking it is a type error rather than a code review.

> **Warning**
>
> This is a genuine behaviour change: you must now `{"type":"nick","name":"alice"}` before you can `{"type":"join"}`. Previously a client could chat anonymously under `c1`. That was the flexibility that made the fourth row reachable, and a room whose member list reads `c1, c4, w7` was never really a chat room anyway.

## Rooms on Demand, and Rooms That Go Away

```typescript
getOrCreateRoom(name: RoomName): ChatRoom {
  const existing = this.rooms.get(name);
  if (existing !== undefined) return existing;

  if (this.rooms.size >= this.config.maxRooms) {
    throw new StateError(`This server holds ${this.config.maxRooms} rooms and they are all taken.`,
                         ErrorCode.NotPermitted);
  }
  const room = new ChatRoom(name, this.config.historyLimit);
  this.rooms.set(name, room);
  return room;
}
```

Rooms come into existence by being walked into. That is what a chat server is for - and it is also, unbounded, how a stranger fills your heap with ten million empty rooms. Chapter 15's rule holds: **anything a stranger can grow, bound.**

The name is safe to create a *file* from without a second thought, because the schema (Chapter 14) already guarantees it is lowercase letters, digits and hyphens, at most 32 of them. Layers paying each other back.

And the last one out turns off the lights:

```typescript
reapIfEmpty(name: RoomName): boolean {
  const room = this.rooms.get(name);
  if (room === undefined || !room.isEmpty || this.isPermanent(name)) return false;
  this.rooms.delete(name);
  return true;
}
```

The permanent rooms survive: an empty `general` is not litter, it is a lobby. And note what is **not** deleted - the room's history file. Rooms are cheap; conversations are not. Walk back into `#standup` next week and it is still there. The room object is a handle, not the archive.

Note also that `requireRoomNamed` still exists and is still used - by HTTP. `GET /api/rooms/ghost` must return **404**, not conjure a room. Asking *about* a room and walking *into* one are different verbs, and they get different functions.

## Try It

```bash
npm run build && npm start
```

```json
{"type":"join","room":"general"}
```
```json
{"type":"error","code":"not_identified","message":"Say who you are first, e.g. {\"type\":\"nick\",\"name\":\"alice\"}"}
```

Now the bug, and its absence. Join, rename, leave:

```json
{"type":"nick","name":"bob"}
{"type":"join","room":"general"}
{"type":"nick","name":"alice"}     → everyone in the room sees "bob is now known as alice"
{"type":"leave"}
```

```bash
curl -s http://127.0.0.1:8080/api/rooms
```

The member count is right. Before this chapter it would have been permanently, invisibly wrong.

Rooms on demand, and reaped:

```
  rooms now: general, random, dev, standup
  after leaving: general, random, dev      (standup reaped; permanent rooms stay)
```

And the cap, tested with no sockets at all - because `Registry` is a class you can just construct, which is what Chapter 11 was for:

```
  stopped after creating 97 (total 100)
  -> not_permitted: This server holds 100 rooms and they are all taken.
```

## Putting It Together

The membership leak is fixed two ways: rooms key on an immutable id, and the id is a *branded* type. Both are on the `chapter16` branch.

The state machine, as a union. You are in a room only in the `chatting` state, and it carries the user - so "in a room, but nobody" is not a value you can build:

```typescript
export type ClientState =
  | { readonly status: "anonymous" }
  | { readonly status: "identified"; readonly user: User }
  | { readonly status: "chatting"; readonly user: User; readonly room: RoomName };
```

And the brand. `ClientId` is a string the compiler will not let you confuse with a nickname - which is what made the membership leak a compile error:

```typescript
declare const ClientIdBrand: unique symbol;
export type ClientId = string & { readonly [ClientIdBrand]: true };

// The only way to make one. Called once, in clients.ts, at accept().
export function clientId(raw: string): ClientId {
  return raw as ClientId;
}
```

> **Tip**
>
> The full `src/types.ts`, `src/state.ts` (rooms on demand, reaping) and `src/handler.ts` are on the branch. Note the join handler has no is-this-client-named check - the state machine makes it unnecessary.
## Exercise

1. Delete the brand: make `ClientId` a plain `type ClientId = string`. Everything still compiles - including `room.join(client.label)`. Put it back and re-read the four errors. That is the chapter.
2. Brand `RoomName` and `UserId` the same way. How many places break? Were any of them wrong?
3. Add a `{ status: "away"; user: User; room: RoomName }` state. Follow the compiler until it stops complaining, and count how many places it sent you. None of them was a place you had to *remember*.
4. `reapIfEmpty` keeps the history file. Add a `{"type":"rooms"}` reply that also lists rooms which have an archive but no live room object - the empty rooms you can still walk back into.
5. A client is dropped for backpressure (Chapter 15) while sitting in a room. Trace what removes it from `room.members`. Now do the same for a client whose socket errors. Are they the same path? Should they be?

## What's Next

Rooms are keyed by something that cannot change, presence is a state machine that cannot hold a contradiction, and rooms come and go on their own.

But look at `Registry.knownUsers`: a hard-coded `Map` with `alice` and `bob` in it, where `{"type":"nick","name":"alice"}` makes you an admin because you said so. Every chapter since Chapter 4 has had a comment promising this gets fixed in Chapter 17.

It is Chapter 17. Next: **authentication and sessions** - proving who you are, rather than announcing it.

---

Source: <https://purphoros.com/howto/typescript/chat-core>
