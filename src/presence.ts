// Who is actually here, and who merely has a socket open.
//
// Those are different questions, and until this chapter the server could only
// answer the second one.
//
// A TCP connection is not a heartbeat. It is a *belief* - the kernel's belief that
// the other end is still there, held on the strength of packets that arrived some
// time ago. If the far end vanishes properly it sends a FIN and everyone finds
// out. If it vanishes *improperly* - a laptop lid closes, a router reboots, a
// phone walks into a lift - it sends nothing at all, and the socket stays open on
// our side, forever, holding a place in a room for somebody who left.
//
// TCP has its own keepalive for this. Its default idle time is **two hours**.
//
// So the application asks. Every few seconds, quietly:
//
//   WebSocket → a protocol-level ping frame. `ws` sends it, the browser's own
//               stack answers it, and no application code on the client is
//               involved at all.
//   TCP       → a {"type":"ping"} message, because raw TCP has no such frame and
//               we have a perfectly good protocol of our own.
//
// Miss two in a row and you are not slow, you are gone.

import type { ChatClient } from "./types.js";

// How often we ask.
export const HEARTBEAT_MS = 5_000;

// How long we will wait before deciding a silence means something. Two intervals,
// so one dropped packet is not an eviction.
export const SILENCE_LIMIT_MS = HEARTBEAT_MS * 2 + 1_000;

// After this long without *saying* anything, you are still here but you are not
// paying attention. This is presence, and it is a different thing from liveness:
// the socket is fine, the person is making tea.
export const IDLE_AFTER_MS = 60_000;
export const AWAY_AFTER_MS = 5 * 60_000;

// How long a typing indicator is believed. Chat clients send "I am typing" and
// then, very often, never send "I stopped" - the tab closed, the network hiccuped,
// they changed their mind. So the *indicator expires on its own* rather than
// waiting to be cancelled.
//
// This is the whole design rule for ephemeral state: it must decay, because the
// event that would clear it is exactly the event most likely to go missing.
export const TYPING_TTL_MS = 4_000;

export type Presence = "active" | "idle" | "away";

interface Liveness {
  // The last time we heard *anything* from this client - a message, a pong, a
  // frame. Liveness.
  lastSeen: number;
  // The last time they said something a human would recognise as activity.
  // Presence.
  lastSpoke: number;
  // When we last asked, and whether they have answered since.
  awaitingSince: number | undefined;
  presence: Presence;
  typingUntil: number;
}

export class PresenceTracker {
  private readonly state = new WeakMap<ChatClient, Liveness>();

  private of(client: ChatClient): Liveness {
    let liveness = this.state.get(client);
    if (liveness === undefined) {
      const now = Date.now();
      liveness = {
        lastSeen: now,
        lastSpoke: now,
        awaitingSince: undefined,
        presence: "active",
        typingUntil: 0,
      };
      this.state.set(client, liveness);
    }
    return liveness;
  }

  // Anything at all arrived. This is liveness, not presence: a pong proves the
  // socket works and proves nothing whatever about whether anyone is reading.
  heard(client: ChatClient): void {
    const liveness = this.of(client);
    liveness.lastSeen = Date.now();
    liveness.awaitingSince = undefined;
  }

  // They did something deliberate. Back to active, and if that is a change,
  // somebody should be told.
  //
  // Note what this does *not* do: it does not clear the typing indicator, even
  // though sending a message obviously means you have stopped typing.
  //
  // The first version did, and it was a bug - a quiet one. `spoke()` zeroed
  // `typingUntil`, and then the caller asked `stoppedTyping()` whether there was
  // an indicator to cancel, and `stoppedTyping()` said no, *because spoke() had
  // just erased the evidence*. So the message went out and the "alice is typing…"
  // stayed on everybody's screen until it timed out four seconds later.
  //
  // Two methods quietly fighting over one field. The fix is not to be careful
  // about the order; it is for `spoke()` to mind its own business and let the
  // caller cancel the indicator explicitly, where you can see it happen.
  spoke(client: ChatClient): Presence | undefined {
    const liveness = this.of(client);
    const now = Date.now();
    liveness.lastSeen = now;
    liveness.lastSpoke = now;
    liveness.awaitingSince = undefined;

    if (liveness.presence !== "active") {
      liveness.presence = "active";
      return "active";
    }
    return undefined;
  }

  // We are about to ping. Remember when, so silence can be measured from it.
  asked(client: ChatClient, at: number): void {
    const liveness = this.of(client);
    liveness.awaitingSince ??= at;
  }

  // Has this client been silent long enough that we should stop believing in it?
  //
  // Measured from `lastSeen`, not from `awaitingSince` - because a client that is
  // *chatting* is obviously alive and should never be evicted just because a pong
  // went missing.
  isGone(client: ChatClient, now: number): boolean {
    return now - this.of(client).lastSeen > SILENCE_LIMIT_MS;
  }

  // Presence, which decays with silence and is a completely separate axis from
  // liveness. Returns the new value only when it *changed*, so the caller
  // broadcasts a state transition and not a heartbeat.
  reassess(client: ChatClient, now: number): Presence | undefined {
    const liveness = this.of(client);
    const quiet = now - liveness.lastSpoke;

    const next: Presence = quiet > AWAY_AFTER_MS ? "away" : quiet > IDLE_AFTER_MS ? "idle" : "active";

    if (next === liveness.presence) {
      return undefined;
    }
    liveness.presence = next;
    return next;
  }

  presenceOf(client: ChatClient): Presence {
    return this.of(client).presence;
  }

  // --- Typing ------------------------------------------------------------

  // Returns true when this is *news* - when the client was not already known to
  // be typing. A client that sends "typing" on every keystroke (and they all do)
  // must not produce a broadcast on every keystroke.
  //
  // This is the debounce, and it belongs on the server. You cannot ask every
  // client in the world to be well-behaved; you can only decline to repeat them.
  startedTyping(client: ChatClient): boolean {
    const liveness = this.of(client);
    const now = Date.now();
    const wasTyping = liveness.typingUntil > now;
    liveness.typingUntil = now + TYPING_TTL_MS;
    return !wasTyping;
  }

  stoppedTyping(client: ChatClient): boolean {
    const liveness = this.of(client);
    const wasTyping = liveness.typingUntil > Date.now();
    liveness.typingUntil = 0;
    return wasTyping;
  }

  isTyping(client: ChatClient, now: number): boolean {
    return this.of(client).typingUntil > now;
  }

  // A typing indicator that has expired without being cancelled. The client never
  // told us they stopped - they almost never do - so the *server* decides.
  expiredTyping(client: ChatClient, now: number): boolean {
    const liveness = this.of(client);
    if (liveness.typingUntil !== 0 && liveness.typingUntil <= now) {
      liveness.typingUntil = 0;
      return true;
    }
    return false;
  }
}
