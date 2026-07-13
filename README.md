# Chapter 14 - JSON & Validation

`JSON.parse` returns `any` - a type safety hole. Zod closes it with schemas that validate at runtime **and** generate TypeScript types at compile time.

Chapter 9 already refused the easy lie. It did not write `as ClientMessage`; it hand-checked every field of every variant and rebuilt the message from the parts it had proven. That was right, and it left a different problem behind - one this chapter finally deletes.

## The JSON.parse Problem

```typescript
// DANGEROUS - no runtime validation
const data = JSON.parse(raw) as ClientMessage;
// If raw is {"type": 42}, data.type is a number.
// TypeScript thinks it's a ClientMessage. It is not.
```

> **Warning**
>
> `as Type` is a type **assertion**, not a type **check**. It tells the compiler "trust me" and does not look at the value. Never use it on data from a socket, a file, an API, or a user. Chapter 9 said this and it is worth saying twice, because it is the single most common way a "fully typed" codebase turns out to be lying.

## The problem Chapter 9 left behind

Here is the honest version we shipped instead - and the reason it could not stay:

```typescript
const DECODERS: DecoderMap = {
  chat: (f) => (isString(f.text) ? { type: "chat", text: f.text } : null),
  join: (f) => (isString(f.room) ? { type: "join", room: f.room } : null),
  whisper: (f) =>
    isString(f.to) && isString(f.text) ? { type: "whisper", to: f.to, text: f.text } : null,
  // ...twelve of these
};
```

And, separately, the type it was supposed to be checking:

```typescript
export type ClientMessage =
  | { type: "chat"; text: string }
  | { type: "join"; room: RoomName }
  // ...twelve of these, again
```

**Two descriptions of the same thing.** Add a field to the type and the decoder still compiles. Add it to the decoder and the type still compiles. Neither knows the other exists. They agreed for five chapters because somebody remembered every single time - and "somebody remembered" is not a guarantee, it is a nice thing that has not stopped being true yet.

There was a third gap too, and it was never in the type system at all: `text: string` says nothing whatsoever about a client sending ten megabytes of it.

## Runtime Validation with Zod

```bash
npm install zod
```

```typescript
import { z } from "zod";

const UserSchema = z.object({
  name: z.string().min(1).max(50),
  age: z.number().int().positive(),
});

// Extract the TypeScript type FROM the schema
type User = z.infer<typeof UserSchema>;
// { name: string; age: number }

// safeParse returns a discriminated union - no exceptions
const result = UserSchema.safeParse(unknownData);
if (result.success) {
  result.data;          // User - validated, and a NEW object
} else {
  result.error.issues;  // what was wrong, and where
}
```

> **Tip**
>
> `z.infer<typeof Schema>` is the whole chapter. The schema is written once; the runtime check and the compile-time type are both *derived from it*. They cannot disagree, because there is no longer a second thing to disagree with.
>
> And note `safeParse` returns a `{ success: true, data } | { success: false, error }` - a discriminated union, exactly like the `Result` from Chapter 10. Zod arrived at the same shape for the same reason.

## The Protocol as a Schema

```typescript
const nickname = z.string().min(1).max(20).regex(/^[a-z0-9_-]+$/i, {
  message: "must be 1-20 characters: letters, digits, _ or -",
});

const roomName = z.string().min(1).max(32).regex(/^[a-z0-9-]+$/, {
  message: "must be lowercase letters, digits or hyphens",
});

// A megabyte of "a" is not a chat message, and `text: string`
// was never going to be the thing that noticed.
const chatText = z.string().min(1).max(1000);

export const ClientMessageSchema = z.discriminatedUnion("type", [
  message({ type: z.literal("chat"), text: chatText }),
  message({ type: z.literal("whisper"), to: nickname, text: chatText }),
  message({ type: z.literal("join"), room: roomName }),
  // ...
]);
```

And then, in `protocol.ts`, the twelve-arm hand-written union is replaced by one line:

```typescript
export type ClientMessage = z.infer<typeof ClientMessageSchema>;
export type ClientMessageType = ClientMessage["type"];
```

It is still a real discriminated union. Everything built on it in Chapters 9-13 keeps working, untouched: the `switch` in `handleMessage` still narrows, `assertNever` still guards it, `Extract<ClientMessage, { type: "join" }>` still picks one variant, and `CATALOG` is still a `Record<ClientMessageType, CommandInfo>` that will not compile if you add a message and forget to document it.

