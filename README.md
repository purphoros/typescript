# Chapter 10 - Error Handling

Stop letting errors crash your server. Custom error classes, the Result pattern, error boundaries in event handlers, and error responses that tell a stranger enough to fix their message and nothing more.

Chapter 9 ended owing you two things, and admitted to both. `decodeClientMessage` returned `{ kind: "ok" } | { kind: "invalid"; reason: string }` - a hand-rolled union doing a job that has a name. And every failure inside `handleMessage` was a `fail(); return;` pair, written a dozen times in a dozen slightly different sentences, which is what a function looks like shortly before somebody forgets the `return`.

Both are gone by the end of this chapter. What replaces them is a choice you will make for the rest of your career, so it is worth making deliberately.

## try/catch with Typed Errors

JavaScript's `catch` clause receives `unknown` - not `Error`. Anything can be thrown: strings, numbers, objects, `null`. You must narrow before using error properties:

```typescript
try {
  JSON.parse("invalid json");
} catch (err: unknown) {
  // err is unknown - must narrow before using .message
  if (err instanceof Error) {
    console.error(err.message);  // "Unexpected token i..."
  } else {
    console.error("Non-Error thrown:", err);
  }
}
```

> **Warning**
>
> Never write `catch (err: Error)` - TypeScript requires `unknown` or `any` for catch parameters. Always use `unknown` and narrow with `instanceof`.

> **Tip**
>
> When you finally do stringify the unknown thing, use `String(err)` and not `` `${err}` ``. They look identical and they are not: interpolating a Symbol throws a TypeError. An error handler that throws while handling an error turns a bad afternoon into a long evening, and it will happen on the one input you never tested.

## Custom Error Classes

An `Error` with a message is a sentence. What you want is a *fact* - something a program can branch on and a wire can carry:

```typescript
class ChatError extends Error {
  constructor(
    message: string,
    public readonly code: string,
    public readonly statusCode: number = 400,
  ) {
    super(message);
    this.name = "ChatError";
  }
}

class AuthError extends ChatError {
  constructor(message: string) {
    super(message, "AUTH_FAILED", 401);
    this.name = "AuthError";
  }
}

// Handle with instanceof - narrows to the specific error type
function handleError(err: unknown): { code: string; message: string } {
  if (err instanceof AuthError) {
    return { code: err.code, message: err.message };
  }
  if (err instanceof ChatError) {
    return { code: err.code, message: err.message };
  }
  if (err instanceof Error) {
    return { code: "INTERNAL", message: err.message };
  }
  return { code: "UNKNOWN", message: String(err) };
}
```

The `code` is the point. A message is for a human and will be reworded next Tuesday; a code is for a program and must not be. Our `ChatError` carries a `code` *and* an HTTP `status`, because the same failure has to travel down two very different wires - an unknown room is a `ServerMessage` with code `"unknown_room"` to a chat client and a `404` to `curl`, and it should not take two error types to say one thing.

> **Warning**
>
> Most tutorials - and the first draft of this chapter - put `Object.setPrototypeOf(this, ChatError.prototype)` in every constructor, labelled "required for instanceof to work". It is required, and only when TypeScript is **downlevelling** classes. Compile `class X extends Error` to ES5 and the emitted function cannot build the prototype chain the way `new Error()` does, so `x instanceof X` comes back `false` and every `catch` in your program quietly stops recognising its own errors.
>
> We target ES2022 and emit real classes, where extending a built-in works exactly as written. `src/errors.ts` omits the line, and the `instanceof` checks in the boundary do fire - verify it yourself by throwing one. Set `"target": "ES5"` in `tsconfig.json` and you will need it back. Knowing *why* it is there is the difference between engineering and folklore.

## The Result Pattern

Exceptions are invisible in the type signature. A function that throws looks exactly like a function that does not, and the compiler will never once remind you. The **Result pattern** puts the failure in the return type, where it cannot be missed:

```typescript
// A generic Result: either a value or an error, never both
type Result<T, E = string> =
  | { ok: true; value: T }
  | { ok: false; error: E };

function parsePort(input: string): Result<number> {
  const port = Number.parseInt(input, 10);
  if (Number.isNaN(port) || port <= 0 || port > 65535) {
    return { ok: false, error: `Invalid port: ${input}` };
  }
  return { ok: true, value: port };
}

// The caller MUST look at `ok` before it can reach either field
const result = parsePort("abc");
if (result.ok) {
  console.log(result.value);   // number - TypeScript knows
} else {
  console.log(result.error);   // string - TypeScript knows
}
```

If that shape looks familiar, it should: it is a discriminated union, exactly like Chapter 9's, with `ok` as the discriminant. `Result` is not a new language feature. It is the pattern you already know, pointed at failure.

## Choosing Between Them

Here is the rule the server actually follows, and the reason both tools survive in one codebase.

**Return a `Result` when the failure is expected and the caller is right there.** Decoding a line off a socket. Validating a nickname. Parsing a port off the command line. These fail constantly - anyone can type anything into `nc` - and the code that must react is the code that called you. Put the failure in the type and it cannot be ignored the way a missing `try` can.

**Throw when the failure is expected and has to travel.** A room lookup fails eight frames down, inside one arm of a twelve-case switch. There is exactly one thing to do about it - tell this client - and it happens far away, at the boundary. Threading a `Result` up through every one of those cases would add a branch per case and change nothing about what happens.

Watch what that buys `handleMessage`. Every case is now the happy path:

```typescript
case "chat": {
  const room = requireRoom(client);          // throws StateError if you are nowhere
  bus.emit("message", new ChatMessage(client.label, message.text, room.name));
  return;
}

case "kick": {
  const user = client.user;
  if (user === undefined || !isAdmin(user)) {
    throw new PermissionError("Only admins may kick. Identify yourself first.");
  }
  const target = requireClient(message.target);   // throws NotFoundError
  if (target === client) {
    throw new PermissionError("You cannot kick yourself.");
  }
  bus.emit("kick", client, target, message.reason);
  return;
}
```

No `fail(); return;`. No error string written twice. `requireRoom` and `requireClient` say what they need, and the boundary deals with them not getting it.

And a third case, the one that actually kills servers: **something nobody predicted.** That is not modelled at all. It is caught, logged in full, and answered with a shrug.

> **Tip**
>
> The honest cost of `throw`: it is not in the signature and TypeScript cannot put it there. `handleMessage` throws and its type says `void`, and no compiler will ever warn a new caller. That is precisely why the failures a caller has to *branch on* are Results instead - you get to choose which functions lie about their failure modes, and the answer should be "as few as possible, all of them behind one boundary."

## Error Boundaries in Event Handlers

An unhandled throw inside a socket's `data` handler does not fail that request. It takes down the process - every other connected client with it. On a server whose entire job is reading things strangers typed, that is not a risk, it is a schedule.

So every line from every client, on either transport, passes through exactly one function, and nothing thrown below it escapes:

```typescript
function handleLine(client: ChatClient, line: string): void {
  try {
    const decoded = decodeClientMessage(line);
    if (!decoded.ok) {
      // An expected failure that arrived as a value. No throw, no catch -
      // the type said this could happen and here we are, handling it.
      client.send(toErrorMessage(decoded.error));
      return;
    }
    handleMessage(client, decoded.value);
  } catch (thrown: unknown) {
    if (!(thrown instanceof ChatError)) {
      // Not one of ours: a bug. The log gets the stack trace, because
      // someone has to fix this and it is not the person who typed.
      bus.emit("failure", client.label, asError(thrown));
    }
    client.send(toErrorMessage(thrown));
  }
}
```

The asymmetry in that `catch` is the whole security argument. **Our own errors are deliberate** - we wrote their messages knowing a stranger would read them, so `No such room "nowhere". Try: general, random, dev` goes out verbatim, and is genuinely helpful. **Anything else is a bug**, and the client is told `"Internal server error"` and not one character more:

