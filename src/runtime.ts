// The machine underneath.
//
// Everything here is a question the server could not previously answer about
// itself: how much memory am I using, how far behind is the event loop, and -
// the one that actually matters - is anything stuck.

import { performance } from "node:perf_hooks";

export interface RuntimeSnapshot {
  readonly pid: number;
  readonly node: string;
  readonly platform: string;
  readonly uptimeSeconds: number;
  readonly heapUsedMb: number;
  readonly heapTotalMb: number;
  readonly rssMb: number;
  readonly eventLoopMeanMs: number;
  readonly eventLoopMaxMs: number;
}

const mb = (bytes: number): number => Math.round((bytes / 1024 / 1024) * 10) / 10;
const round = (value: number): number => Math.round(value * 10) / 10;

// How often we ask the loop to prove it is still listening.
const PROBE_MS = 50;

export class Runtime {
  private readonly probe: NodeJS.Timeout;

  private last = performance.now();
  private maxLag = 0;
  private totalLag = 0;
  private samples = 0;

  constructor() {
    // Event loop lag: the single most useful number a Node process can tell you
    // about itself.
    //
    // Node runs your JavaScript on one thread. `await` yields, so other clients
    // are served while one of them waits on a disk - but a *synchronous* loop
    // that takes 400ms serves nobody for 400ms. Every socket, every timer, every
    // callback simply waits, and from the outside the server has hung, because
    // for 400ms it has.
    //
    // The measurement is the whole idea in three lines: ask to be woken in 50ms,
    // then see how late you actually were. Nobody woke us because the thread was
    // busy, and *how* late is exactly how long it was busy.
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
  }

  // > **On `perf_hooks.monitorEventLoopDelay`.** Node ships an API that sounds
  // > exactly like the above, and the first draft of this file used it. On this
  // > machine (Node 22, darwin/arm64) its `mean` and `max` sat at ~12ms whether
  // > the loop was idle *or* blocked solid for 400ms - while the fifteen lines
  // > above reported a max of 351ms for the same block. Whatever it is measuring,
  // > it was not the thing this server needs to know.
  // >
  // > That is not really a complaint about the API. It is the reason this file
  // > exists at all: a metric you have not watched move is not a metric, it is a
  // > number. Block your own event loop on purpose and confirm your monitoring
  // > notices, because the day it matters you will be reading it at 3am and
  // > believing it.

  snapshot(): RuntimeSnapshot {
    const memory = process.memoryUsage();
    return {
      pid: process.pid,
      node: process.version,
      platform: `${process.platform}/${process.arch}`,
      uptimeSeconds: Math.round(process.uptime()),
      // heapUsed is the JavaScript objects. rss is everything the OS has given
      // us - *including* Buffers, which live outside the V8 heap. A server
      // leaking a slow client's unsent mail leaks rss while heapUsed stays
      // perfectly calm, so reporting only one of these is how a leak hides.
      heapUsedMb: mb(memory.heapUsed),
      heapTotalMb: mb(memory.heapTotal),
      rssMb: mb(memory.rss),
      eventLoopMeanMs: this.samples > 0 ? round(this.totalLag / this.samples) : 0,
      eventLoopMaxMs: round(this.maxLag),
    };
  }

  // Report the interval since you last looked, rather than the whole life of the
  // process - which is almost always the question you meant to ask.
  reset(): void {
    this.maxLag = 0;
    this.totalLag = 0;
    this.samples = 0;
  }

  stop(): void {
    clearInterval(this.probe);
  }
}