**124 lines came out of `protocol.ts`.** The decoder map, the `Fields` type, `isString`, `Decoder<K>`, `DecoderMap`, `KNOWN_TYPES`, and `validateNickname` are all gone, and nothing they did was lost.

> **Note**
>
> `z.discriminatedUnion` is not just a union of objects. It reads the literal `type` on each member and builds a lookup - so an unknown discriminant fails **once**, immediately, naming the twelve it knows, rather than attempting all twelve schemas and reporting twelve separate failures about a message that was only ever going to be one of them. A plain `z.union` would do the latter, and the error would be unreadable.

## Where the rules live now

`validateNickname` used to be a regex in `protocol.ts`, called by the handler, three modules away from the type that described the field it constrained. Now the rule is *attached to the field*:

```typescript
message({ type: z.literal("nick"), name: nickname }),
```

Nothing can accept a nickname without also enforcing what a nickname is. That is the difference between a rule you apply and a rule that is true - and it is why the handler's `nick` case got shorter without getting weaker:

```typescript
case "nick": {
  // message.name is already a well-formed nickname. The schema said so before
  // this function was called. What is left is the one question a schema cannot
  // answer: is there a person by that name?
  const user = registry.knownUsers.get(message.name);
  if (user === undefined) {
    throw new NotFoundError(`Unknown user "${message.name}". ...`, ErrorCode.UnknownUser);
  }
  ...
}
```

## Keeping Chapter 10's line

A schema fails for two very different reasons, and collapsing them would throw away something Chapter 10 worked for. So `protocol.ts` reads Zod's issue codes and decides which happened:

```typescript
const STRUCTURAL: ReadonlySet<string> = new Set([
  "invalid_type",       // wrong primitive, or a field that is not there
  "invalid_union",      // no variant matched - usually an unknown `type`
  "invalid_value",
  "invalid_key",
  "unrecognized_keys",  // a field we have never heard of, e.g. "txet"
]);

const structural = error.issues.some((issue) => STRUCTURAL.has(issue.code));
return structural ? new ProtocolError(message) : new ValidationError(message);
```

| | means | code |
|---|---|---|
| **ProtocolError** | "I could not read you." The shape is wrong. | `invalid_message` |
| **ValidationError** | "I read you, and no." The shape is right; the content is not. | `validation` |

That is not pedantry. One means the client's **code** is broken and a developer has to look at it. The other means the client's **user** typed something we will not take, and they can simply try again. Different audiences, different codes - which is the argument `ErrorCode` was invented for in the first place.

Here is the whole matrix, run against the real decoder:

```
  valid chat             OK               {"type":"chat","text":"hello"}
  missing field          invalid_message  room: expected string, received undefined. Expected {"type":"join","room":"general"}
  wrong type             invalid_message  text: expected string, received number. ...
  unknown message type   invalid_message  type: Invalid discriminator value. Expected 'chat' | 'whisper' | 'join' | ...
  typo'd key             invalid_message  text: expected string, received undefined; Unrecognized key: "txet". ...
  not an object          invalid_message  Invalid input: expected object, received string.
  empty text             validation       text: Too small: expected string to have >=1 characters. ...
  text too long          validation       text: Too big: expected string to have <=1000 characters. ...
  nick with a space      validation       name: must be 1-20 characters: letters, digits, _ or -. ...
  UPPERCASE room         validation       room: must be lowercase letters, digits or hyphens. ...
  negative limit         validation       limit: Too small: expected number to be >0. ...
```

Every error code from Chapter 10 still comes back, from a validator that is now a hundred lines shorter and cannot drift from its type.

> **Warning**
>
> `.strict()` rejects unknown keys rather than silently dropping them, so `{"type":"chat","txet":"hi"}` names `txet` instead of quietly becoming a chat message with no text. That is a real trade, and worth making on purpose. The permissive rule - *ignore what you do not recognise* - is what lets a protocol evolve: an old server survives a new client sending a field it has never heard of. We give that up, and we can afford to, because **this server serves its own client** - `page.ts` is delivered over HTTP from the same port. They ship together and cannot skew. A protocol with clients you do not control should think much harder before choosing this.

## Manual vs Zod

| Approach | Pros | Cons |
|---|---|---|
| `as Type` | Zero code | No validation. Lies to the compiler. |
| Manual checks | No dependency; explicit | Type and check are two things that must be kept in step by hand |
| **Zod** | Schema **is** the type; constraints the type cannot express; errors with paths | A dependency; and a schema you can no longer read at a glance |

