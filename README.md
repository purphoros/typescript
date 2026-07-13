# Chapter 15 - The Node.js Runtime

The event loop, EventEmitter, Buffers, signals, and file I/O - the runtime this chat server has been standing on since Chapter 5 without ever quite looking down.

Most of this chapter's exercises are already done. Graceful shutdown: Chapter 10. The `uncaughtException` and `unhandledRejection` nets: Chapter 10. History on disk with `fs.appendFile`, read back at startup: Chapter 12. `EventEmitter` - we wrote a typed one from scratch in Chapter 8.

So this chapter is not a tour. It is the runtime **collecting on two debts**, both of which have been real bugs in our code for ten chapters, and both of which Node has been quietly telling us about the whole time.

## The Event Loop

Node runs your JavaScript on **one thread**.

```
  ┌─── timers ──── setTimeout, setInterval
  │
  ├─── poll ────── I/O callbacks. Your socket "data" handler lives here.
  │
  ├─── check ───── setImmediate
  │
  └─── close ───── socket.on("close")

  between every phase: microtasks (Promise.then), then process.nextTick
```

`await` yields, so other clients are served while one of them waits on a disk - that is Chapter 12's whole argument. But a **synchronous** loop that runs for 400ms serves nobody for 400ms. Every socket, every timer, every callback simply waits. From the outside, the server has hung, because for 400ms it has.

So the most useful number a Node process can report about itself is *how late its own timers are running*:

```typescript
this.probe = setInterval(() => {
  const now = performance.now();
  const lag = Math.max(0, now - this.last - PROBE_MS);  // how late were we?
  this.maxLag = Math.max(this.maxLag, lag);
  this.last = now;
}, PROBE_MS);

this.probe.unref();
```

Ask to be woken in 50ms; see how late you actually were. Nobody woke us because the thread was busy, and *how* late is exactly how long it was busy.

> **Warning**
>
> `.unref()` is not an optimisation, it is the difference between a server that exits and one that does not. A timer holds the event loop open. Without that line, the loop always has one more thing to do - forever, every 50ms - so `server.close()` completes, every client disconnects, and the process sits there being perfectly healthy and refusing to die. It presents as *"our deploys hang"*. Nothing should stay alive merely because something is watching it.

> **Note**
>
> Node ships `perf_hooks.monitorEventLoopDelay`, which sounds exactly like the above, and the first draft of `runtime.ts` used it. On this machine (Node 22, darwin/arm64) its `mean` and `max` sat at ~12ms whether the loop was idle **or blocked solid for 400ms** - while the fifteen lines above reported a max of 351ms for the same block.
>
> Whatever it was measuring, it was not the thing this server needs to know. That is less a complaint about the API than the reason this chapter exists: **a metric you have not watched move is not a metric, it is a number.** Block your own event loop on purpose and confirm your monitoring notices - because the day it matters, you will be reading it at 3am and believing it.

## Debt One: `socket.write()` returns a boolean

We have never once looked at it.

```typescript
this.socket.write(raw);   // returns false when the kernel's buffer is full
```

`false` means *the client is not reading as fast as you are writing*. And Node does not drop the surplus - it **queues it, in your process, indefinitely**.

So one laptop that suspends mid-conversation, in a busy room, is a memory leak with a heartbeat. Every broadcast appends to a buffer nobody is draining. The client is completely fine. We are the casualty.

The fix is to believe the runtime:

```typescript
const MAX_BACKLOG_BYTES = 1_000_000;

protected accepts(): boolean {
  if (this.backlog > MAX_BACKLOG_BYTES) {
    this.dropped = `not reading - ${Math.round(this.backlog / 1024)}KB unsent`;
    this.markClosing();
    this.destroy();
    return false;
  }
  return true;
}
```

`backlog` is a number Node has always kept and we never asked for - `socket.writableLength` for TCP, `ws.bufferedAmount` for WebSocket. Same disease, same cure. A megabyte behind is roughly a thousand messages behind; a client that far behind is not slow, it is gone, and the honest thing is to say so.

Watch it happen. Connect a client, call `pause()` so it never drains its socket, then flood the room:

```
[SYSTEM] alice dropped: not reading - 977KB unsent
```

> **Tip**
>
> `WsClient.destroy()` calls `ws.terminate()`, not `ws.close()`. `close()` starts a polite closing handshake - which a client that has stopped reading will never complete. You would be waiting for a reply from someone whose defining characteristic is that they are not listening.

## Debt Two: the inbox had no bottom

```typescript
append(chunk: Buffer): void {
  this.inbox = Buffer.concat([this.inbox, chunk]);   // ...forever
}
```

Chapter 5 buffers bytes until a complete line arrives. It never asked what happens if one never does. Open a socket, send 500MB with no newline in it, and this server would hold every byte, patiently, waiting for a line ending that was never coming.

```typescript
const MAX_INBOX_BYTES = 256 * 1024;

append(chunk: Buffer): boolean {
  this.inbox = Buffer.concat([this.inbox, chunk]);
  return this.inbox.length <= MAX_INBOX_BYTES;
}
```

The *framing* is what makes a bound possible at all: we only ever need enough bytes to hold one complete unit - one JSON line, or one HTTP head plus body. A chat message is capped at 1KB by the schema (Chapter 14). 256KB is enormously generous, and anything past it is not a large message, it is a client that has stopped sending newlines.

```
[SYSTEM] c6 dropped: sent 256KB with no complete message
```

## Buffers, and where memory actually goes

Both bugs are Buffer bugs, and both hide in the same place:

