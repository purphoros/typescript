# Chapter 11 - Modules & Project Structure

`index.ts` reached 1,435 lines. It held the domain types, the config, three classes, the event bus, the HTTP parser, the browser page, the message handler, the socket lifecycle and the process signal handlers. Every one of those is a different job, and the file had no opinion about which was which.

This chapter gives the program a shape. Sixteen files, each with one job, and - this is the part that matters - an import graph that only points one way.

## ES Modules: import and export

TypeScript uses ES module syntax - `import` and `export`:

```typescript
// Named exports - export specific items
export function formatDuration(ms: number): string { ... }

export interface User {
  id: string;
  name: string;
}

export const HISTORY_ON_JOIN = 5;

// Import named exports - curly braces, exact names
import { formatDuration, HISTORY_ON_JOIN } from "./config.js";
import type { User } from "./types.js";
```

> **Warning**
>
> Use `.js` extensions in relative import paths - even though the source files are `.ts`. You are writing the path the *emitted* file will use, and after `tsc` runs, `./config.ts` is `./config.js`. TypeScript does not rewrite import paths; what you type is what ships.
>
> This is required under ESM, and this chapter is where it starts to bite - because this chapter is where the package *becomes* ESM. See below.

### `import type`, and why it is not decoration

```typescript
import { ChatRoom } from "./model.js";        // a class: exists at runtime
import type { ChatClient } from "./types.js"; // an interface: gone at runtime
```

`import type` tells the compiler this import vanishes from the output entirely. That is not a micro-optimisation - it is sometimes the only thing standing between you and a cycle. A type-only import cannot cause a module to be loaded, so two modules may freely refer to each other's *types* even when they must never require each other's *code*. You will use this the first time two modules genuinely need to know about each other's shapes.

## The package becomes ESM

Here is something worth stopping on, because the previous chapters got away with a lie.

Chapter 10's imports had no `.js` extensions, and they compiled. That looks like it contradicts the warning above - and it does not, because `package.json` had no `"type"` field. Without it, Node treats `.js` files as **CommonJS**, `"module": "Node16"` resolves them the CommonJS way, and extensionless imports work because `require()` has always guessed at extensions for you.

We were writing ESM syntax and shipping CommonJS. It worked, and it meant every rule about module resolution was a rule about a system we were not actually using.

So this chapter makes it real:

```json
{
  "type": "module",
  "main": "dist/index.js",
  "bin":  { "chat-server": "dist/main.js" },
  "scripts": {
    "dev":   "tsx watch src/main.ts",
    "start": "node dist/main.js"
  }
}
```

Now `.js` extensions are mandatory, `import` is a real `import`, and top-level `await` is available - which Chapter 12 will want almost immediately.

## Default Exports vs Named Exports

```typescript
// Default export - one per file, any name on import
export default class ChatServer { ... }
import ChatServer from "./server.js";     // any name works
import Banana from "./server.js";         // ...including this one

// Named export - exact names, enforced
export class ChatServer { ... }
import { ChatServer } from "./server.js";
```

**Prefer named exports**, and this codebase uses nothing else. A default export has no name at the definition site, so every importer invents one, and now `grep ChatServer` no longer finds the file that imports it as `Server`. Rename a named export and every import breaks loudly, which is what you want - a rename that does not break anything is a rename you cannot trust.

## The Shape

```
src/
├── main.ts        ← entry point: build config, construct server, start it
├── index.ts       ← barrel: the public API. No side effects.
│
├── config.ts      ← ServerConfig, DEFAULTS, resolvePort
├── errors.ts      ← Result, ErrorCode, ChatError hierarchy, toSafeError
├── protocol.ts    ← ClientMessage, ServerMessage, decode/encode, validators
├── events.ts      ← TypedEmitter<T>, RingBuffer<T>, pluck - generic, domain-free
├── types.ts       ← the domain: ChatClient, User, Message. No behaviour.
│
├── model.ts       ← ChatRoom, ChatMessage. Know nothing of sockets.
├── state.ts       ← Registry: who is here, what rooms exist, the lookups
├── views.ts       ← projections: internal object → wire shape
├── bus.ts         ← ServerEvents map, ChatEvent, and every listener
├── handler.ts     ← MessageHandler: the chat rules. No socket anywhere.
│
├── clients.ts     ← BaseClient, TcpClient, WsClient - the two transports
├── page.ts        ← the browser client (a string)
├── http.ts        ← HttpService: parse, route, respond
└── server.ts      ← ChatServer: sockets, sniffing, the upgrade, lifecycle
```

The load order falls out of the imports, and it is a straight line:

```
events → errors → protocol → types → model → config → state → bus
       → clients → views → handler → page → http → server → index → main
```

