# Chapter 19 - Testing

Every chapter of this tutorial has ended the same way: run the server, open `nc`, type JSON at it, read what came back. That works. It does not scale, it is not repeatable, and it only ever tests what I remembered to type.

Chapter 11 made a promise about this, and it is time to collect.

```bash
npm install --save-dev vitest
npm test
```

```
 Test Files  6 passed (6)
      Tests  56 passed (56)
```

## The test double that fakes only the wire

`MessageHandler` accepts a `ChatClient` - an **interface**. It has no `node:net`, no `ws`, no Buffer. That was Chapter 11's whole argument, and this is what it was for:

```typescript
export class FakeClient extends BaseClient {
  readonly outbox: ServerMessage[] = [];

  send(message: ServerMessage): void { this.outbox.push(message); }
  end(message: ServerMessage): void  { this.outbox.push(message); this.markClosing(); }
  get backlog(): number { return 0; }        // never behind: there is no wire
  protected destroy(): void { this.markClosed(); }
}
```

**Look at what it extends.** `FakeClient` is a subclass of the real `BaseClient`, so it inherits the real state machine, the real `label`, the real transitions - everything from Chapter 16 that decides whether you may enter a room. Only the two methods that put bytes on a wire are replaced.

That distinction is the difference between a useful test double and a useless one. **Reimplement the logic in your fake and you are testing your fake.** Fake only the *edge*, and everything above it is the code that actually ships.

```typescript
it("delivers a message from one client to another", async () => {
  const alice = arrive(handler, 1);
  const bob = arrive(handler, 2);
  await loggedIn(handler, alice, "alice", "correct-horse");
  await loggedIn(handler, bob, "bob", "hunter2");
  await say(handler, alice, { type: "join", room: "general" });
  await say(handler, bob, { type: "join", room: "general" });
  bob.clear();

  await say(handler, alice, { type: "chat", text: "hello everyone" });

  expect(bob.last("chat")?.sender).toBe("alice");
});
```

Real login. Real scrypt. Real JWT. Real rooms, real broadcast, real middleware chain. **No port.** The whole file runs in 600ms.

> **Tip**
>
> The first draft of that test failed, and it was right to. I built `FakeClient` directly instead of calling `handler.welcome(client)` - so the client was never in the registry, received no broadcasts, and could not be whispered to. Which is *exactly* what would happen to a real socket the server had not been introduced to. The fake was faithful enough to reproduce a bug in my test setup, which is a good sign about the fake.

## The tests worth having are regressions for bugs you shipped

Anyone can write `expect(2 + 2).toBe(4)`. The tests that earn their keep are the ones that would have caught the bugs this tutorial **actually shipped and had to fix**.

**Chapter 16 - the membership leak.** Rooms keyed membership on `client.label`, which is a nickname, which changes:

```typescript
it("does not leak room membership when a client renames", async () => {
  const client = arrive(handler, 1);

  await loggedIn(handler, client, "bob", "hunter2");
  await say(handler, client, { type: "join", room: "general" });
  expect(registry.rooms.get("general")?.memberCount).toBe(1);

  await loggedIn(handler, client, "alice", "correct-horse");   // rename, in place
  expect(registry.rooms.get("general")?.memberCount).toBe(1);  // not 2

  await say(handler, client, { type: "leave" });
  expect(registry.rooms.get("general")?.memberCount).toBe(0);  // not 1
});
```

**Chapter 12 - the restamped archive.** `load()` rebuilt history with `new ChatMessage(...)`, whose constructor stamps `Date.now()`, so every restart relabelled the entire archive with the boot time:

```typescript
it("restores a message with its ORIGINAL timestamp", () => {
  const then = 1_600_000_000_000;
  const restored = ChatMessage.restore({ sender: "alice", text: "old", room: "general", at: then });
  expect(restored.at).toBe(then);
});
```

**Chapter 12 - ordering.** `await` took away what a `for` loop gave for free:

```typescript
it("runs tasks strictly in the order they were submitted", async () => {
  const queue = new Serializer();
  const order: number[] = [];
  const results = [30, 5, 20, 1].map((ms, i) =>
    queue.run(async () => { await delay(ms); order.push(i); }),
  );
  await Promise.all(results);
  expect(order).toEqual([0, 1, 2, 3]);   // NOT [3, 1, 2, 0]
});
```

And a test for a fact that surprises people:

```typescript
it("does NOT cancel the loser - a Promise cannot be un-started", async () => {
  let finished = false;
  const work = delay(60).then(() => { finished = true; return "done"; });
  await expect(withTimeout(work, 10, "x")).rejects.toThrow(TimeoutError);
  expect(finished).toBe(false);   // not yet
  await delay(80);
  expect(finished).toBe(true);    // it kept running. Nobody was listening.
});
```

> **Note**
>
> **Prove your regression tests can fail.** I reintroduced both bugs - put `client.label` back into `room.leave`, took `ChatMessage.restore` back out - and re-ran the suite:
>
> ```
> × MessageHandler > does not leak room membership when a client renames
> × ChatRoom > restores a message with its ORIGINAL timestamp
> ```
>
> Then restored the fixes and got 56 green. A regression test you have never watched fail is a test you are trusting on faith. It takes ninety seconds to check, and the alternative is a suite full of assertions that were quietly rewritten into tautologies during a refactor.

## The security tests

These are the ones that would actually stop a breach:

