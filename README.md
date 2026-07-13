# Chapter 23 - Real-Time Features

Two questions that look like one:

- Is this client's **socket** still working?
- Is there a **person** on the other end of it?

Until this chapter the server could not answer either. It assumed the first and never thought about the second.

## A TCP connection is not a heartbeat

It is a *belief*. The kernel believes the far end is still there, on the strength of packets that arrived some time ago.

If a client leaves **properly**, it sends a FIN and everybody finds out. If it leaves **improperly** - a laptop lid closes, a router reboots, a phone walks into a lift - it sends **nothing at all**. The socket stays open on our side, indefinitely, holding a place in a room for somebody who is not there.

TCP has its own keepalive for exactly this. Its default idle time before the first probe is **two hours**.

```typescript
socket.setKeepAlive(true, 30_000);
```

Worth turning on - it costs nothing - and nowhere near enough. So the application asks:

```typescript
if (client instanceof WsClient) {
  client.ping();                    // a protocol-level ping FRAME
} else {
  client.send({ type: "ping" });    // raw TCP has no such frame, so: a message
}
```

> **Tip**
>
> The WebSocket ping is a **frame**, not a message. It never reaches the application on the other end - the browser's own WebSocket stack answers it, automatically, with a pong frame, and no JavaScript on the page is ever told it happened. That is why it works against clients that have never heard of us.
>
> Raw TCP has no such thing, so TCP clients get `{"type":"ping"}` and are expected to answer `{"type":"pong"}`. Two mechanisms, one meaning, because the transports genuinely differ and pretending otherwise would mean inventing a worse version of something WebSocket already has.

Miss two in a row and you are not slow, you are gone:

```
  clients connected: 2 (one answers pings, one never will)
  waiting out the heartbeat...
  clients connected: 1
  zombie got 2 ping(s), never answered, and was told: "No heartbeat. Closing."
```

```json
{"level":"info","msg":"reaping a client that stopped answering","client":"c2","user":"bob"}
```

> **Warning**
>
> **I could not reproduce the real failure on a laptop, and I am not going to pretend I did.** On loopback, a destroyed socket always produces a FIN or an RST, and the server always notices - so the "ghost client" I wanted to demonstrate never appears. The bug is real (it is why every chat protocol in the world has a heartbeat), and my *demonstration* of it is a client that deliberately declines to answer, which is what a ghost looks like from the server's side.
>
> That is an honest test of the mechanism and a dishonest test of the scenario, and it is worth being clear about which one you have. Reproducing the real thing needs `iptables -j DROP` and two machines.

## One timer, not a thousand

```typescript
this.heartbeat = setInterval(() => {
  const now = Date.now();
  for (const client of [...this.registry.clients.values()]) {
    // reap, ping, expire typing, reassess presence
  }
}, HEARTBEAT_MS);

this.heartbeat.unref();
```

One loop for the whole server. A thousand clients with a `setInterval` each is a thousand timers the event loop must consider on every tick, to do a job one loop does in a millisecond.

And `.unref()` - Chapter 15's lesson, exactly as true the second time. **A timer holds the event loop open, and a server that will not exit is a server nobody can restart.**

## Liveness and presence are different axes

A pong proves the socket works. It proves **nothing whatever** about whether anybody is reading.

| | measured from | means |
|---|---|---|
| **liveness** | anything we hear at all - a pong, a message, a frame | the socket works |
| **presence** | the last thing a human deliberately *said* | somebody is there |

```typescript
const next: Presence = quiet > AWAY_AFTER_MS ? "away" : quiet > IDLE_AFTER_MS ? "idle" : "active";

if (next === liveness.presence) {
  return undefined;      // not news
}
liveness.presence = next;
return next;             // news
```

`reassess` returns the new value **only when it changed** - so the heartbeat loop broadcasts a transition, not a firehose of "alice is still idle" every five seconds. A client that is idle for an hour generates exactly one message.

## Ephemeral state must decay

Here is the rule, and it is the most useful thing in the chapter:

> **Ephemeral state must expire on its own, because the event that would clear it is exactly the event most likely to go missing.**

Chat clients send *"I am typing"* and then, very often, never send *"I stopped"*. The tab closed. The network hiccuped. They changed their mind and wandered off. If the indicator waits to be cancelled, it waits forever, and everyone in the room watches a permanent "alice is typing…" from somebody who left twenty minutes ago.

So it has a **TTL**, and the server enforces it:

```typescript
export const TYPING_TTL_MS = 4_000;

expiredTyping(client: ChatClient, now: number): boolean {
  const liveness = this.of(client);
  if (liveness.typingUntil !== 0 && liveness.typingUntil <= now) {
    liveness.typingUntil = 0;
    return true;      // and say so, once
  }
  return false;
}
```

```
--- and if she just stops, with no message and no cancel? ---
  bob sees: typing(true). Now alice goes quiet, and never sends typing:false...
  the indicator expired on its own: {"type":"typing","user":"alice","room":"general","typing":false}
```

And the typing indicator is **never persisted, never archived, and never replayed to a joiner**. It is not a message; it is a fact about *right now*, and in four seconds it will not even be that. It does not go anywhere near `bus.emit("message")` and so it never reaches the three listeners that would log it, store it, and put it in everybody's history.

## Debouncing belongs on the server

