# Chapter 09 - Enums & Discriminated Unions

Model every message our chat server handles - chat, join, leave, whisper, kick, and the rest - so that the compiler knows what each one carries, and refuses the ones that make no sense.

This is the chapter where the server stops guessing. Since Chapter 5 it has parsed what clients send by splitting on whitespace and looking at the first word. That worked, and it was a lie: nothing in the type system knew that `/join` needed a room, that `/nick` needed a name, or that `/jion` was not a command at all. By the end of this chapter, all three of those are compile-time facts.

## String Enums and const Enums

TypeScript `enum` defines a set of named constants. String enums give each value a meaningful string representation:

```typescript
// String enum - each member has an explicit string value
enum ConnectionState {
  Connecting = "connecting",
  Connected = "connected",
  Disconnected = "disconnected",
  Reconnecting = "reconnecting",
}

const state: ConnectionState = ConnectionState.Connected;
console.log(state); // "connected"

// const enum - inlined at compile time (no JavaScript object generated)
const enum Direction {
  Up = "UP",
  Down = "DOWN",
  Left = "LEFT",
  Right = "RIGHT",
}
// Direction.Up is replaced with "UP" in the output - zero runtime cost
```

> **Tip**
>
> In modern TypeScript, many developers prefer **literal union types** (`"connecting" | "connected" | "disconnected"`) over enums. Literal unions are simpler, tree-shakeable, and don't generate runtime JavaScript. We'll use both approaches and you'll see when each fits.

> **Warning**
>
> `const enum` is a trap in a project like this one, and it is worth knowing why before you reach for it. Inlining `Direction.Up` into `"UP"` requires the compiler to see the enum's declaration and its use *at the same time*. Any tool that transpiles one file at a time cannot do that - it has no idea what `Direction` is when it reaches the file that uses it. So `const enum` is an outright error under `isolatedModules`, and esbuild and swc - and therefore `tsx`, which runs this server - either reject it or quietly downgrade it to a regular enum, which is not what you asked for. Use a plain string enum, or a literal union, and let your bundler do the eliminating.

## Discriminated Unions - The type Field Pattern

A **discriminated union** is a union where every member has a common property (the *discriminant*) with a unique literal value. TypeScript uses this property to narrow the type:

```typescript
// Each variant has a unique "type" literal
type ChatMessage =
  | { type: "text"; sender: string; text: string; room: string }
  | { type: "join"; user: string; room: string }
  | { type: "leave"; user: string; room: string }
  | { type: "system"; text: string }
  | { type: "command"; sender: string; command: string; args: string[] };

// switch on the discriminant - TypeScript narrows in each branch
function formatMessage(msg: ChatMessage): string {
  switch (msg.type) {
    case "text":
      return `[${msg.room}] ${msg.sender}: ${msg.text}`;
    case "join":
      return `→ ${msg.user} joined #${msg.room}`;
    case "leave":
      return `← ${msg.user} left #${msg.room}`;
    case "system":
      return `[SYSTEM] ${msg.text}`;
    case "command":
      return `/${msg.command} ${msg.args.join(" ")}`;
  }
}
```

Inside `case "text":`, TypeScript knows `msg` is `{ type: "text"; sender: string; text: string; room: string }`. You get autocomplete for `msg.sender` and `msg.text` - properties that only exist on the "text" variant. Ask for `msg.user` in that branch and it is a compile error, because a text message has no user.

> **Note**
>
> A discriminated union models a value that is exactly one of several shapes, each carrying its own fields. The shared literal field - here `type` - is the tag the compiler switches on, which is what makes the match exhaustive and gives each branch access to that variant's fields alone.

## Exhaustive Checking with never

The `never` type ensures every variant is handled. `never` is the type with no values, so nothing is assignable to it. Once a switch has handled every variant, the value left over in `default` has been narrowed to nothing - and only then does a call taking `never` typecheck:

```typescript
function assertNever(value: never): never {
  throw new Error(`Unhandled value: ${value}`);
}

function formatMessage(msg: ChatMessage): string {
  switch (msg.type) {
    case "text": return `${msg.sender}: ${msg.text}`;
    case "join": return `→ ${msg.user} joined`;
    case "leave": return `← ${msg.user} left`;
    case "system": return `[SYSTEM] ${msg.text}`;
    case "command": return `/${msg.command}`;
    default: return assertNever(msg);
    // If a case is missing, msg is NOT never → compile error
  }
}
```

Miss a case, and the error names the variant you forgot:

```
error TS2345: Argument of type '{ type: "command"; ... }' is not
  assignable to parameter of type 'never'.
