# Chapter 12 - Async/Await & Promises

Node.js is asynchronous by nature. Promises and async/await let you write asynchronous code that reads like synchronous code - no callback hell.

Everything in this server so far has run to completion the moment it was called. Nothing has ever waited for anything. That ends here, because history has to survive a restart, and a disk does not answer immediately.

Almost everything difficult in this chapter comes from that one fact.

## Callbacks → Promises → async/await

```typescript
// 1. Callbacks (the old way - "callback hell")
fs.readFile("data.json", (err, data) => {
  if (err) { console.error(err); return; }
  fs.readFile("more.json", (err2, data2) => {
    if (err2) { console.error(err2); return; }
    // nested deeper and deeper...
  });
});

// 2. Promises (better - chainable)
fs.promises.readFile("data.json")
  .then(data => fs.promises.readFile("more.json"))
  .then(data2 => console.log(data2))
  .catch(err => console.error(err));

// 3. async/await (best - reads like sync code)
async function loadData(): Promise<string> {
  const data = await fs.promises.readFile("data.json", "utf-8");
  const more = await fs.promises.readFile("more.json", "utf-8");
  return data + more;
}
```

`async`/`await` is syntactic sugar over Promises. An `async` function always returns a `Promise`. `await` pauses that function until the Promise settles - but does **not** block the thread. Other connections keep being served while one of them waits for a disk.

## Promise&lt;T&gt; - The Typed Asynchronous Value

```typescript
// Promise<T> is the async equivalent of T
async function recent(room: string, limit: number): Promise<MessageSummary[]> {
  const all = await this.read(room);
  return all.slice(-limit);
}

const messages = await history.recent("general", 20); // MessageSummary[]
```

> **Note**
>
> `Promise<T>` is the async equivalent of `T`. A function returning `Promise<string>` is a function returning `string`, later. `await` unwraps it: `await Promise<string>` gives you `string`. That is the whole type story, and it is genuinely that simple. The type system is not where async gets hard.

## Error Handling in Async Code

Here is the gift, and it is easy to walk straight past it. This is the error boundary from Chapter 10:

```typescript
async handleLine(client: ChatClient, line: string): Promise<void> {
  try {
    const decoded = decodeClientMessage(line);
    if (!decoded.ok) {
      client.send(toErrorMessage(decoded.error));
      return;
    }
    await this.handleMessage(client, decoded.value);
  } catch (thrown: unknown) {
    if (!(thrown instanceof ChatError)) {
      this.bus.emit("failure", client.label, asError(thrown));
    }
    client.send(toErrorMessage(thrown));
  }
}
```

It went `async`, and **the try/catch did not change one character**. A rejected `await` throws *at the await*, so the same `catch` that has been handling synchronous failures since Chapter 10 now also handles a disk that is on fire. Compare the `.then().catch()` version, where the failure path is a different mechanism, in a different place, from the success path.

> **Warning**
>
> `return this.route(request)` inside a `try` is a bug. The function returns the Promise and *then* the try block exits - so when that Promise later rejects, the `catch` is long gone and the rejection escapes. You need `return await this.route(request)`. It is the one place a "redundant" await is doing essential work, and linters that flag `no-return-await` will confidently tell you to delete it. `src/http.ts` has the comment.

## The Four Combinators

| Method | Behaviour | Use case |
|---|---|---|
| `Promise.all` | All succeed, or first failure kills it | Load N things you need all of |
| `Promise.race` | First to settle, win or lose | Timeouts |
| `Promise.allSettled` | Wait for all, never rejects | Best-effort, partial results are fine |
| `Promise.any` | First success, ignores failures | Fallback providers |

The server uses three of them, and *which* one is the entire decision each time.

**`Promise.all` - reading every room's archive** (`http.ts`). Three files, none depending on any other. The sequential version reads them one after another and takes as long as all three added up, for no reason. `all` starts all three and waits for the slowest. It fails fast, and here that is correct: this endpoint promises the whole archive, and two thirds of the archive is not a smaller success - it is a wrong answer delivered confidently.

```typescript
const perRoom = await Promise.all(
  [...registry.rooms.keys()].map((room) => this.history.recent(room, 10)),
);
```

**`Promise.allSettled` - loading history at startup** (`server.ts`). Same three files, opposite answer. With `all`, one corrupt `dev.jsonl` means the server refuses to start, taking `general` and `random` down over a room nobody was using. Starting with an empty `dev` and saying so out loud is strictly better. `allSettled` never rejects, so the caller is *forced* to look at each result and decide - which is exactly the decision being made:

