# Chapter 21 - Database Persistence

Chapter 12 gave the server history that survives a restart: one append-only JSONL file per room. It was a good answer. It is still a good answer for a lot of things - it survives a torn write, you can read it with `cat`, and with a few thousand messages it is instant.

Here is what it does to answer *"the last ten messages in #general"*:

```typescript
async recent(room: RoomName, limit: number): Promise<MessageSummary[]> {
  const all = await this.read(room);    // read the entire file
  return all.slice(-limit);             // throw away all but ten
}
```

Read every byte. Parse every line. Discard 99.99% of it.

Measured, with a hundred thousand messages:

```
READ: the last 10 messages in #general, with 100,000 rows
  sqlite (index)                0.03ms per read
  jsonl   (read everything)    13.18ms per read   -> 488x slower
```

**488 times.** And that number is not a constant - it is the size of the file. Tomorrow it is worse. That is what a database is for, and it is the whole chapter.

## First, a port

For nine chapters `FileHistory` *was* the storage layer. `handler.ts` imported the class. `bus.ts` imported the class. "Where messages live" was `data/general.jsonl` as a matter of fact rather than a matter of choice.

That is fine while there is one answer. It stops being fine the moment there are two.

```typescript
export interface MessageStore {
  open(): Promise<void>;
  append(message: MessageSummary): Promise<void>;
  recent(room: RoomName, limit: number): Promise<MessageSummary[]>;
  search(room: RoomName, query: string, limit: number): Promise<MessageSummary[]>;
  flush(): Promise<void>;
  close(): Promise<void>;
}
```

This is Chapter 11's argument one level up. Everything above these interfaces deals in `MessageStore` and `AccountStore` and **cannot tell which implementation it has**. The handler does not import SQLite. It could not open a database if it wanted to.

Look at the shape of `recent`. It is not *"give me everything and I will slice it"* - that was the JSONL implementation leaking through the interface, and it is precisely the difference between a query that stays fast forever and one that gets slower every day the server runs. **An interface that encodes one implementation's weakness is not an interface, it is a class with extra steps.**

> **Tip**
>
> Extracting the port is also what forced `MemoryAccounts` into existence. Chapter 17's accounts lived in a `Map` - an *implicit assumption* that nobody had ever written down. Give it a name and put it next to the thing that replaces it, and suddenly you can say the true sentence: "`--storage file` means your accounts vanish on restart." You cannot choose between two things until both of them have names.

## The index is the chapter

```sql
CREATE TABLE messages (
  id      INTEGER PRIMARY KEY,
  room    TEXT    NOT NULL,
  sender  TEXT    NOT NULL,
  text    TEXT    NOT NULL,
  at      INTEGER NOT NULL
);

CREATE INDEX idx_messages_room_at ON messages (room, at);
```

Every read this server does is *"the last N in one room"*. So the index is on **the column you filter by, then the column you order by**. SQLite walks straight to the right room, reads N rows backwards off the end of the index, and stops. It never looks at the other 999,990.

```sql
SELECT room, sender, text, at FROM (
  SELECT room, sender, text, at FROM messages
  WHERE room = ? ORDER BY at DESC LIMIT ?
) ORDER BY at ASC
```

`DESC ... LIMIT` reads backwards and stops early; the outer query flips it to oldest-first, which is what the wire wants.

## Transactions, and the fsync you did not know you were paying for

```
WRITES (100,000 messages)
  sqlite, one transaction      181ms
  sqlite, no transaction      5788ms
  jsonl file                  5284ms
```

**Thirty-two times.** Not because the inserts got faster - because they stopped being a hundred thousand *transactions*.

Outside an explicit transaction, SQLite wraps every statement in its own, and every transaction ends in an `fsync` - a physical conversation with a disk about whether the bytes are really, definitely there. A hundred thousand of those is a hundred thousand round trips.

```typescript
transaction<T>(work: () => T): T {
  this.db.exec("BEGIN");
  try {
    const result = work();
    this.db.exec("COMMIT");
    return result;
  } catch (thrown: unknown) {
    this.db.exec("ROLLBACK");
    throw thrown;
  }
}
```

The speed is a side effect. The *point* is that everything in `work` happens or none of it does - which is what makes the migration below safe, because **half a schema is worse than no schema.**

## Migrations are append-only, like the log they replaced

```typescript
const MIGRATIONS: readonly string[] = [
  `CREATE TABLE messages (...); CREATE INDEX ...; CREATE TABLE accounts (...);`,
];
```

SQLite tracks the version for us in `user_version`, a single integer in the file header. No migrations table, no bookkeeping.