```

That is the whole trick, and it is worth being precise about what it buys you: it is not that the switch is checked once, today. It is that the switch is checked *every time anyone adds a variant, forever*. The compiler becomes the colleague who reviews your union changes and never gets bored.

> **Warning**
>
> Without `assertNever` in the default, TypeScript won't catch missing cases. The switch compiles fine - you just get `undefined` at runtime for the unhandled variant. Always add the exhaustive check when handling discriminated unions.

## Deriving Types From the Union

Once a union exists, you rarely need to write its variants down a second time. Three utilities do the work, and our server uses all three.

`ClientMessage["type"]` is the union of every discriminant - indexing a union by a key they all share gives you the union of that key's types:

```typescript
type ClientMessageType = ClientMessage["type"];
// "chat" | "whisper" | "join" | "leave" | "nick" | ...
```

`Extract<T, U>` goes the other way, narrowing a union to the members that match a shape:

```typescript
type JoinMessage = Extract<ClientMessage, { type: "join" }>;
// { type: "join"; room: string }
```

And `Record<K, V>` - from Chapter 8 - turns the discriminant union into a *checklist*. An object typed `Record<ClientMessageType, Something>` must have a key for every variant. Miss one and the object literal will not compile:

```typescript
// The catalog cannot fall out of date with the protocol, because the
// compiler will not let it. Add a variant to ClientMessage and this
// object stops compiling until you describe the new message.
const CATALOG: Record<ClientMessageType, CommandInfo> = {
  chat: { ... },
  join: { ... },
  // forget one → error TS2741: Property 'whisper' is missing
};
```

This is the pattern to reach for whenever something must exist "one per variant" - a help entry, a validator, a handler, a UI renderer. The union is declared once, and everything else is derived from it and checked against it.

## Parsing Is Where the Types Come From

Here is the most important thing in the chapter, and it is easy to get wrong. A discriminated union is a promise about a value's shape. `JSON.parse` returns `any`. Somewhere between the socket and the switch, someone has to *keep* that promise.

The tempting version does not:

```typescript
function parseClientMessage(raw: string): ClientMessage | null {
  try {
    const data = JSON.parse(raw);
    if (typeof data.type !== "string") return null;
    return data as ClientMessage;   // ← a lie
  } catch {
    return null;
  }
}
```

That `as` is an assertion, not a check. It tells the compiler "trust me, this is a ClientMessage" about a value that came off a socket from someone you have never met. Send `{"type":"join"}` with no room and every downstream `msg.room` is `undefined` - typed as `string`, valued as nothing - and your server crashes in a function that looks completely correct. Chapter 3 warned about exactly this: an assertion silences the compiler, it does not change the value.

The honest version checks each variant's fields and *rebuilds* the message from the parts it has proven:

```typescript
const DECODERS: DecoderMap = {
  chat: (f) => (isString(f.text) ? { type: "chat", text: f.text } : null),
  join: (f) => (isString(f.room) ? { type: "join", room: f.room } : null),
  leave: () => ({ type: "leave" }),
  // ...one per variant, and Record<> insists on all of them
};
```

Nothing is asserted. Each decoder is handed `Record<string, unknown>` - keys we have not checked, values we know nothing about - and hands back either a real message or `null`. Everything downstream of that function works with a value the compiler can trust, because that function is the one place that earned the trust.

> **Tip**
>
> This is the shape of every well-built boundary: `unknown` on the outside, a real type on the inside, and one validating function in between. The type system cannot check what arrives on a socket. It can, however, make it impossible to *use* what arrives until someone has checked it - which is the same thing, provided you never write `as`.

## Applying to Chat: The Complete Message Protocol

Two unions define the whole conversation. `ClientMessage` is everything a client may say; `ServerMessage` is everything the server may say back. A client that handles every `ServerMessage` variant handles the entire protocol - there is no thirteenth thing it might be sent.

```typescript
// Client → Server
export type ClientMessage =
  | { type: "chat"; text: string }
  | { type: "whisper"; to: UserId; text: string }
  | { type: "join"; room: RoomName }
  | { type: "leave" }
  | { type: "nick"; name: string }
  | { type: "who" }
  | { type: "rooms" }
  | { type: "history"; limit?: number }
  | { type: "kick"; target: UserId; reason: string }
  | { type: "status" }
  | { type: "help" }
  | { type: "quit" };

