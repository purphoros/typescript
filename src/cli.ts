// The command line, taken seriously.
//
// For nineteen chapters the entire interface was this:
//
//     const config = fromEnvironment(process.env, process.argv);
//     ...argv[2] !== undefined ? { port: resolvePort(argv[2]) } : {}
//
// One positional argument, undocumented, discoverable only by reading the source.
// `npm start --port 9000` did nothing at all - silently, because argv[2] was
// "--port", which is not a number, so it fell back to the default and said
// nothing. A flag that is ignored without complaint is worse than a flag that
// does not exist.
//
// `node:util` has shipped `parseArgs` since Node 18. No dependency, no yargs, no
// commander.

import { parseArgs } from "node:util";
import { LEVELS, type LogFormat, type LogLevel } from "./logger.js";

export interface CliOptions {
  readonly host?: string;
  readonly port?: number;
  readonly rooms?: string[];
  readonly dataDir?: string;
  readonly logLevel?: LogLevel;
  readonly logFormat?: LogFormat;
}

// What `--help` prints. Kept next to the parser, because help text that lives
// somewhere else is help text that is wrong.
export const USAGE = `chat-server - one port, three protocols.

Usage:
  chat-server [options]

Options:
  -p, --port <n>          Port to listen on            (default 8080)
  -H, --host <addr>       Address to bind              (default 127.0.0.1)
      --rooms <a,b,c>     Permanent rooms              (default general,random,dev)
      --data-dir <path>   Where history is written     (default ./data)
      --log-level <lvl>   debug | info | warn | error  (default info)
      --log-format <fmt>  pretty | json                (default: pretty on a TTY, json otherwise)
  -h, --help              Show this and exit
  -v, --version           Print the version and exit

Settings are read from the command line, then the environment, then the defaults -
in that order, so the more deliberate one wins:

  chat-server --port 9000
  PORT=9000 chat-server
  JWT_SECRET=... NODE_ENV=production chat-server    (required in production)
`;

// A parse either produced options, or it wants the process to stop - and "stop"
// is not always a failure. `--help` succeeded; it just has nothing left to do.
// A discriminated union says all three, and the caller cannot forget one.
export type CliResult =
  | { kind: "run"; options: CliOptions }
  | { kind: "exit"; message: string; code: number };

function isLogLevel(value: string): value is LogLevel {
  return (LEVELS as readonly string[]).includes(value);
}

export function parseCli(argv: readonly string[], version: string): CliResult {
  let values: Record<string, string | boolean | undefined>;

  try {
    ({ values } = parseArgs({
      args: [...argv],
      options: {
        port: { type: "string", short: "p" },
        host: { type: "string", short: "H" },
        rooms: { type: "string" },
        "data-dir": { type: "string" },
        "log-level": { type: "string" },
        "log-format": { type: "string" },
        help: { type: "boolean", short: "h" },
        version: { type: "boolean", short: "v" },
      },
      // Unknown flags are an error, not a shrug. `--pORT 9000` should tell you it
      // is wrong, not start on 8080 and let you find out from a monitoring
      // dashboard two hours later.
      strict: true,
      allowPositionals: false,
    }));
  } catch (thrown: unknown) {
    const detail = thrown instanceof Error ? thrown.message : String(thrown);
    return { kind: "exit", message: `${detail}\n\n${USAGE}`, code: 1 };
  }

  if (values.help === true) {
    return { kind: "exit", message: USAGE, code: 0 };
  }
  if (values.version === true) {
    return { kind: "exit", message: version, code: 0 };
  }

  const options: {
    host?: string; port?: number; rooms?: string[];
    dataDir?: string; logLevel?: LogLevel; logFormat?: LogFormat;
  } = {};

  if (typeof values.host === "string") {
    options.host = values.host;
  }

  if (typeof values.port === "string") {
    const port = Number(values.port);
    if (!Number.isInteger(port) || port < 1 || port > 65535) {
      return { kind: "exit", message: `--port: "${values.port}" is not a port (1-65535).`, code: 1 };
    }
    options.port = port;
  }

  if (typeof values.rooms === "string") {
    const rooms = values.rooms.split(",").map((room) => room.trim()).filter(Boolean);
    if (rooms.length === 0 || rooms.some((room) => !/^[a-z0-9-]+$/.test(room))) {
      return { kind: "exit", message: `--rooms: expected lowercase names, e.g. general,random`, code: 1 };
    }
    options.rooms = rooms;
  }

  if (typeof values["data-dir"] === "string") {
    options.dataDir = values["data-dir"];
  }

  if (typeof values["log-level"] === "string") {
    if (!isLogLevel(values["log-level"])) {
      return { kind: "exit", message: `--log-level: expected ${LEVELS.join(" | ")}.`, code: 1 };
    }
    options.logLevel = values["log-level"];
  }

  if (typeof values["log-format"] === "string") {
    const format = values["log-format"];
    if (format !== "pretty" && format !== "json") {
      return { kind: "exit", message: `--log-format: expected pretty | json.`, code: 1 };
    }
    options.logFormat = format;
  }

  return { kind: "run", options };
}