```typescript
heapUsedMb: mb(memory.heapUsed),   // JavaScript objects
rssMb: mb(memory.rss),             // everything the OS gave us - Buffers included
```

**Buffers live outside the V8 heap.** A server leaking a slow client's unsent mail leaks `rss` while `heapUsed` stays perfectly calm. Report only `heapUsed` - as most dashboards do - and the leak is invisible right up until the OOM killer arrives.

## Signals: SIGTERM is the one that matters

```typescript
process.on("SIGINT", () => leave("SIGINT"));
process.on("SIGTERM", () => leave("SIGTERM"));
```

SIGINT is Ctrl-C: a person, at a terminal, watching. **SIGTERM is what every process supervisor in the world sends first** - systemd, Docker, Kubernetes - and then, after roughly ten seconds, it sends SIGKILL, which cannot be caught, handled, or negotiated with.

A server that handles only SIGINT looks flawless on a laptop and loses data on **every single deploy**: the container stops, SIGTERM arrives, nothing is listening, the default action kills the process, and the writes still in Chapter 12's queue simply never happen. We went to real trouble to flush that queue. Handling only SIGINT would have been a way of doing all that work for the one case that does not matter.

## Environment: `process.env` is untrusted input

It is `Record<string, string | undefined>` - every value a string, every value possibly absent. It arrives from a shell instead of a socket, and it deserves precisely the same treatment, which as of Chapter 14 we know how to give it:

```typescript
export const EnvSchema = z.object({
  HOST: z.string().min(1).optional(),
  PORT: z.coerce.number().int().min(1).max(65535).optional(),
  DATA_DIR: z.string().min(1).optional(),
  ROOMS: z.string().min(1)
    .transform((v) => v.split(",").map((r) => r.trim()).filter(Boolean))
    .pipe(z.array(z.string().regex(/^[a-z0-9-]+$/)).min(1))
    .optional(),
});
```

Everything optional: an unset variable is a default, not an error. But a *set* one that is nonsense is fatal, on purpose. `PORT=banana` is not a request to use 8080 - it is a mistake in a deployment, and a server that silently binds to 8080 anyway will be found at 3am by somebody wondering why the load balancer is unhappy. **Fail at startup, loudly, while the person who typed it is still watching.**

Precedence is `argv` → `env` → `DEFAULTS`: specific beats general, immediate beats standing.

## Putting It Together

Two bugs the runtime had been reporting all along, plus a way to see them. The files are on the `chapter15` branch.

Event-loop lag, measured the only way that works: ask to be woken in 50ms, see how late you actually were. `.unref()` is what lets the process still exit:

```typescript
    this.probe = setInterval(() => {
      const now = performance.now();
      const lag = Math.max(0, now - this.last - PROBE_MS);
      this.maxLag = Math.max(this.maxLag, lag);
      this.totalLag += lag;
      this.samples++;
      this.last = now;
    }, PROBE_MS);

    // .unref() and the server can still exit.
    //
    // A timer holds the event loop open. Without this line the loop always has
    // one more thing to do - forever, every 50ms - and `server.close()` would
    // complete, every client would disconnect, and the process would sit there
    // being perfectly healthy and refusing to die. It is a two-word fix for a
    // bug that presents as "our deploys hang", and it is the reason a monitoring
    // timer must never keep a process alive: nothing should stay up merely
    // because something is watching it.
    this.probe.unref();
```

And backpressure - the bug the runtime had been signalling since Chapter 5. Past a megabyte unsent, the client is not slow, it is gone:

```typescript
  protected accepts(): boolean {
    if (this.dropped !== undefined) {
      return false;
    }
    if (this.backlog > MAX_BACKLOG_BYTES) {
      this.dropped = `not reading - ${Math.round(this.backlog / 1024)}KB unsent`;
      this.markClosing();
      this.destroy();
      return false;
    }
    return true;
  }
```

> **Tip**
>
> `monitorEventLoopDelay` looked right and read ~12ms whether idle or blocked; the hand-rolled probe above caught a 400ms block. Watch your metrics move before you trust them.
## Exercise

1. Add an endpoint that blocks the thread for two seconds (`while (Date.now() < end) {}`). Hit it, then immediately hit `/api/health` from another terminal - and notice you cannot, because there is one thread and you are standing on it. Read `eventLoopMaxMs` afterwards.
2. Delete `.unref()` from `runtime.ts`. Start the server, Ctrl-C, and watch it refuse to exit. Explain, in one sentence, what is still keeping it alive.
3. Set `MAX_BACKLOG_BYTES` to `50_000_000` and re-run the slow-client experiment while watching `rss` versus `heapUsedMb`. Which one moves? Why is that the answer to "where do Buffers live"?
4. Handle SIGHUP and reload `ROOMS` from the environment without restarting. What breaks about clients currently in a room that no longer exists - and is that a reason not to do it?
5. `Buffer.concat` in `append()` copies the whole inbox on every chunk, so a message arriving in N pieces costs O(N²). With a 256KB bound that is fine. Work out at what bound it stops being fine, and what you would use instead.

## What's Next

The server now knows what it is doing to the machine, and the machine can no longer be used against it: no unbounded read buffer, no unbounded write queue, no timer holding the door shut, no deploy that quietly drops the last few messages.

Next: **the chat server core** - rooms, the client state machine, and broadcasting. Everything we have built has been in service of a chat server, and it is time to look hard at the chat itself.

---

Source: <https://purphoros.com/howto/typescript/nodejs-runtime>
