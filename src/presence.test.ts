import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { PresenceTracker, TYPING_TTL_MS, SILENCE_LIMIT_MS, IDLE_AFTER_MS, AWAY_AFTER_MS } from "./presence.js";
import { FakeClient } from "./testing.js";

describe("PresenceTracker", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  const tracker = () => new PresenceTracker();

  it("debounces typing: ten keystrokes are one broadcast", () => {
    const p = tracker();
    const alice = new FakeClient();
    const news = Array.from({ length: 10 }, () => p.startedTyping(alice));
    expect(news.filter(Boolean)).toHaveLength(1);   // only the first is news
  });

  // The rule for all ephemeral state: it must decay, because the event that would
  // clear it is exactly the event most likely to go missing.
  it("expires a typing indicator nobody ever cancelled", () => {
    const p = tracker();
    const alice = new FakeClient();
    p.startedTyping(alice);

    expect(p.isTyping(alice, Date.now())).toBe(true);
    vi.advanceTimersByTime(TYPING_TTL_MS + 100);

    expect(p.isTyping(alice, Date.now())).toBe(false);
    expect(p.expiredTyping(alice, Date.now())).toBe(true);    // and it says so, once
    expect(p.expiredTyping(alice, Date.now())).toBe(false);   // and not twice
  });

  // The bug this chapter shipped and fixed: spoke() used to clear typingUntil,
  // so stoppedTyping() found nothing to cancel and the indicator stayed on screen.
  it("still has a typing indicator to cancel when a message arrives", () => {
    const p = tracker();
    const alice = new FakeClient();
    p.startedTyping(alice);

    p.spoke(alice);                              // must NOT erase the evidence
    expect(p.stoppedTyping(alice)).toBe(true);   // so the caller can cancel it
  });

  it("reaps a client that has not been heard from", () => {
    const p = tracker();
    const alice = new FakeClient();
    p.heard(alice);

    expect(p.isGone(alice, Date.now())).toBe(false);
    vi.advanceTimersByTime(SILENCE_LIMIT_MS + 100);
    expect(p.isGone(alice, Date.now())).toBe(true);
  });

  // Liveness and presence are different axes. A pong proves the socket works and
  // proves nothing at all about whether anybody is reading.
  it("keeps a chatty client alive but lets a silent one go idle", () => {
    const p = tracker();
    const alice = new FakeClient();
    p.spoke(alice);   // establish t=0. The tracker starts a client's clock when it
                      // first hears of them, so the baseline has to be set before
                      // the clock moves - which is the kind of thing you find out
                      // by writing the test.

    vi.advanceTimersByTime(IDLE_AFTER_MS + 100);
    p.heard(alice);                                    // a pong: alive...
    expect(p.isGone(alice, Date.now())).toBe(false);
    expect(p.reassess(alice, Date.now())).toBe("idle"); // ...but not present

    vi.advanceTimersByTime(AWAY_AFTER_MS);
    expect(p.reassess(alice, Date.now())).toBe("away");

    p.spoke(alice);
    expect(p.reassess(alice, Date.now())).toBeUndefined();  // already active
    expect(p.presenceOf(alice)).toBe("active");
  });

  it("reports a presence change once, not on every tick", () => {
    const p = tracker();
    const alice = new FakeClient();
    p.spoke(alice);
    vi.advanceTimersByTime(IDLE_AFTER_MS + 100);

    expect(p.reassess(alice, Date.now())).toBe("idle");        // news
    expect(p.reassess(alice, Date.now())).toBeUndefined();     // not news
  });
});
