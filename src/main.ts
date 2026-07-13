// The entry point: parse the command line, build a config, load what the last run
// wrote down, and start.
//
// Note the `await` at the top level, outside any function. That is legal only
// because Chapter 11 made this package genuinely ESM - a CommonJS module cannot do
// it, because `require()` is synchronous and has nowhere to put the waiting.

import { createRequire } from "node:module";
import { parseCli } from "./cli.js";
import { resolveConfig, usingDefaultSecret } from "./config.js";
import { describeThrown } from "./errors.js";
import { Logger } from "./logger.js";
import { ChatServer } from "./server.js";

// The version comes from package.json, and from nowhere else. A version string
// typed into a source file is a version string that is wrong the moment somebody
// runs `npm version patch` - and `--version` lying is worse than `--version` not
// existing, because somebody will use it to decide whether a bug is fixed.
const version = (createRequire(import.meta.url)("../package.json") as { version: string }).version;

// --help and --version are *successes*. They are not the program failing to run,
// they are the program doing exactly what was asked and having nothing left to do.
// Exit code 0. A CI script that runs `chat-server --version` should not fail.
const cli = parseCli(process.argv.slice(2), version);
if (cli.kind === "exit") {
  (cli.code === 0 ? process.stdout : process.stderr).write(`${cli.message}\n`);
  process.exit(cli.code);
}

const config = resolveConfig(process.env, cli.options);
const logger = new Logger({ level: config.logLevel, format: config.logFormat });
const server = new ChatServer(config, logger);

if (usingDefaultSecret(config)) {
  // Loudly, every single time. A warning you see on every start is a warning you
  // will eventually act on; a silent fallback is one you will ship.
  logger.warn("JWT_SECRET is not set - using the development default. Do not deploy this.");
}

// Read the archive back before accepting a single connection. A client that
// connects and immediately asks for history must not race the disk.
await server.load();

// The last net. Not a second error boundary: by the time a throw arrives here,
// nobody knows what was half-done, and a process running on state it cannot
// describe is worse than a process that stopped.
process.on("uncaughtException", (error: Error) => {
  logger.error("nothing caught this", { fatal: true, error: describeThrown(error) });
  process.exit(1);
});

process.on("unhandledRejection", (reason: unknown) => {
  logger.error("a promise rejected with nobody listening", { fatal: true, error: describeThrown(reason) });
  process.exit(1);
});

// Two signals, one door.
//
// SIGINT is Ctrl-C: a person, at a terminal, watching. SIGTERM is what every
// process supervisor in the world sends first - systemd, Docker, Kubernetes - and
// then, about ten seconds later, SIGKILL, which cannot be caught or negotiated
// with. A server that handles only SIGINT looks flawless on a laptop and loses
// data on every single deploy.
let leaving = false;

const leave = (signal: NodeJS.Signals): void => {
  if (leaving) {
    logger.warn("signal again - abandoning any writes still in the queue", { signal });
    process.exit(1);
  }
  leaving = true;
  logger.info("shutting down", { signal });

  void server
    .shutdown()
    .then(() => process.exit(0))
    .catch((thrown: unknown) => {
      logger.error("shutdown failed", { error: describeThrown(thrown) });
      process.exit(1);
    });
};

process.on("SIGINT", () => leave("SIGINT"));
process.on("SIGTERM", () => leave("SIGTERM"));

server.listen(() => {
  // The resolved configuration, once, at startup - because the single most common
  // production question is "what is it actually running with", and the answer
  // should not require reading three files and a deploy script to reconstruct.
  //
  // The secret is not in it. See the redaction in logger.ts, which would have
  // caught it anyway.
  logger.info("listening", {
    host: config.host,
    port: config.port,
    rooms: config.rooms,
    dataDir: config.dataDir,
    logLevel: config.logLevel,
    version,
  });

  if (logger.enabled("debug")) {
    for (const line of server.banner()) {
      logger.debug(line);
    }
  }
});