**Nothing imports anything above it.** `events.ts` and `errors.ts` import nothing at all. `page.ts` imports nothing at all - it is a function that returns a string, and Chapter 10 had it reaching into the `clients` and `rooms` globals to count them, which meant a function about HTML could not be called without a running server. Now it takes two numbers.

> **Tip**
>
> A cycle in an import graph is not a style problem, it is a runtime bug waiting for the right entry point. When A imports B and B imports A, one of them runs first and sees the other half-initialised - its exports are `undefined`, its classes are not yet classes. It works until someone imports the pair from a new direction, and then it fails with an error that names neither module.
>
> Chapter 10 already met this and dodged it: `ErrorCode` moved from `protocol.ts` to `errors.ts` because the error classes carry the code, so `protocol` must import `errors`, and `errors` therefore must not import `protocol`. That was not filing. It was the only arrangement that runs.

## The Seam

Read the imports of `handler.ts`:

```typescript
import { HISTORY_ON_JOIN } from "./config.js";
import { asError, ChatError, NotFoundError, PermissionError, ... } from "./errors.js";
import { assertNever, CATALOG, COMMANDS, decodeClientMessage, ... } from "./protocol.js";
import { ChatMessage, type ChatRoom } from "./model.js";
import { isAdmin, type ChatClient } from "./types.js";
import { describeClient, describeRoom, summarize } from "./views.js";
import type { Bus } from "./bus.js";
import type { Registry } from "./state.js";
```

No `node:net`. No `ws`. No Buffer, no socket, no port. Every chat rule in this server - who may kick whom, what a join replays, which failures get which code - lives in a module that **could not open a connection if it wanted to**. It accepts a `ChatClient`, which is an interface, and `handleLine(client, line)`, which is a string.

That is not tidiness. That is the whole return on the chapter, and here is what it buys:

```typescript
class FakeClient implements ChatClient {
  readonly outbox: ServerMessage[] = [];
  send(m: ServerMessage) { this.outbox.push(m); }
  // ...the rest of the interface
}

const registry = new Registry(configure(DEFAULTS, {}));
const handler = new MessageHandler(registry, createBus(registry));
const client = new FakeClient();

handler.welcome(client);
handler.handleLine(client, '{"type":"nick","name":"alice"}');
handler.handleLine(client, '{"type":"join","room":"general"}');
handler.handleLine(client, '{"type":"chat","text":"no socket was harmed"}');
handler.handleLine(client, '{"type":"join","room":"nowhere"}');
```

```json
{"type":"welcome","id":"fake1","transport":"tcp","text":"Welcome. You are fake1. ..."}
{"type":"system","text":"You are now alice. You are an admin (level 2)."}
{"type":"joined","user":"alice","room":"general","members":1}
{"type":"history","room":"general","messages":[]}
{"type":"chat","sender":"alice","text":"no socket was harmed","room":"general","at":...}
{"type":"error","code":"unknown_room","message":"No such room \"nowhere\". Try: general, random, dev"}
```

The entire rule set, exercised against a client that is an array. No port was opened. The handler cannot tell. **If a rule can only be tested by opening a socket, the rule is in the wrong file** - and Chapter 19 will collect on this.

## Classes, and the singleton nobody decided to write

Chapters 5-10 kept the server's state in module-level `const`s:

```typescript
const rooms = new Map<RoomName, ChatRoom>();
const clients = new Map<string, ChatClient>();
let sequence = 0;
```

That is a singleton. Nobody chose it - it arrived because there was one file and one server, and those two facts held hands. They stop holding hands the moment you want a *second* server, and you will: once per test, in about eight chapters.

So the state is a `Registry` you construct, and the server is a `ChatServer` you construct, and the handler takes both as constructor arguments rather than importing them:

```typescript
export class MessageHandler {
  constructor(
    private readonly registry: Registry,
    private readonly bus: Bus,
  ) {}
}
```

Give it a different registry and it manages a different world. That is the whole trick, and it is one keyword - `constructor` instead of `import`.

## Barrel Files

A **barrel** re-exports a package's public API from one place, so consumers write `import { ChatServer } from "chat-server"` rather than reaching into `chat-server/dist/server.js` and taking whatever they find. It is the difference between a package with a front door and a package with a hole in the wall.

```typescript
// src/index.ts
export { ChatServer } from "./server.js";
export { ChatError, ErrorCode, ok, err } from "./errors.js";
export type { ClientMessage, ServerMessage } from "./protocol.js";
```

