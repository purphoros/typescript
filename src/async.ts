// The three async primitives this server actually needs.
//
// Not a utility drawer. Each of these exists because going asynchronous broke
// something specific, and this is the thing that fixes it.

import { TimeoutError } from "./errors.js";

// A Promise that resolves after a delay. The only honest way to write one - the
// `new Promise(resolve => ...)` constructor is for wrapping callback APIs, and
// setTimeout is a callback API.
export function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Promise.race: whichever settles first wins, and the loser is *not* cancelled -
// it keeps running, and nobody is listening. That is the part everyone forgets.
// A timed-out disk write still completes; we have simply stopped waiting for it.
//
// This matters because a hung `await` is not an error, it is a hang. The process
// stays up, the event loop stays busy, and the queue behind it silently stops
// moving. A timeout converts that into a failure, which is something we know how
// to handle.
export async function withTimeout<T>(work: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;

  const expiry = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new TimeoutError(`${label} took longer than ${ms}ms`)), ms);
  });

  try {
    return await Promise.race([work, expiry]);
  } finally {
    // Without this, the timer keeps the event loop alive for `ms` after a fast
    // success - and a server that will not exit is a server nobody can restart.
    clearTimeout(timer);
  }
}

// A queue of one. Hand it async work and it runs it strictly after whatever it
// was already running, so the order things were submitted is the order they
// happen.
//
// This exists because `await` gave away something we had for free. A synchronous
// `for` loop over two lines processed line one, then line two - the language
// guaranteed it. Fire two async calls in that same loop and they interleave:
// line two can finish before line one, and a client that sent {"join"} then
// {"chat"} gets told it is not in a room.
//
// The chain is the whole implementation. Each new task is `.then`ed onto the
// tail, and the tail becomes the new task.
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
}