// Server → Client
export type ServerMessage =
  | { type: "welcome"; id: string; transport: Transport; text: string }
  | { type: "system"; text: string }
  | { type: "chat"; sender: UserId; text: string; room: RoomName; at: Timestamp }
  | { type: "whisper"; from: UserId; to: UserId; text: string; at: Timestamp }
  | { type: "joined"; user: UserId; room: RoomName; members: number }
  | { type: "left"; user: UserId; room: RoomName }
  | { type: "userList"; users: readonly UserSummary[] }
  | { type: "roomList"; rooms: readonly RoomSummary[] }
  | { type: "history"; room: RoomName; messages: readonly MessageSummary[] }
  | { type: "commands"; commands: readonly CommandInfo[] }
  | { type: "kicked"; by: UserId; reason: string }
  | { type: "error"; code: ErrorCode; message: string };
```

Both transports now carry the same JSON - one object per line over TCP, one object per frame over WebSocket - so a `nc` session and a browser tab are speaking the same language, not two dialects that happen to rhyme.

That the TCP side works at all is the Chapter 5 buffering finally being paid off. TCP is a byte stream with no message boundaries: a JSON object can arrive in three chunks, or two objects can arrive in one. `takeLines()` already deals with that, and the newline is the frame. Nothing new was needed.

> **Tip**
>
> Separate `ClientMessage` and `ServerMessage` types give you type safety on both sides. The client can only send messages the server expects, and the server can only send messages the client handles. Look at `ChatClient.send()` in the listing below: it takes a `ServerMessage`, not a `string`. The chat logic never formats a line of output by hand again, and it *cannot* send a shape no client has heard of.

### Two departures from the chapter

**The parse must validate, not assert.** The listing at the top of this chapter ends `return data as ClientMessage`, and Chapter 3 spent a page explaining why that is exactly the wrong move. `src/protocol.ts` uses one decoder per variant, checks the fields, and constructs a fresh message. See *Parsing Is Where the Types Come From* above.

**`ConnectionState` has no `Reconnecting`.** The exercise asks for four states including reconnecting, and a server has no such state - a server does not reconnect, it sits still and is connected *to*. Putting a state into the enum that no server-side connection can ever be in means every exhaustive switch has to handle a case that cannot happen, which is precisely the dead weight `assertNever` exists to prevent. So the server's enum is `Connecting` (accepted, protocol not yet sniffed), `Connected`, `Closing` (draining what we wrote), `Disconnected` - four states it genuinely passes through. `reconnecting` does exist, in the browser page at the bottom of `src/index.ts`, because that is whose state it is. Where a state lives is part of what it means.

## Putting It Together

`src/protocol.ts` is new: the contract, and the only place a message is decoded or encoded. `src/index.ts` loses its string parsing entirely - `handleMessage()` switches over an already-checked `ClientMessage`, and `assertNever` guarantees every variant is handled. Both files are on the `chapter9` branch; here are the two pieces that matter.

Everything a client may send, as a discriminated union - the `type` field is the discriminant the compiler switches on:

```typescript
export type ClientMessage =
  | { type: "chat"; text: string }
  | { type: "whisper"; to: UserId; text: string }
  | { type: "join"; room: RoomName }
  | { type: "leave" }
  | { type: "nick"; name: string }
  | { type: "who" }
  | { type: "rooms" }
  | { type: "history"; limit?: number }
  | { type: "kick"; target: UserId; reason: string }
  | { type: "status" }
  | { type: "help" }
  | { type: "quit" };

