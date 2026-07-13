// The entry point. It builds a config, constructs a server, and starts it.
//
// That is all it does, and the shortness is the entire result of the chapter.
// Chapter 10's index.ts was 1,435 lines and did every job in the program. This
// file does one: it decides what to run and runs it.
//
// It is `main.ts`, not `index.ts`, and that is deliberate - see index.ts, which
// is the barrel. A file that *starts a server when you import it* cannot also be
// the file you import to get at the types.

import { configure, DEFAULTS, resolvePort } from "./config.js";
import { describeThrown } from "./errors.js";
import { ChatServer } from "./server.js";

const config = configure(DEFAULTS, { port: resolvePort(process.argv[2]) });
const server = new ChatServer(config);

// The last net, and it is worth being clear about what it is for.
//
// It is not a second error boundary. The boundary is in handler.ts, where there
// is still a client to answer and one request to abandon. By the time a throw
// gets here, nobody knows what was half-done - a room joined but not announced,
// a buffer consumed but not parsed - and a process running on state it cannot
// describe is worse than a process that stopped. So: say something useful, then
// die honestly. Restarting is somebody else's job, and they are better at it.
process.on("uncaughtException", (error: Error) => {
  console.error(`FATAL - nothing caught this: ${describeThrown(error)}`);
  process.exit(1);
});

process.on("unhandledRejection", (reason: unknown) => {
  console.error(`FATAL - a promise rejected with nobody listening: ${describeThrown(reason)}`);
  process.exit(1);
});

// Ctrl-C: stop accepting connections, hang up on everyone, then exit.
process.on("SIGINT", () => {
  server.shutdown(() => process.exit(0));
});

server.listen(() => {
  for (const line of server.banner()) {
    console.log(line);
  }
});