**Migrations are numbered, and they are never edited - only appended to.** The one on disk has already run somewhere; changing it does not change the database it already built, it just means two deployments now disagree about what version 1 *was*. That is how you get a Friday evening.

And the guard that matters:

```typescript
if (current > MIGRATIONS.length) {
  throw new Error(
    `database is at schema v${current}, this build only knows v${MIGRATIONS.length}. Refusing to run.`,
  );
}
```

Running an old binary against a *newer* schema is how you get silent data loss - the old code writes to columns that have moved, or ignores ones it does not know about. A rollback that half-works is worse than one that refuses. So: refuse.

## The injection

`search` is the first thing in this entire server that puts **free text a stranger typed** into a query.

```typescript
// The naive version:
db.exec(`SELECT * FROM messages WHERE text LIKE '%${query}%'`)
```

Send `%'; DROP TABLE messages; --` and it does exactly what it says.

```typescript
this.searchMessages = this.db.prepare(`
  SELECT room, sender, text, at FROM messages
  WHERE room = ? AND text LIKE ? ESCAPE '\\'
  ORDER BY at DESC LIMIT ?
`);
```

A bound parameter does not interpolate. SQLite receives the *statement* and the *value* down separate channels, and **a value can never become syntax.** That is the fix. It is not "escape the quotes" - escaping is a game you have to win every single time, and the attacker only has to win once.

```
--- SQL INJECTION: the query is free text a stranger typed ---
  malicious query -> results (0 hits, table intact)
  messages table after the injection attempt: 3 rows. Still there.
```

> **Warning**
>
> Note the `ESCAPE`, and the line that escapes `%` and `_` before binding. Those are LIKE wildcards, so a search for `100%` would otherwise match *everything containing "100"*. That is not a security bug, it is a correctness bug - and it is exactly the same shape: **a value being read as syntax.** Once you have seen the pattern, you see it everywhere: shell arguments, HTML, log injection, CSV formulas.

## The honest bit about search

```
SEARCH: free text in #general
  sqlite       7.1ms
  jsonl       14.5ms
```

Only **twice** as fast, not 488 times - and you should ask why before you believe the rest of the chapter.

`LIKE '%needle%'` cannot use an index. A leading wildcard means the answer could be anywhere, so SQLite scans every row too. It wins only because it is scanning compact rows instead of parsing a hundred thousand JSON objects.

To make search genuinely fast you need an inverted index - SQLite's FTS5 - which is a different schema and a different chapter. **The index in this chapter makes `recent` fast. It does nothing for `search`, and saying otherwise would be selling you something.**

## And now the awkward part: it is synchronous

`node:sqlite` is `DatabaseSync`. Every query blocks the event loop. Chapter 12 went to considerable trouble to make history asynchronous, and this appears to undo all of it.

It does not, and the reason is worth being precise about.

Chapter 12's disk write went through the OS, through a filesystem, possibly over a network, and took **milliseconds** - during which the server could be serving somebody else, and `await` is what let it. A prepared SQLite statement against a local file is **tens of microseconds**. Blocking the event loop for 40µs is not a problem; it is cheaper than the Promise you would allocate to avoid it.

So the methods are `async` and synchronous underneath, and the interface stays `Promise`-shaped anyway - because the day this becomes Postgres over a network, the signature does not change and neither does one line above it.

**What is honest is sync underneath an async signature. What is dishonest is an async signature that makes you think a slow thing is safe.** The moment a query here takes 40ms instead of 40µs, it will block every client - and Chapter 15's `eventLoopMaxMs` is the thing that will tell you.

## Two implementations, one contract

The port is only real if two things satisfy it:

```typescript
describe.each([
  ["sqlite", async () => { ... }],
  ["file",   async () => { ... }],
])("MessageStore contract: %s", (_name, make) => {
  it("appends and reads back in order", async () => { ... });
  it("finds text", async () => { ... });
  it("returns nothing for a room nobody has spoken in", async () => { ... });
});
```

The same expectations, run against both, and **neither knows the difference**. That test file is the proof that `MessageStore` is an interface and not a description of SQLite.

> **Tip**
>
> The handler tests now build a `SqliteStorage(":memory:")` - a real database, real migrations, real prepared statements, real SQL, and nothing on disk. Chapter 19 had to clean a directory up *before as well as after*, because an interrupted run left a file that poisoned the next one. **There is no file now.** A test that cannot be poisoned by a previous run is better than a test that remembers to tidy.

## Putting It Together

`src/store.ts` defines the ports; `src/sqlite.ts` implements them. Both are on the `chapter21` branch. Here are the two pieces that matter.