// The name of a variant: "chat" | "whisper" | "join" | ... Indexing a union by a
// key it shares gives the union of that key's types, which here is the set of
// every legal discriminant. Nothing has to list them a second time.
export type ClientMessageType = ClientMessage["type"];
```

And the decoder. It does not `as ClientMessage` a parsed blob; it validates each variant's fields and returns a value the rest of the server can trust:

```typescript
export function decodeClientMessage(raw: string): Decoded {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return invalid(`expected JSON, e.g. ${CATALOG.chat.example}`);
  }

  if (!isRecord(value)) {
    return invalid("expected a JSON object");
  }

  const type = value.type;
  if (!isString(type)) {
    return invalid('every message needs a "type" field');
  }

  // hasOwn, not `in`: "toString" is *in* every object, and dispatching on it
  // would hand us Object.prototype.toString to call as a decoder.
  if (!Object.hasOwn(DECODERS, type)) {
    return invalid(`unknown message type "${type}". Known types: ${KNOWN_TYPES}`);
  }

  // Widen on the way out. Each decoder in the map returns its *own* variant -
  // that is the point of the map - but once the key is only known to be some
  // ClientMessageType, the thing it returns is only known to be some
  // ClientMessage. Annotating the plain function type says exactly that, and is
  // the last of the narrowing: everything past here is typed.
  const decode: (fields: Fields) => ClientMessage | null = DECODERS[type as ClientMessageType];
  const message = decode(value);
  if (message === null) {
    return invalid(`malformed "${type}" message. Expected ${CATALOG[type as ClientMessageType].example}`);
  }

  return { kind: "ok", message };
}
```

> **Tip**
>
> The complete, runnable file is `src/protocol.ts` on the `chapter9` branch. You are not meant to paste it wholesale - build your own as you follow along, and use the reference to check yourself.

## Try It

```bash
npm run dev
```

The server tells you what it speaks now:

```
Clients now speak JSON - one object per line over TCP, one per frame over WebSocket:
  {"type":"join","room":"general"}
  {"type":"chat","text":"hello everyone"}
```

Open two terminals and talk between them:

```bash
nc 127.0.0.1 8080
{"type":"nick","name":"alice"}
{"type":"join","room":"general"}
{"type":"chat","text":"hello everyone"}
```

Every reply is a `ServerMessage`:

```json
{"type":"welcome","id":"c1","transport":"tcp","text":"Welcome. You are c1. Send {\"type\":\"help\"} to see what I understand."}
{"type":"system","text":"You are now alice. You are an admin (level 2)."}
{"type":"joined","user":"alice","room":"general","members":1}
{"type":"chat","sender":"alice","text":"hello everyone","room":"general","at":1783921779116}
```

Now get it wrong on purpose, which is the part worth doing:

```json
this is not json
{"type":"jion","room":"general"}
{"type":"join"}
```

```json
{"type":"error","code":"invalid_message","message":"expected JSON, e.g. {\"type\":\"chat\",\"text\":\"hello everyone\"}"}
{"type":"error","code":"invalid_message","message":"unknown message type \"jion\". Known types: chat, whisper, join, leave, nick, who, rooms, history, kick, status, help, quit"}
{"type":"error","code":"invalid_message","message":"malformed \"join\" message. Expected {\"type\":\"join\",\"room\":\"general\"}"}
```

A typo is now a protocol error with an explanation, not a shrug. And the protocol can describe itself, because `CATALOG` is a `Record` keyed by every variant:

```bash
curl http://127.0.0.1:8080/api/protocol
```

Open <http://127.0.0.1:8080/> in a browser and you get the other end of the same two unions: a page that builds a `ClientMessage` from what you type and switches over every `ServerMessage` it might be sent. Type in the browser, watch it arrive in `nc`.

## Exercise

1. Add a `"mute"` variant to `ClientMessage` with `target: string` and `seconds: number`. Do not touch anything else, then run `npm run typecheck` - the compiler will name every place that has to change: the decoder map, the catalog, and the switch in `handleMessage`. Follow it until it goes quiet.
2. Remove a `case` from the switch in `handleMessage` and read the error. Which variant does it name, and why is the type it complains about `never`?
3. Change `decodeClientMessage` to `return value as ClientMessage` instead of validating, then send `{"type":"join"}` with no room. Where does it break, and how far is that from where you lied?
4. `describeState` switches over the `ConnectionState` enum. Add a fifth member and watch a switch you did not touch stop compiling.
5. Give `ServerMessage` a `"typing"` variant (`user`, `room`) and emit it. The browser page's `render()` has a `default` branch rather than an `assertNever` - it is plain JavaScript. What does that cost you, and what would it take to get the guarantee back on the client side?

## What's Next

You now have discriminated unions - the type-safe way to model "one of several things, each with different fields" - and the exhaustive switch that makes forgetting one a build error rather than a 3am `undefined`. The server has a real protocol, checked at compile time on both ends, and a decoder that earns every type it hands out.

What it does not have is a story for when things go wrong. Look at `decodeClientMessage`: it returns `{ kind: "invalid"; reason: string }` - a union, because that is the tool we had. Look at the socket error handlers, which just log. In the next chapter we take **error handling** seriously: try/catch with typed errors, custom error classes, and the `Result` pattern for propagating failure without pretending it cannot happen.

---

Source: <https://purphoros.com/howto/typescript/unions>