> **Warning**
>
> **A barrel is not an entry point, and this chapter's source splits them.** The two jobs are in direct conflict: an entry point *does* something when you run it - binds a port, installs signal handlers - and a barrel must do **nothing at all** when you import it. Put both in `index.ts` and `import { ClientMessage } from "chat-server"` starts a chat server as a side effect, which is a very strange thing to happen to someone who only wanted a type.
>
> So `main.ts` is the entry point (`npm start` runs it, `bin` points at it) and `index.ts` is the barrel (`main` and `exports` point at it, and importing it does nothing). Note also `export type` on the type-only lines: it tells the compiler those vanish rather than becoming a runtime `require` for a value that does not exist.

## Putting It Together

The point of this chapter is the *shape*, shown in The Shape and The Seam above. Rather than reprint all sixteen files, here is the one that ties them together; the rest are on the `chapter11` branch.

The entry point, in full - it builds a config, constructs a server, starts it, and installs the last-net handlers. That is all:

```typescript
// The entry point. It builds a config, constructs a server, and starts it.
//
// That is all it does, and the shortness is the entire result of the chapter.
// Chapter 10's index.ts was 1,435 lines and did every job in the program. This
// file does one: it decides what to run and runs it.
//
// It is `main.ts`, not `index.ts`, and that is deliberate - see index.ts, which
// is the barrel. A file that *starts a server when you import it* cannot also be
// the file you import to get at the types.

import { configure, DEFAULTS, resolvePort } from "./config.js";
import { describeThrown } from "./errors.js";
import { ChatServer } from "./server.js";

const config = configure(DEFAULTS, { port: resolvePort(process.argv[2]) });
const server = new ChatServer(config);

// The last net, and it is worth being clear about what it is for.
//
// It is not a second error boundary. The boundary is in handler.ts, where there
// is still a client to answer and one request to abandon. By the time a throw
// gets here, nobody knows what was half-done - a room joined but not announced,
// a buffer consumed but not parsed - and a process running on state it cannot
// describe is worse than a process that stopped. So: say something useful, then
// die honestly. Restarting is somebody else's job, and they are better at it.
process.on("uncaughtException", (error: Error) => {
  console.error(`FATAL - nothing caught this: ${describeThrown(error)}`);
  process.exit(1);
});

process.on("unhandledRejection", (reason: unknown) => {
  console.error(`FATAL - a promise rejected with nobody listening: ${describeThrown(reason)}`);
  process.exit(1);
});

// Ctrl-C: stop accepting connections, hang up on everyone, then exit.
process.on("SIGINT", () => {
  server.shutdown(() => process.exit(0));
});

server.listen(() => {
  for (const line of server.banner()) {
    console.log(line);
  }
});
```

> **Tip**
>
> Read `src/handler.ts` on the branch and notice its imports: no `node:net`, no `ws`, no socket. That is the seam - the chat rules could not open a connection if they wanted to, which is what makes them testable without one.
## Try It

Nothing about the server's behaviour changed, and that is the claim to check:

```bash
npm run build && npm start
```

```bash
nc 127.0.0.1 8080
{"type":"nick","name":"alice"}
{"type":"join","room":"general"}
{"type":"chat","text":"hello everyone"}
```

Same protocol, same errors, same codes, same browser page, same `/api/crash` returning a bare 500 while the log keeps the stack. A refactor that changes behaviour is not a refactor, it is a rewrite with good PR.

What *has* changed is what you can now do to it. Import the handler on its own and drive it with a fake client, as above - no port, no `ws`, no waiting.

## Exercise

1. Add a cycle on purpose: `import { Registry } from "./state.js"` inside `types.ts`. It typechecks. Run it and watch what happens, then work out *why* the error message names neither file.
2. Fix that cycle with `import type` instead. It now works. Explain in one sentence why - what does a type-only import not do?
3. Move `formatDuration` out of `handler.ts` into a new `format.ts`. Which modules had to change? If the answer is "more than one", ask whether it was in the right place to begin with.
4. Write a second `FakeClient` and have two of them talk to one `MessageHandler`. Assert that a `chat` from one lands in the other's outbox. You have just written a broadcast test with no network in it.
5. Delete the `bin` and `main` fields from `package.json` and run `npm start`. Then put back only `main`, pointing at `dist/main.js`, and `import { ChatError } from "."` in a scratch file. What happens, and why is that the argument for splitting the barrel from the entry point?

## What's Next

The codebase has a shape. Each file has one job, the import graph is a straight line, and the chat rules can be exercised without a socket - which is the property every later chapter will lean on.

Everything so far has been synchronous. `handleLine` runs top to bottom and returns; nothing waits for anything. That ends the moment history has to survive a restart, and history has to survive a restart. Next: **async/await and Promises** - `Promise<T>`, the error handling that changes shape when a function goes async, and the four ways to wait for more than one thing at once.

---

Source: <https://purphoros.com/howto/typescript/modules>
