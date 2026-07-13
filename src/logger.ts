// Logging that a machine can read and a human can bear.
//
// Nineteen chapters of `console.log`, and it was fine, because I was the only one
// reading it and I was reading it in a terminal. That stops being true the moment
// the server runs somewhere you cannot see. Then a log line is not prose, it is a
// *record* - something a query has to find six months from now, at 3am, when the
// person searching does not know what they are looking for.
//
//   [general] alice: hello                       ← lovely. Ungreppable.
//   {"level":"info","time":"...","msg":"message","room":"general","user":"alice"}
//
// The second one you can filter by room, count by user, and alert on. The first
// one you can read.
//
// So: both. Pretty when a human is watching (stdout is a TTY), JSON when one is
// not. Nobody has to choose, and nobody has to remember to.

import { inspect } from "node:util";

export const LEVELS = ["debug", "info", "warn", "error"] as const;
export type LogLevel = (typeof LEVELS)[number];

// Ordering, so `warn` includes `error` and `debug` includes everything.
const RANK: Record<LogLevel, number> = { debug: 0, info: 1, warn: 2, error: 3 };

export type LogFormat = "pretty" | "json";

// Anything you want to attach to a line. `unknown`, not `any` - a field has to be
// serialised before it can be logged, and the serialiser is the one that decides
// what it can cope with.
export type Fields = Record<string, unknown>;

// Fields that must never reach a log, no matter who attaches them.
//
// This is not hypothetical. Chapter 17 handles a `{"type":"login","password":...}`
// message, and the single most natural debugging line in the world is
// `log.debug("message", { message })` - which would write every password on the
// server straight into a file that is, by design, kept forever and shipped
// somewhere central. Every large password leak you have read about had a step
// that looked exactly like that.
//
// The redaction is at the *sink*, deliberately: not at the call site, where
// somebody has to remember it, but at the one place nothing gets past.
const SECRET_KEYS = new Set(["password", "token", "secret", "authorization", "jwtsecret", "passwordhash"]);

function redact(value: unknown, depth = 0): unknown {
  if (depth > 4 || value === null || typeof value !== "object") {
    return value;
  }
  if (Array.isArray(value)) {
    return value.map((item) => redact(item, depth + 1));
  }
  const out: Fields = {};
  for (const [key, item] of Object.entries(value as Fields)) {
    out[key] = SECRET_KEYS.has(key.toLowerCase()) ? "[redacted]" : redact(item, depth + 1);
  }
  return out;
}

const COLOUR: Record<LogLevel, string> = {
  debug: "\x1b[90m", // grey
  info: "\x1b[36m",  // cyan
  warn: "\x1b[33m",  // yellow
  error: "\x1b[31m", // red
};
const RESET = "\x1b[0m";

export interface LoggerOptions {
  readonly level: LogLevel;
  readonly format: LogFormat;
  // Injected so a test can capture lines instead of printing them, and so
  // Chapter 19's rule holds: nothing in this file reaches for a global.
  readonly write?: (line: string) => void;
}

export class Logger {
  private readonly write: (line: string) => void;

  constructor(
    private readonly options: LoggerOptions,
    // Fields carried by every line this logger writes. A child logger bound to
    // `{ client: "c7" }` means every line about that client is findable without
    // anyone remembering to include it.
    private readonly bound: Fields = {},
  ) {
    this.write = options.write ?? ((line) => process.stdout.write(`${line}\n`));
  }

  child(fields: Fields): Logger {
    return new Logger(this.options, { ...this.bound, ...fields });
  }

  get level(): LogLevel {
    return this.options.level;
  }

  enabled(level: LogLevel): boolean {
    return RANK[level] >= RANK[this.options.level];
  }

  debug(msg: string, fields?: Fields): void { this.emit("debug", msg, fields); }
  info(msg: string, fields?: Fields): void  { this.emit("info", msg, fields); }
  warn(msg: string, fields?: Fields): void  { this.emit("warn", msg, fields); }
  error(msg: string, fields?: Fields): void { this.emit("error", msg, fields); }

  private emit(level: LogLevel, msg: string, fields?: Fields): void {
    // The level check comes first, before any formatting, any JSON.stringify, any
    // string concatenation. `log.debug("state", { registry })` costs *nothing* at
    // level=info - and that is what makes it reasonable to leave debug logging in
    // the code permanently instead of deleting it and rewriting it every time
    // something breaks.
    if (!this.enabled(level)) {
      return;
    }

    const record = redact({ ...this.bound, ...fields }) as Fields;

    if (this.options.format === "json") {
      // One line, one object, machine-readable. `level` and `time` first because
      // that is what every log aggregator expects to find.
      this.write(JSON.stringify({ level, time: new Date().toISOString(), msg, ...record }));
      return;
    }

    const time = new Date().toISOString().slice(11, 23);
    const tail = Object.keys(record).length > 0
      ? ` ${inspect(record, { colors: true, depth: 3, breakLength: Infinity, compact: true })}`
      : "";
    this.write(`${COLOUR[level]}${time} ${level.padEnd(5)}${RESET} ${msg}${tail}`);
  }
}

// What to do when nobody said. A TTY means a person is watching, so make it
// readable; anything else means a file or a pipe, which means a machine, so make
// it parseable.
export function defaultFormat(): LogFormat {
  return process.stdout.isTTY === true ? "pretty" : "json";
}

// > **On blocking, with numbers, because the numbers matter.**
// >
// > `process.stdout.write` is *synchronous* when stdout is a file or a TTY. Node
// > documents this and it is easy to read past: `npm start > server.log` turns
// > every log line into a blocking write, on the one thread that is also serving
// > every client.
// >
// > I expected that to be alarming. Measured, writing to a file:
// >
// >      10,000 lines     12ms blocked    1.17µs/line
// >     100,000 lines     53ms blocked    0.53µs/line
// >     500,000 lines    267ms blocked    0.53µs/line
// >
// > Half a microsecond. A chat server logs roughly one line per message, so at a
// > thousand messages a second that is about 0.5ms of blocking per second - real,
// > measurable, and not worth a moment's thought. At a hundred thousand lines a
// > second it is 53ms per second: five percent of the thread, gone, and *then* it
// > matters.
// >
// > So it is a trade with a threshold, not a bug. Synchronous means the last line
// > before a crash is *on the disk* - and that is precisely the line you will
// > want. Asynchronous (what pino does, via sonic-boom) is much faster and can
// > lose exactly that line. Sync is right here; `--log-level warn` is the escape
// > hatch; and if you are logging per-request at scale, reach for pino and mean it.
// >
// > The point is not the answer. It is that I did not know until I measured, and
// > neither did you.
