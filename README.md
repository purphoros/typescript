# Chapter 20 - Logging, Config & CLI

Nineteen chapters of `console.log`, and it was fine, because I was the only one reading it and I was reading it in a terminal. That stops being true the moment the server runs somewhere you cannot see.

And nineteen chapters of this, which is worse:

```typescript
const config = fromEnvironment(process.env, process.argv);
// ...argv[2] !== undefined ? { port: resolvePort(argv[2]) } : {}
```

One positional argument, undocumented, discoverable only by reading the source. `npm start --port 9000` did **nothing at all** - silently, because `argv[2]` was the string `"--port"`, which is not a number, so it fell back to the default and said nothing about it. **A flag that is ignored without complaint is worse than a flag that does not exist.**

## A log line is a record, not a sentence

```
[general] alice: hello
{"level":"info","time":"2026-07-13T15:52:30.015Z","msg":"→ alice joined general","client":"c1","user":"alice","room":"general"}
```

The first one you *read*. The second one you can filter by room, count by user, alert on, and find six months from now at 3am when the person searching does not know what they are looking for.

So: **both**, and nobody has to choose.

```typescript
export function defaultFormat(): LogFormat {
  return process.stdout.isTTY === true ? "pretty" : "json";
}
```

A TTY means a person is watching, so make it readable. Anything else - a pipe, a file, a container's stdout - means a machine, so make it parseable. The one thing you must never do is make somebody *remember* to pass `--log-format json` in production, because one day they will not.

`msg` is for the person. Everything after it is for the machine.

## Levels are a decision about privacy, not just volume

```typescript
bus.on("message", (message) =>
  logger.debug(formatEvent(...), { user: message.sender, room: message.room, bytes: message.text.length }));
```

A chat message is logged at **debug**, and that is deliberate. It is the highest-volume event on the server *and* it is the one thing a chat server exists to keep private. At `--log-level info` - the default - the operator sees who joined what, and **nothing they said**:

```
  occurrences of a message body in the log: 0
```

Note `bytes` rather than `text`. You can still answer "is someone flooding us" without keeping a transcript of everyone's conversation on a disk in Virginia.

And the level check happens **before any formatting**:

```typescript
private emit(level: LogLevel, msg: string, fields?: Fields): void {
  if (!this.enabled(level)) {
    return;                    // no JSON.stringify, no concatenation, no cost
  }
```

That is what makes it reasonable to leave debug logging in the code *permanently*, instead of deleting it and rewriting it from scratch every time something breaks.

## Redaction belongs at the sink

Here is the most natural debugging line in the world, typed at 2am by someone chasing a login bug:

```typescript
log.debug("client said", { message });
```

`message` is a `{"type":"login","name":"alice","password":"correct-horse"}`. That line writes **every password on the server** into a file which is, by design, kept forever and shipped somewhere central. Every large credential leak you have read about had a step that looked exactly like that.

```typescript
const SECRET_KEYS = new Set(["password", "token", "secret", "authorization", "jwtsecret", "passwordhash"]);
```

The redaction is in the **sink**, not at the call site - not somewhere a person has to remember it, but at the one place nothing gets past:

```json
{"level":"debug","msg":"client said","message":{"type":"login","name":"alice","password":"[redacted]"}}
{"level":"info","msg":"issued","token":"[redacted]","user":"alice"}
{"level":"info","msg":"config","jwtSecret":"[redacted]","port":8080}
```

The name survives. The password does not. **Nobody had to remember anything.**

## I measured the thing I was about to be confident about

`process.stdout.write` is **synchronous** when stdout is a file or a TTY. Node documents it, and it is easy to read past. So `npm start > server.log` turns every log line into a blocking write, on the one thread that is also serving every client.

I was about to write a paragraph about how alarming that is. Then I measured it:

```
  stdout redirected to a FILE (synchronous writes):
     10,000 lines     12ms blocked    1.17µs/line
    100,000 lines     53ms blocked    0.53µs/line
    500,000 lines    267ms blocked    0.53µs/line
```

**Half a microsecond a line.** A chat server logs roughly one line per message, so at a thousand messages a second that is about 0.5ms of blocking per second: real, measurable, and not worth a moment's thought. At a hundred thousand lines a second it is 53ms per second - five percent of the thread, gone - and *then* it matters.

So it is a trade with a threshold, not a bug:

- **Synchronous** means the last line before a crash is *on the disk*. That is precisely the line you will want.
- **Asynchronous** (what pino does, via `sonic-boom`) is much faster and can lose exactly that line.