The schema, as numbered migrations. The index on `(room, at)` is the entire performance story - SQLite walks straight to the room and reads N rows off the end:

```typescript
const MIGRATIONS: readonly string[] = [
  // 1 - messages and accounts.
  `
  CREATE TABLE messages (
    id      INTEGER PRIMARY KEY,      -- rowid: monotonic, so it doubles as insertion order
    room    TEXT    NOT NULL,
    sender  TEXT    NOT NULL,
    text    TEXT    NOT NULL,
    at      INTEGER NOT NULL          -- ms since epoch, as Date.now() gives it
  );

  -- The whole chapter, in one line.
  --
  -- Every read this server does is "the last N in one room", so the index is on
  -- (room, at) - the column we filter by, then the column we order by. SQLite
  -- walks straight to the right room, reads N rows backwards off the end of the
  -- index, and stops. It never looks at the other 999,990.
  CREATE INDEX idx_messages_room_at ON messages (room, at);

  CREATE TABLE accounts (
    name          TEXT    PRIMARY KEY,   -- the nickname, and the login
    id            TEXT    NOT NULL,
    password_hash TEXT    NOT NULL,
    admin_level   INTEGER NOT NULL DEFAULT 0,
    permissions   TEXT    NOT NULL DEFAULT '',   -- comma separated; a JSON column would also do
    joined_at     INTEGER NOT NULL
  );
  `,
];
```

And `search`, the first query built from text a stranger typed. It goes down as a bound parameter, so a value can never become SQL syntax:

```typescript
  @timed("sqlite")
  async search(room: RoomName, query: string, limit: number): Promise<MessageSummary[]> {
    const escaped = query.replace(/[\\%_]/g, (char) => `\\${char}`);
    const rows = this.storage
      .statements()
      .searchMessages.all(room, `%${escaped}%`, limit) as unknown as MessageRow[];
    return rows.map(toSummary);
  }
```

> **Tip**
>
> The complete, runnable file is `src/sqlite.ts` on the `chapter21` branch. You are not meant to paste it wholesale - build your own as you follow along, and use the reference to check yourself.

## Try It

```bash
npm run build && npm start
```

```json
{"type":"login","name":"alice","password":"correct-horse"}
{"type":"auth","token":"..."}
{"type":"join","room":"general"}
{"type":"chat","text":"the deploy went fine"}
{"type":"chat","text":"lunch?"}
{"type":"search","query":"deploy"}
```

```json
{"type":"results","room":"general","query":"deploy","messages":[{"sender":"alice","text":"the deploy went fine",...}]}
```

Now try to burn it down:

```json
{"type":"search","query":"%'; DROP TABLE messages; --"}
```

```
  malicious query -> results (0 hits, table intact)
```

Look at what is on disk, and restart:

```bash
ls data/
# chat.db  chat.db-shm  chat.db-wal
sqlite3 data/chat.db "select room, count(*) from messages group by room"
```

And the other implementation is still there, because it is a *choice* now:

```bash
npm start -- --storage file     # back to data/general.jsonl. Accounts vanish on restart.
```

## Exercise

1. Add a `SELECT * FROM messages WHERE text LIKE '%' || ? || '%'` version without the `ESCAPE` clause and search for `100%`. Explain the results to somebody who has not read this chapter.
2. Drop the index (`DROP INDEX idx_messages_room_at`) and re-run the read benchmark with 100,000 rows. Then put it back. That is the chapter, in one number.
3. Add migration #2: a `rooms` table with `created_at` and `topic`. Start the server - it migrates. Now check out the previous commit and start *that* binary against the same file. Read the error you get, and be glad of it.
4. `search` is O(n) because `LIKE '%x%'` cannot use an index. Add an FTS5 virtual table and make it O(log n). How do you keep it in sync with `messages`, and what happens if the two disagree?
5. Make a query slow on purpose - `SELECT ... WHERE text LIKE ?` over a million rows - and hit `/api/health` while it runs. Watch `eventLoopMaxMs`. That is what "synchronous" costs, and it is the number that tells you when the argument in this chapter stops being true.

## What's Next

The server has an index, transactions, migrations that refuse to run backwards, and a query surface that a stranger cannot turn into syntax. Storage is a choice rather than an assumption.

There is a `/api/rooms` and a `/api/history` and a `/api/health`, and they grew one at a time, whenever a chapter needed to show something. They are not an API; they are a pile of endpoints.

Next: **the REST API** - and the auth we already built, finally applied to HTTP.

---

Written for this repository. Upstream: <https://purphoros.com/howto/typescript/database>