```typescript
const results = await Promise.allSettled(
  rooms.map((room) => this.history.recent(room.name, this.config.historyLimit)),
);

results.forEach((result, index) => {
  if (result.status === "rejected") {
    this.bus.emit("failure", `load ${room.name}`, asError(result.reason));
    return;                       // this room starts empty. Carry on.
  }
  for (const message of result.value) {
    room.remember(ChatMessage.restore(message));
  }
});
```

**`Promise.race` - the write timeout** (`async.ts`). A hung `await` is not an error, it is a hang: the process stays up, the event loop stays busy, and the queue behind it silently stops moving. A timeout converts that into a failure, which is a thing we know how to handle.

```typescript
export async function withTimeout<T>(work: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const expiry = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new TimeoutError(`${label} took longer than ${ms}ms`)), ms);
  });
  try {
    return await Promise.race([work, expiry]);
  } finally {
    clearTimeout(timer);   // or the timer keeps the process alive for `ms`
  }
}
```

> **Warning**
>
> `Promise.race` does not cancel the loser. A timed-out write keeps running to completion - nobody is listening, but the disk still does the work. **A Promise cannot be un-started.** All a timeout gives you is permission to stop waiting, which is the only power you ever had. If you need real cancellation, you need `AbortController`, and the thing you are calling has to support it.
>
> And note the `finally`. Without `clearTimeout`, a write that succeeds in 2ms leaves a 2000ms timer pending, and Node will not exit until it fires. A server that refuses to shut down is a server nobody can restart.

## Async Breaks Two Things You Had For Free

This is the part the tutorials skip, and it is the whole reason this chapter is long.

### 1. Ordering

A synchronous `for` loop over two lines processed line one, then line two. The language guaranteed it. Fire two `async` calls in that same loop and they interleave - line two can finish before line one, and a client that sent `{"join"}` followed by `{"chat"}` gets told it is not in a room.

`socket.on("data")` is a synchronous callback that **cannot await**, and Node will happily fire it again while the previous one is suspended. Two chunks arriving back to back would both be reading and consuming *the same buffer*, concurrently.

So each connection gets a queue of one:

```typescript
export class Serializer {
  private tail: Promise<unknown> = Promise.resolve();

  run<T>(task: () => Promise<T>): Promise<T> {
    // Catch on the chaining copy, not the returned one: a failed task must not
    // wedge every task behind it, but the caller still gets the real rejection.
    const result = this.tail.then(task);
    this.tail = result.catch(() => undefined);
    return result;
  }

  async drain(): Promise<void> { await this.tail; }
}
```

```typescript
const onData = (chunk: Buffer): void => {
  conn.append(chunk);                       // synchronous: capture the bytes first
  void queue.run(() => this.process(conn, socket, greeting, detach))
            .catch((thrown) => this.bus.emit("failure", conn.id, asError(thrown)));
};
```

`await` inside the line loop is deliberate, not a missed optimisation. These are messages from one person, in the order that person sent them, and running them concurrently would be reordering somebody's conversation.

### 2. Errors that nobody is holding

Look at this listener. It compiles. It is wrong.

```typescript
bus.on("message", async (m) => { await history.append(m); });   // NO
```

A listener's signature is `(message: ChatMessage) => void`. The emitter that calls it is synchronous - it cannot await, it has no idea what a Promise is, and it will not wait for one. But an `async` function returns `Promise<void>`, and **`Promise<void>` is assignable to `void`**, so TypeScript allows this deliberately. It works right up until the write fails: nobody is holding the Promise, the rejection is unhandled, and Node kills the process. Your chat server goes down because one disk write failed.

The fix is not to make the emitter async. It is to make the forgetting **explicit**:

```typescript
bus.on("message", (message) => {
  void history
    .append(summarize(message))
    .catch((thrown: unknown) => bus.emit("failure", `archive ${message.room}`, asError(thrown)));
});
```

`void` says *this Promise is deliberately not awaited*. `.catch` says *and nothing escapes*. Fire-and-forget is a perfectly good choice here - a chat message is delivered whether or not it was archived - but it is only a choice when the forgetting is written down.

> **Note**
>
> The `unhandledRejection` handler in `main.ts` has been there since Chapter 10, and until this chapter it was unreachable. It is now genuinely live. Understand what it is: **proof that something was forgotten**, not a strategy for forgetting things. Every `void ....catch(...)` in this codebase exists so that net never fires.

## Applying Async: History That Survives a Restart

The archive is one append-only NDJSON file per room - the same framing the TCP transport uses, which is not a coincidence. A format that survives a half-delivered socket read also survives a half-completed write: a torn last line is simply a line that does not parse, and we skip it and keep the rest.

```
data/general.jsonl
{"sender":"alice","text":"message 1","room":"general","at":1783923554955}
{"sender":"alice","text":"message 2","room":"general","at":1783923554955}
```