```typescript
export function toSafeError(thrown: unknown): SafeError {
  if (thrown instanceof ChatError) {
    return { code: thrown.code, message: thrown.message, status: thrown.status };
  }
  return { code: ErrorCode.Internal, message: "Internal server error", status: 500 };
}
```

A stack trace handed to an attacker is a gift - file paths, library versions, sometimes the shape of a query. To everyone else it is noise. The one audience allowed the whole truth is the log.

> **Note**
>
> The HTTP side gets the same boundary, and it is the same code - `readHttp` catches, calls `toSafeError`, and uses the `status` where the chat side used the `code`. One error type, thrown from one helper, rendered two ways. `GET /api/rooms/nowhere` returns `404 {"error":"No such room \"nowhere\"...","code":"unknown_room"}` and a chat client asking for the same room gets a `ServerMessage` saying the same thing. That is the payoff for putting both fields on `ChatError`.

## The Last Net

```typescript
process.on("uncaughtException", (error: Error) => {
  console.error(`FATAL - nothing caught this: ${describeThrown(error)}`);
  process.exit(1);
});
```

This is **not** a second boundary, and the difference matters. The boundary in `handleLine` runs where there is still a client to answer and one request to abandon; everything else keeps working. By the time a throw reaches `uncaughtException`, nobody knows what was half-done - a room joined but not announced, a buffer consumed but not parsed. A process running on state it cannot describe is worse than a process that stopped, because it will now produce wrong answers confidently.

So: say something useful, then die honestly. Restarting is somebody else's job - systemd, Docker, Kubernetes - and they are much better at it than a `catch` block that has no idea what just happened.

## Putting It Together

`src/errors.ts` is new: `Result<T, E>`, the `ChatError` hierarchy, and the two functions that decide what a stranger is allowed to know. It is on the `chapter10` branch, along with the changes to `protocol.ts` (the decoder returns a `Result`) and `index.ts` (`handleMessage` throws, `handleLine` is the boundary). Here are the load-bearing pieces of `errors.ts`.

`Result<T, E>` is a discriminated union - a value or an error, never both. The caller must look at `ok` before it can reach either field:

```typescript
export type Result<T, E = ChatError> =
  | { ok: true; value: T }
  | { ok: false; error: E };

// `Result<T, never>` is assignable to any `Result<T, E>`: the error arm cannot
// be constructed, which is exactly what "this one succeeded" means.
export function ok<T>(value: T): Result<T, never> {
  return { ok: true, value };
}

export function err<E>(error: E): Result<never, E> {
  return { ok: false, error };
}
```

And the error hierarchy. Every deliberate failure carries a machine-readable `code` and an HTTP `status`, so the same error renders down two wires:

```typescript
export class ChatError extends Error {
  constructor(
    message: string,
    readonly code: ErrorCode,
    readonly status: number = 400,
  ) {
    super(message);
    // `new.target` is the constructor that was actually called with `new`, so a
    // NotFoundError gets name "NotFoundError" without every subclass repeating
    // itself.
    this.name = new.target.name;
  }
}

// The message did not survive decoding: not JSON, not an object, no `type`, an
// unknown `type`, or the right type with the wrong fields.
export class ProtocolError extends ChatError {
  constructor(message: string) {
    super(message, ErrorCode.InvalidMessage, 400);
  }
}

// The message decoded, and then said something we will not accept - a nickname
// with a space in it, a limit of -3. Well-formed, still wrong.
export class ValidationError extends ChatError {
  constructor(message: string) {
    super(message, ErrorCode.Validation, 422);
  }
}

// You asked for something that is not here: a room, a user, a person to whisper
// to. The code says which, because "not found" alone is not an answer.
export class NotFoundError extends ChatError {
  constructor(message: string, code: ErrorCode) {
    super(message, code, 404);
  }
}

// You are allowed to ask, and you are not allowed to have it.
export class PermissionError extends ChatError {
  constructor(message: string) {
    super(message, ErrorCode.NotPermitted, 403);
  }
}

// Nothing is wrong with the request; it simply makes no sense right now. You
// cannot leave a room you are not in.
export class StateError extends ChatError {
  constructor(message: string, code: ErrorCode = ErrorCode.NotInRoom) {
    super(message, code, 409);
  }
}
```

