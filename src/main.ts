// The entry point. It builds a config, loads what the last run wrote down,
// constructs a server, and starts it.
//
// Note the `await` at the top level, outside any function. That is legal here
// only because Chapter 11 made this package genuinely ESM - a CommonJS module
// cannot do it, because `require()` is synchronous and has nowhere to put the
// waiting. It is a small thing that quietly justifies the whole `"type":
// "module"` change.

import { fromEnvironment } from "./config.js";
import { describeThrown } from "./errors.js";
import { ChatServer } from "./server.js";

// argv beats env beats defaults. A bad value in the environment is fatal, on
// purpose - see config.ts.
const config = fromEnvironment(process.env, process.argv);
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

// Two signals, one door.
//
// SIGINT is Ctrl-C: a person, at a terminal, watching. SIGTERM is what every
// process supervisor in the world sends first - systemd, Docker, Kubernetes -
// and then, after a grace period of about ten seconds, it sends SIGKILL, which
// cannot be caught, handled, or negotiated with.
//
// A server that handles only SIGINT looks perfect on a laptop and loses data on
// every single deploy: the container stops, SIGTERM arrives, nothing is
// listening, the default action kills the process, and the writes still in the
// queue simply never happen. Chapter 12 went to considerable trouble to flush
// that queue, and handling only SIGINT would have been a way of doing all that
// work for the one case that does not matter.
//
// The flag is not defensive programming. A second Ctrl-C from an impatient human
// is an ordinary Tuesday, and closing an already-closing server is an error.
let leaving = false;

const leave = (signal: NodeJS.Signals): void => {
  if (leaving) {
    console.error(`${signal} again - abandoning any writes still in the queue.`);
    process.exit(1);
  }
  leaving = true;
  console.log(`${signal} received.`);

  void server
    .shutdown()
    .then(() => process.exit(0))
    .catch((thrown: unknown) => {
      console.error(`Shutdown failed: ${describeThrown(thrown)}`);
      process.exit(1);
    });
};

process.on("SIGINT", () => leave("SIGINT"));
process.on("SIGTERM", () => leave("SIGTERM"));

server.listen(() => {
  for (const line of server.banner()) {
    console.log(line);
  }
});