The middle row is what we had, and it was not *wrong* - it was correct for five chapters. It was simply carrying an obligation that a schema does not have.

## Putting It Together

`src/schemas.ts` is new: the protocol as a schema. `src/protocol.ts` on the `chapter14` branch infers `ClientMessage` from it and decodes with `safeParse`.

The protocol described once, as a Zod discriminated union. `z.infer` turns this into the `ClientMessage` type, and `safeParse` validates against it - one source of truth for both:

```typescript
export const ClientMessageSchema = z.discriminatedUnion("type", [
  message({ type: z.literal("chat"), text: chatText }),
  message({ type: z.literal("whisper"), to: nickname, text: chatText }),
  message({ type: z.literal("join"), room: roomName }),
  message({ type: z.literal("leave") }),
  message({ type: z.literal("nick"), name: nickname }),
  message({ type: z.literal("who") }),
  message({ type: z.literal("rooms") }),
  message({ type: z.literal("history"), limit: z.number().int().positive().max(500).optional() }),
  message({ type: z.literal("kick"), target: nickname, reason: z.string().min(1).max(200) }),
  message({ type: z.literal("status") }),
  message({ type: z.literal("help") }),
  message({ type: z.literal("quit") }),
]);
```

> **Tip**
>
> The complete, runnable file is `src/schemas.ts` on the `chapter14` branch. You are not meant to paste it wholesale - build your own as you follow along, and use the reference to check yourself.

## Try It

```bash
npm run build && npm start
```

The old errors, unchanged:

```json
{"type":"jion","room":"general"}
{"type":"join"}
```
```json
{"type":"error","code":"invalid_message","message":"type: Invalid discriminator value. Expected 'chat' | 'whisper' | 'join' | 'leave' | 'nick' | 'who' | 'rooms' | 'history' | 'kick' | 'status' | 'help' | 'quit'."}
{"type":"error","code":"invalid_message","message":"room: Invalid input: expected string, received undefined. Expected {\"type\":\"join\",\"room\":\"general\"}"}
```

And the new ones - the constraints that were never expressible as types:

```json
{"type":"chat","text":"<five thousand characters>"}
{"type":"join","room":"General"}
{"type":"chat","txet":"typo"}
```
```json
{"type":"error","code":"validation","message":"text: Too big: expected string to have <=1000 characters. ..."}
{"type":"error","code":"validation","message":"room: must be lowercase letters, digits or hyphens. ..."}
{"type":"error","code":"invalid_message","message":"text: expected string, received undefined; Unrecognized key: \"txet\". ..."}
```

That last one is worth pausing on. Before this chapter, `{"type":"chat","txet":"typo"}` failed with `malformed "chat" message` - true, and useless. Now it names the key you fat-fingered.

## Exercise

1. Add a `"topic"` message: `{ type: "topic", room, text }`, where the topic is at most 120 characters. Add it to `ClientMessageSchema` and run `npm run typecheck`. Count how many places the compiler sends you - and notice that the *validator* was not one of them.
2. Delete `.strict()` from the `message()` helper. Send `{"type":"chat","text":"hi","admin":true}`. What happens, and what would have to be true of your clients for that to be the behaviour you want?
3. Zod's regex message for a bad nickname is ours (`must be 1-20 characters...`); the message for a too-long one is Zod's (`Too big: expected string...`). Give `.max(20)` a custom message too. Which reads better to somebody who is not a programmer?
4. Move the `STRUCTURAL` set into `errors.ts` and write a test for it: for each of the twelve error cases in this chapter, assert the code that comes back. This is the test that stops a Zod upgrade from silently reclassifying your errors.
5. `z.coerce.number()` is used for the port, and coercion is usually a bad idea. Why is it defensible *there* and not for, say, `{"type":"history","limit":"10"}`?

## What's Next

The protocol is described once. The type, the validator, the size limits, the naming rules and the error messages all come from that one description, and there is nothing left to keep in step by hand.

The server is now, in a real sense, finished as a *program*: it has a protocol, a boundary, persistence, modules, and a router. What it does not have is a clear-eyed account of the machine it runs on. Next: **the Node.js runtime** - the event loop, `EventEmitter`, Buffers, and process lifecycle. Much of it this server has been quietly relying on since Chapter 5, and it is time to say out loud what has actually been happening.

---

Source: <https://purphoros.com/howto/typescript/json-validation>
