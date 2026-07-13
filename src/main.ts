// The entry point. It builds a config, loads what the last run wrote down,
// constructs a server, and starts it.
//
// Note the `await` at the top level, outside any function. That is legal here
// only because Chapter 11 made this package genuinely ESM - a CommonJS module
// cannot do it, because `require()` is synchronous and has nowhere to put the
// waiting. It is a small thing that quietly justifies the whole `"type":
// "module"` change.

import { configure, DEFAULTS, resolvePort } from "./config.js";
import { describeThrown } from "./errors.js";
import { ChatServer } from "./server.js";

const config = configure(DEFAULTS, { port: resolvePort(process.argv[2]) });
const server = new ChatServer(config);

// Read the archive back before accepting a single connection. A client that
// connects and immediately asks for history must not race the disk - so we do
// not start listening until the disk has answered.
await server.load();

// The last net. Not a second error boundary: by the time a throw arrives here,
// nobody knows what was half-done, and a process running on state it cannot
// describe is worse than a process that stopped.
process.on("uncaughtException", (error: Error) => {
  console.error(`FATAL - nothing caught this: ${describeThrown(error)}`);
  process.exit(1);
});

// Now genuinely reachable, which it was not before this chapter. Every `void
// promise.catch(...)` in the codebase exists to keep it that way - this net is
// the proof that something was forgotten, not a strategy for forgetting things.
process.on("unhandledRejection", (reason: unknown) => {
  console.error(`FATAL - a promise rejected with nobody listening: ${describeThrown(reason)}`);
  process.exit(1);
});

// Ctrl-C. The handler is `async` and the exit waits for it: pending writes have
// to reach the disk before the process is allowed to leave, or "durable" was a
// word we were using loosely.
//
// SIGINT can arrive twice - an impatient second Ctrl-C - and a second shutdown
// while the first is draining would close an already-closing server. So the flag
// is not defensive programming, it is the actual sequence of events on a bad day.
let leaving = false;
process.on("SIGINT", () => {
  if (leaving) {
    console.error("Still flushing. Press Ctrl-C once more to abandon the writes.");
    process.exit(1);
  }
  leaving = true;

  void server
    .shutdown()
    .then(() => process.exit(0))
    .catch((thrown: unknown) => {
      console.error(`Shutdown failed: ${describeThrown(thrown)}`);
      process.exit(1);
    });
});

server.listen(() => {
  for (const line of server.banner()) {
    console.log(line);
  }
});