Sync is right here. `--log-level warn` is the escape hatch. If you are logging per-request at scale, reach for pino and mean it.

The point is not the answer. **I did not know until I measured, and neither did you.**

## A command line, taken seriously

`node:util` has shipped `parseArgs` since Node 18. No dependency, no yargs, no commander.

```typescript
({ values } = parseArgs({
  args: [...argv],
  options: {
    port: { type: "string", short: "p" },
    "log-level": { type: "string" },
    help: { type: "boolean", short: "h" },
    version: { type: "boolean", short: "v" },
    // ...
  },
  strict: true,            // unknown flags are an error, not a shrug
  allowPositionals: false,
}));
```

The result is a discriminated union, because a parse has **three** outcomes and the caller must not be able to forget one:

```typescript
export type CliResult =
  | { kind: "run"; options: CliOptions }
  | { kind: "exit"; message: string; code: number };
```

> **Tip**
>
> **`--help` exits 0.** It is not the program failing to run; it is the program doing exactly what was asked and having nothing left to do. Print it to *stdout*, not stderr. A CI script that runs `chat-server --version` should not fail, and `chat-server --help | less` should work.
>
> Errors go to stderr with code 1. The distinction is not pedantry - it is the difference between a pipeline that works and one that mysteriously does not.

And `--version` reads from `package.json`:

```typescript
const version = (createRequire(import.meta.url)("../package.json") as { version: string }).version;
```

A version string typed into a source file is wrong the moment somebody runs `npm version patch` - and **`--version` lying is worse than `--version` not existing**, because somebody will use it to decide whether a bug is fixed.

## Precedence

```
  command line   →   environment   →   defaults
```

Specific beats general; immediate beats standing. That is not a convention to memorise, it is the order of how **deliberate** each source is: you typed the flag thirty seconds ago, the environment was set by a deploy last March, and the default was chosen by me for a laptop.

```bash
PORT=7777 chat-server --port 8099
#   listening on port 8099 (env said 7777, CLI said 8099)
```

## Putting It Together

`src/logger.ts` and `src/cli.ts` are on the `chapter20` branch. The line that matters most is the one that keeps secrets out of the log.

Redaction at the sink, so `log.debug("msg", { message })` cannot leak a password no matter who wrote the call:

```typescript
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
```

> **Tip**
>
> The full `cli.ts` uses `node:util`'s `parseArgs` - no dependency - with `strict: true`, so an unknown flag is an error rather than a shrug.
## Try It

```bash
npm run build
node dist/main.js --help
```

```
chat-server - one port, three protocols.

Usage:
  chat-server [options]

Options:
  -p, --port <n>          Port to listen on            (default 8080)
  ...
```

Now get it wrong on purpose, which is the part that used to be silent:

```bash
node dist/main.js --pORT 9000       # Unknown option '--pORT'          exit 1
node dist/main.js --port banana     # --port: "banana" is not a port   exit 1
node dist/main.js --log-level shouting
```

Human logs when a human is watching, machine logs when one is not:

```bash
npm start                           # pretty, coloured, a TTY
npm start > server.log              # JSON, one object per line
cat server.log | jq 'select(.room == "general")'
```

And the one that should make you nervous until you check it:

```bash
node dist/main.js --log-level debug > server.log
# ...log in as alice...
grep correct-horse server.log       # nothing. The sink caught it.
```

## Exercise

1. Add a `password` field to a log call somewhere. Grep the output for it. Now add a field called `userPassword` - does the redactor catch it? Should it? What is the cost of making `SECRET_KEYS` a substring match instead of an exact one?
2. `--log-level debug` logs message bodies. That is a privacy decision made in one line of `bus.ts`. Find it, and decide whether *anyone* should be able to turn it on in production.
3. Point `write` at an array and assert on the lines - that is what `logger.test.ts` does. Now do the same in `handler.test.ts`, and assert that logging in with a bad password produces a `warn` and no password.
4. Measure the blocking yourself, on your machine, with your disk. Do you get 0.53µs? Now try it over NFS.
5. Add `--config <path>` reading a JSON file, and slot it into the precedence chain. Where does it go - above the environment or below it? Defend your answer.

## What's Next

The server can be operated: a real command line, a config whose precedence is written down, and logs that a machine can query and that do not contain anybody's password.

What it still has is `data/general.jsonl` - an append-only text file, read entirely into memory to answer a query, with no index, no transactions, and a `Map` of two hard-coded accounts. It has worked, and it has been honest about what it was.

Next: **database persistence.**

---

Written for this repository. Upstream: <https://purphoros.com/howto/typescript/logging-config>