Two layers, and the split is the point:

| | where | who waits |
|---|---|---|
| **Join replay** | the `RingBuffer` in `ChatRoom` - last 50, in memory | nobody. Joining a room does no I/O. |
| **`{"type":"history"}`** | the file on disk - everything | the one client who asked |

Hot path in memory, deep query on disk. That is not a compromise, it is what a database *is*.

The three primitives live in `src/async.ts`, the archive in `src/history.ts`, and the wiring in `src/server.ts` and `src/handler.ts` - all on the `chapter12` branch. The one construct worth reading in full is the `Serializer`: a queue of one that restores the ordering a `for` loop used to give for free.

```typescript
export class Serializer {
  // Starts resolved: the first task chains onto nothing and runs immediately.
  private tail: Promise<unknown> = Promise.resolve();

  run<T>(task: () => Promise<T>): Promise<T> {
    // Catch on the *chaining* copy, not on the returned one. If a task rejects,
    // the queue must keep moving - one bad write cannot wedge every write after
    // it - but the caller still gets the real rejection to deal with.
    const result = this.tail.then(task);
    this.tail = result.catch(() => undefined);
    return result;
  }

  // Everything submitted so far has finished. Used at shutdown, where "we have
  // written it down" needs to be true before the process exits.
  async drain(): Promise<void> {
    await this.tail;
  }
```

> **Tip**
>
> The full files are on the branch. `history.ts` writes NDJSON to disk with a per-room queue and a write timeout; `server.ts` awaits `flush()` at shutdown so no queued write is lost, and uses top-level `await` - legal only because Chapter 11 made the package genuinely ESM.

## A bug that only running it would find

The first version of `server.load()` rebuilt each room with `new ChatMessage(sender, text, room)`. `ChatMessage`'s constructor stamps `at = Date.now()`.

Every restart therefore relabelled the *entire history* with the boot time. The file on disk was perfectly correct, and everything the server said about it was wrong - messages from last Tuesday, all claiming to have been sent at 09:14:03 this morning, in a plausible order, with no error anywhere.

```typescript
// A message read back from disk did not happen just now.
static restore(summary: MessageSummary): ChatMessage {
  return new ChatMessage(summary.sender, summary.text, summary.room, undefined, summary.at);
}
```

Persistence means preserving *when*, not just what. No type would have caught this - `Timestamp` is `number`, and `Date.now()` is a very good `number`. It took starting the server twice.

## Try It

```bash
npm run build && npm start
```

Say five things, then stop the server with Ctrl-C:

```json
{"type":"nick","name":"alice"}
{"type":"join","room":"general"}
{"type":"chat","text":"message 1"}
...
```

```
[SYSTEM] Shutting down
[SYSTEM] History flushed. Goodbye.
```

That second line is the `await` in `shutdown()` doing its job. Chapter 11's version called `process.exit()` the moment the socket closed, and a queued write that had not reached the disk simply died with the process.

Now look at what is on disk, and then start it again:

```bash
cat data/general.jsonl
npm start
```

```
[SYSTEM] general: recovered 5 message(s) from disk
```

Join and the last five messages are there - with their **original** timestamps. Ask for more than memory holds, and it reads the archive:

```json
{"type":"history","limit":100}
```

## Exercise

1. Change the archive listener in `bus.ts` to `bus.on("message", async (m) => { await history.append(m); })`. It compiles. Now make the write fail (`chmod 000 data/`) and watch the process die. Explain, precisely, who was holding that Promise.
2. Delete the `Serializer` from `acceptTcp` and call `this.process(...)` directly. Send `{"join"}` and `{"chat"}` in a single write with no gap. What comes back, and why is it different every few runs?
3. Set `WRITE_TIMEOUT_MS` to `1` in `history.ts`. Messages still send, and the log fills with timeout failures. Is the data on disk? Should it be? What does that tell you about what `Promise.race` actually did?
4. Remove the `clearTimeout` from the `finally` in `withTimeout`. Run the server, send one message, Ctrl-C. Time how long it takes to exit, and account for every millisecond.
5. Rewrite `/api/history` to use `for (const room of rooms) { out.push(await ...) }`. Add 200 rooms and measure both. Then argue for whichever one you would actually ship.

## What's Next

The server waits, and does it correctly: ordering preserved by an explicit queue, failures caught by the same boundary as before, fire-and-forget written down as fire-and-forget, and a shutdown that does not lie about what reached the disk.

Next: **advanced types** - mapped types, conditional types, template literal types, and `infer`. The tools for making the compiler derive things you are currently writing out by hand - starting with the `ServerEvents` map, which still lists every event and its handler signature in a place that can quietly disagree with reality.

---

Source: <https://purphoros.com/howto/typescript/async>