Every chat client in the world sends `typing` on **every keystroke**. Ours does too - with a 2-second throttle, because that is basic manners - but you cannot ask the world to be well-behaved. You can only decline to repeat it:

```typescript
startedTyping(client: ChatClient): boolean {
  const liveness = this.of(client);
  const now = Date.now();
  const wasTyping = liveness.typingUntil > now;
  liveness.typingUntil = now + TYPING_TTL_MS;
  return !wasTyping;      // true only when this is NEWS
}
```

```
--- alice types. She sends 10 keystrokes worth of "typing". ---
  bob received 1 typing event(s) from 10 keystrokes
```

Ten in, one out. A room of fifty people, all typing, is fifty broadcasts rather than five hundred - and the difference compounds with every person in the room, because each event goes to *everybody*.

## A bug I shipped, and how it read

The first version of `spoke()` did the obvious, tidy thing:

```typescript
spoke(client: ChatClient): Presence | undefined {
  const liveness = this.of(client);
  liveness.lastSpoke = Date.now();
  liveness.typingUntil = 0;    // sending a message means you have stopped typing
  ...
}
```

Which is true! And it broke the feature.

The handler cancels the indicator by asking `stoppedTyping()` whether there *was* one - and `spoke()` had already erased the evidence. So `stoppedTyping()` said "no", no `typing: false` was broadcast, and the "alice is typing…" stayed on everybody's screen until it timed out four seconds later.

**Two methods quietly fighting over one field.** The fix is not to be careful about the order - that is a comment, and comments do not run. The fix is for `spoke()` to mind its own business:

```typescript
// Cancel the typing indicator *first*, while there is still an indicator to
// cancel. See PresenceTracker.spoke - the first version had these the other way
// round, and the "alice is typing…" stayed on screen after the message arrived.
if (this.presence.stoppedTyping(client)) {
  registry.broadcast(room.name, { type: "typing", ..., typing: false }, client);
}

const became = this.presence.spoke(client);
```

It took running two clients and watching one of them. No type would have caught it: both methods have perfectly good signatures, and they were both doing something reasonable.

## Putting It Together

`src/presence.ts` tracks who is there, who is typing, and who is gone. It is on the `chapter23` branch.

Typing is debounced on the server - `startedTyping` returns true only when it is *news*, so ten keystrokes are one broadcast:

```typescript
  startedTyping(client: ChatClient): boolean {
    const liveness = this.of(client);
    const now = Date.now();
    const wasTyping = liveness.typingUntil > now;
    liveness.typingUntil = now + TYPING_TTL_MS;
    return !wasTyping;
  }
```

And the indicator expires on its own, because the client will very often never send the cancel:

```typescript
  expiredTyping(client: ChatClient, now: number): boolean {
    const liveness = this.of(client);
    if (liveness.typingUntil !== 0 && liveness.typingUntil <= now) {
      liveness.typingUntil = 0;
      return true;
    }
    return false;
  }
}
```

> **Tip**
>
> The complete, runnable file is `src/presence.ts` on the `chapter23` branch. You are not meant to paste it wholesale - build your own as you follow along, and use the reference to check yourself.

## Try It

```bash
npm run build && npm start
```

Open <http://127.0.0.1:8080/> in **two** browser tabs, log in as `alice` and `bob`, and both `/join general`. Type in one and watch the other.

Over TCP, where you can see the wire:

```json
{"type":"login","name":"alice","password":"correct-horse"}
{"type":"auth","token":"..."}
{"type":"join","room":"general"}
{"type":"typing","typing":true}
```

Wait five seconds and the server will ask:

```json
{"type":"ping"}
```

Answer it - `{"type":"pong"}` - and you stay. **Do not answer it, and in eleven seconds you are gone:**

```json
{"type":"system","text":"No heartbeat. Closing."}
```

Say nothing for a minute (but keep ponging) and the room is told you have wandered off:

```json
{"type":"presence","user":"alice","room":"general","presence":"idle"}
```

## Exercise

1. Set `TYPING_TTL_MS` to `600000`. Type one character, close the tab, and watch everybody else stare at "alice is typing…" for ten minutes. That is what "ephemeral state must decay" is protecting you from.
2. Make `SILENCE_LIMIT_MS` one heartbeat instead of two. Now drop a single packet (or just be on hotel wifi). What did you break, and why is "two" not a magic number but an argument?
3. `typing` is broadcast to everybody in the room. Make it not tell a client about *itself* - oh, it already does that (`registry.broadcast(..., client)`). Now find the other place in this codebase where a client is told about its own action, and decide whether it should be.
4. Add read receipts: `{"type":"read","upto":<timestamp>}`, and a `presence`-style broadcast of who has read what. Which of the two axes does it belong to, and where does it get persisted - if at all?
5. Move the reap loop into `PresenceTracker` so `ChatServer` does not need to know what a heartbeat is. Then try to test it. What did you make harder, and was it worth it?

## What's Next

The server knows who is there, who is typing, and who is gone. Ghost clients are reaped, ephemeral state decays on its own, and presence is broadcast on change rather than on a timer.

And it has, sitting quietly in `server.ts` since Chapter 7, a WebSocket upgrade that will accept a connection **from any website on the internet**, with no check of any kind on where it came from.

Next: **security and hardening.**

---

Written for this repository. Upstream: <https://purphoros.com/howto/typescript/realtime>