> **Tip**
>
> The complete, runnable file is `src/errors.ts` on the `chapter10` branch. You are not meant to paste it wholesale - build your own as you follow along, and use the reference to check yourself.

## Try It

```bash
npm run dev
```

Every failure now arrives with a code you can branch on:

```json
not json at all
{"type":"chat","text":"before joining"}
{"type":"join","room":"nowhere"}
{"type":"nick","name":"has a space"}
{"type":"whisper","to":"ghost","text":"hi"}
```

```json
{"type":"error","code":"invalid_message","message":"expected JSON, e.g. {\"type\":\"chat\",\"text\":\"hello everyone\"}"}
{"type":"error","code":"not_in_room","message":"Join a room first, e.g. {\"type\":\"join\",\"room\":\"general\"}"}
{"type":"error","code":"unknown_room","message":"No such room \"nowhere\". Try: general, random, dev"}
{"type":"error","code":"validation","message":"\"has a space\" is not a usable name: 1-20 characters, letters, digits, _ or - only."}
{"type":"error","code":"no_such_target","message":"Nobody here is called \"ghost\"."}
```

Now the same errors down the other wire:

```bash
curl -i http://127.0.0.1:8080/api/rooms/nowhere    # 404, code "unknown_room"
```

And the one that matters. `/api/crash` throws a plain `Error` on purpose - it is left in the source precisely so you can watch the boundary hold:

```bash
curl -i http://127.0.0.1:8080/api/crash
```

```
HTTP/1.1 500 Internal Server Error
{ "error": "Internal server error", "code": "internal" }
```

The client learns nothing. The server log, meanwhile, gets the whole stack:

```
[SYSTEM] GET /api/crash failed - Error: the kind of bug you did not see coming
    at handleRequest (src/index.ts:...)
```

And then - the entire point - the next request is served as if nothing happened:

```bash
curl http://127.0.0.1:8080/api/status    # 200. Still running.
```

## Exercise

1. Send `{"type":"nick","name":"a-name-far-too-long-to-be-reasonable"}` and read the code you get back. Now send `{"type":"nick","name":"carl"}`. Why is one a `validation` error and the other `unknown_user`? Which one is a `Result` and which is a `throw`, and would you have chosen the same way?
2. Add a `RateLimitError` (code `rate_limited`, status `429`). Refuse more than five messages a second from one client. Notice that you write no new plumbing at all - the boundary already knows how to render it down both wires.
3. Delete the `try`/`catch` from `handleLine`, then send `{"type":"join","room":"nowhere"}`. Watch the whole server die because one person made one typo. Put it back.
4. In `toSafeError`, return `thrown.message` for *every* error rather than just `ChatError`s. Hit `/api/crash` again and read what a stranger can now see. This is the bug, in miniature, that leaks database schemas.
5. `handleMessage` throws and its signature says `void`. Write a `Result`-returning version of one case and compare. Which one would you rather read? Which one would you rather *maintain* after someone adds a thirteenth message type?

## What's Next

Error handling is no longer an afterthought bolted onto the happy path. Failures that a caller must branch on are `Result`s, and the type system enforces it. Failures that must travel are `ChatError`s, and one boundary renders them to whichever wire the client happens to be on. Bugs are caught, logged in full, and answered with a sanitised shrug. The server stays up.

Along the way, `src/` quietly became four files with a dependency order that is no longer accidental - `errors ← protocol ← index`, plus `events` off to one side - and we had to think about import cycles for the first time. That is the next chapter: **modules and project structure**, where `index.ts` stops being a thousand lines and becomes a program with a shape.

---

Source: <https://purphoros.com/howto/typescript/error-handling>
