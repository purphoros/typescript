import { describe, it, expect } from "vitest";
import { Serializer, withTimeout, delay } from "./async.js";
import { TimeoutError } from "./errors.js";

describe("Serializer", () => {
  // REGRESSION (Chapter 12): async took away the ordering a `for` loop gave for
  // free. Two messages sent in one breath must land in the order they were sent.
  it("runs tasks strictly in the order they were submitted", async () => {
    const queue = new Serializer();
    const order: number[] = [];
    const results = [30, 5, 20, 1].map((ms, i) =>
      queue.run(async () => { await delay(ms); order.push(i); }),
    );
    await Promise.all(results);
    expect(order).toEqual([0, 1, 2, 3]);   // NOT [3, 1, 2, 0]
  });

  it("keeps moving after a task fails, and still reports the failure", async () => {
    const queue = new Serializer();
    const bad = queue.run(async () => { throw new Error("boom"); });
    await expect(bad).rejects.toThrow("boom");
    await expect(queue.run(async () => "fine")).resolves.toBe("fine");
  });
});

describe("withTimeout", () => {
  it("passes a fast result through", async () => {
    await expect(withTimeout(Promise.resolve(42), 100, "x")).resolves.toBe(42);
  });

  it("gives up on a slow one", async () => {
    await expect(withTimeout(delay(200), 20, "slow thing")).rejects.toThrow(TimeoutError);
  });

  it("does NOT cancel the loser - a Promise cannot be un-started", async () => {
    let finished = false;
    const work = delay(60).then(() => { finished = true; return "done"; });
    await expect(withTimeout(work, 10, "x")).rejects.toThrow(TimeoutError);
    expect(finished).toBe(false);   // not yet
    await delay(80);
    expect(finished).toBe(true);    // it kept running. Nobody was listening.
  });
});