```typescript
it("refuses the alg:none forgery", () => {
  const forged =
    b64({ alg: "none", typ: "JWT" }) + "." +
    b64({ sub: "u1", name: "alice", admin: true, iat: 0, exp: 9999999999 }) + ".";
  expect(verify(forged, SECRET).ok).toBe(false);
});

it("gives the same answer for a wrong password and an unknown user", async () => {
  await say(handler, a, { type: "login", name: "alice",   password: "wrong" });
  await say(handler, b, { type: "login", name: "mallory", password: "wrong" });
  expect(a.last("error")?.message).toBe(b.last("error")?.message);
});

it("is not encrypted - anyone holding it can read every claim", () => {
  const payload = JSON.parse(Buffer.from(token.split(".")[1]!, "base64url").toString());
  expect(payload.name).toBe("alice");   // this is the point, not a bug
});
```

That last one is a test asserting a **weakness**, on purpose. It is executable documentation: it will fail the day somebody "fixes" it by encrypting the payload, and the failure will make them read the comment explaining why it is not encrypted.

## What tests cannot do

Chapter 17 built a constant-time signature comparison. Now go and replace it:

```typescript
if (signature === expected) { ... }   // instead of timingSafeEqual
```

**Every test in this suite still passes.** All 56.

You have reintroduced a timing side channel - a real, exploitable vulnerability - and the test suite is bright green, because a test asserts *what* a function returns and this bug is about *how long it took*. No assertion you are likely to write will ever catch it.

This is not an argument against testing. It is an argument against believing a green suite means the code is correct. **A test suite tells you the things you thought to check are still true.** It does not tell you the code is safe. Some properties - timing, memory growth, what a stranger can make your server hold - are simply not in the shape a test has.

## Interlude: the test runner does not compile your code the way your compiler does

Adding the tests broke the tests, and the failure said this:

```
SyntaxError: Invalid or unexpected token
```

No file. No line. No clue. It took bisecting the import graph to find that the offending token was `@timed` - the decorator added one chapter ago.

Vitest transforms TypeScript with **esbuild**, whose default target is `esnext`. `esnext` is assumed to support decorators *natively*, so esbuild helpfully left `@timed` exactly where it found it - and Node 22 does not support decorators natively. Meanwhile `tsc`, which does `npm run build`, had been compiling them away all along.

```typescript
// vitest.config.ts
export default defineConfig({
  esbuild: { target: "es2022" },   // a target WITHOUT decorators, so they get lowered
  test: { include: ["src/**/*.test.ts"] },
});
```

The build and the tests now agree about what the language is. That is the actual lesson, and it is worth more than the fix: **your test runner has its own compiler, and it does not necessarily agree with yours.**

(Worth knowing: newer Vite builds on rolldown/oxc rather than esbuild, and that pipeline does not lower standard decorators at all. This project pins the esbuild line for exactly that reason.)

## Putting It Together

The test double is the whole point: it fakes only the wire. Everything above it is the code that ships. It is on the `chapter19` branch.

`FakeClient` subclasses the real `BaseClient`, so it inherits the real state machine - only the two methods that touch a wire are replaced, and they push onto an array:

```typescript
export class FakeClient extends BaseClient {
  // Every message the server tried to send this client, in order. A socket, if
  // you like, that only ever writes to an array.
  readonly outbox: ServerMessage[] = [];

  constructor(sequence = 1) {
    super(clientId(`f${sequence}`), "tcp", ConnectionState.Connected);
    this.markConnected();
  }

  send(message: ServerMessage): void {
    this.outbox.push(message);
  }

  end(message: ServerMessage): void {
    this.outbox.push(message);
    this.markClosing();
  }

  // Never behind, because there is no wire to be behind on.
```

> **Tip**
>
> The complete, runnable file is `src/testing.ts` on the `chapter19` branch. You are not meant to paste it wholesale - build your own as you follow along, and use the reference to check yourself.

## Exercise

1. Replace `timingSafeEqual` with `===` in `jwt.ts`. All 56 tests pass. Now write a test that catches it. How many samples do you need, and would you trust the result on a laptop with a browser open?
2. `handler.test.ts` writes real files to `data-test-handler/`. Make `FileHistory` an interface and write an `InMemoryHistory`. The tests get faster - what did you stop testing?
3. Add a test for the Chapter 15 backpressure eviction. You will need a `FakeClient` whose `backlog` you can control. Notice that the *design* - `backlog` on the interface - is what makes it testable at all.
4. Run `npx vitest --coverage`. Find the line with the lowest coverage that you would be most upset to have wrong. Test that one. Ignore the percentage.
5. Delete `vitest.config.ts` and read the error. You now know something about your toolchain that most people find out at the worst possible moment.

## What's Next

The chat server has a test suite: 56 tests, no sockets, running in under a second - covering the decoder's error contract, the room lifecycle, async ordering, the typed router, both JWT forgeries, and regressions for every bug this tutorial shipped and fixed.

More importantly, it has a test suite that has been **watched to fail**, and an honest account of the vulnerability class it cannot see.

The server as it stands runs: one port, three protocols, a validated wire format, an error boundary that has never once let a stranger's typo take the process down, history that survives a restart, a bounded runtime, real passwords, and a door that is shut.

Next: **structured logging, config and a real command line** - because the server is now good enough to run somewhere you cannot watch it, and `console.log` is not.

---

Source: <https://purphoros.com/howto/typescript/testing>
