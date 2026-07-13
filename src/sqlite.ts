// A real database, and the reason it is worth having.
//
// `FileHistory.recent(room, 10)` reads the *entire* file, parses every line, and
// throws away all but the last ten. That is not a criticism of Chapter 12 - an
// append-only log is a genuinely excellent thing, it survives a torn write, and
// with a few thousand messages it is instant. It is a criticism of what happens
// on day four hundred.
//
// A B-tree does not care how much you have. That is the entire pitch.

import { DatabaseSync, type StatementSync } from "node:sqlite";
import path from "node:path";
import { mkdir } from "node:fs/promises";
import { timed, type Measured } from "./decorators.js";
import type { Logger } from "./logger.js";
import type { Metrics } from "./runtime.js";
import type { MessageSummary, RoomName } from "./protocol.js";
import type { Account, AccountStore, MessageStore, Storage } from "./store.js";
import type { AdminUser, User } from "./types.js";

// The schema, as a list of steps.
//
// Migrations are numbered and they are never edited - only appended to. The one
// on disk has already run somewhere; changing it does not change the database it
// already built, it just means two deployments now disagree about what version 1
// was. That is how you get a Friday evening.
//
// SQLite tracks this for us in `user_version`, a single integer in the file
// header. No migrations table, no bookkeeping.
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

// node:sqlite hands back objects with a *null prototype* - no `toString`, no
// `hasOwnProperty`, and `{...row}` works but `row instanceof Object` is false.
// It is the right call (a column called `constructor` cannot hurt you) and it is
// startling the first time a `JSON.stringify` behaves oddly. So rows are mapped
// into real objects at the boundary, once, here.
interface MessageRow {
  room: string;
  sender: string;
  text: string;
  at: number;
}

interface AccountRow {
  name: string;
  id: string;
  password_hash: string;
  admin_level: number;
  permissions: string;
  joined_at: number;
}

export class SqliteStorage implements Storage, Measured {
  private db!: DatabaseSync;

  // Statements are prepared *once* and reused. SQLite parses the SQL, plans the
  // query, and hands back a compiled thing; doing that afresh for every message
  // is most of the cost of a small query.
  private insertMessage!: StatementSync;
  private selectRecent!: StatementSync;
  private selectPage!: StatementSync;
  private searchMessages!: StatementSync;
  private selectAccount!: StatementSync;
  private upsertAccount!: StatementSync;
  private selectNames!: StatementSync;

  readonly messages: MessageStore;
  readonly accounts: AccountStore;

  constructor(
    private readonly file: string,
    readonly metrics: Metrics,
    private readonly logger: Logger,
  ) {
    this.messages = new SqliteMessages(this);
    this.accounts = new SqliteAccounts(this);
  }

  async open(): Promise<void> {
    if (this.file !== ":memory:") {
      await mkdir(path.dirname(this.file), { recursive: true });
    }

    this.db = new DatabaseSync(this.file);

    // WAL: readers do not block the writer and the writer does not block readers.
    // For a server that appends constantly and reads constantly, this is not a
    // tuning knob, it is the difference between working and not.
    this.db.exec("PRAGMA journal_mode = WAL");

    // Without this, SQLite does not enforce a foreign key it has been told about.
    // It is off by default for backwards compatibility with 2005.
    this.db.exec("PRAGMA foreign_keys = ON");

    this.migrate();

    this.insertMessage = this.db.prepare(
      "INSERT INTO messages (room, sender, text, at) VALUES (?, ?, ?, ?)",
    );

    // ORDER BY at DESC LIMIT ? - the index is read backwards and stopped early.
    // The outer query flips it back to oldest-first, which is what the wire wants.
    this.selectRecent = this.db.prepare(`
      SELECT room, sender, text, at FROM (
        SELECT room, sender, text, at FROM messages
        WHERE room = ? ORDER BY at DESC LIMIT ?
      ) ORDER BY at ASC
    `);

    // Cursor pagination. `at < ?` walks the same (room, at) index backwards from
    // a point in time, so page 2 costs exactly what page 1 did - which is the
    // thing OFFSET cannot promise, because OFFSET has to count past the rows it
    // is skipping.
    this.selectPage = this.db.prepare(`
      SELECT room, sender, text, at FROM (
        SELECT room, sender, text, at FROM messages
        WHERE room = ? AND at < ? ORDER BY at DESC LIMIT ?
      ) ORDER BY at ASC
    `);

    // The interesting one. See SqliteMessages.search.
    this.searchMessages = this.db.prepare(`
      SELECT room, sender, text, at FROM messages
      WHERE room = ? AND text LIKE ? ESCAPE '\\'
      ORDER BY at DESC LIMIT ?
    `);

    this.selectAccount = this.db.prepare("SELECT * FROM accounts WHERE name = ?");
    this.selectNames = this.db.prepare("SELECT name FROM accounts ORDER BY name");
    this.upsertAccount = this.db.prepare(`
      INSERT INTO accounts (name, id, password_hash, admin_level, permissions, joined_at)
      VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(name) DO UPDATE SET
        password_hash = excluded.password_hash,
        admin_level   = excluded.admin_level,
        permissions   = excluded.permissions
    `);
  }

  // Run every migration the file has not seen. Idempotent: start the server
  // twice and the second run does nothing.
  private migrate(): void {
    const row = this.db.prepare("PRAGMA user_version").get() as { user_version: number } | undefined;
    const current = row?.user_version ?? 0;

    if (current > MIGRATIONS.length) {
      // The database was written by a *newer* build than this one. Running an old
      // binary against a new schema is how you get silent data loss, so: stop.
      throw new Error(
        `database is at schema v${current}, this build only knows v${MIGRATIONS.length}. Refusing to run.`,
      );
    }

    for (let version = current; version < MIGRATIONS.length; version++) {
      const sql = MIGRATIONS[version];
      if (sql === undefined) {
        continue;
      }
      // A migration is all-or-nothing. Half a schema is worse than none, and the
      // transaction is the only thing standing between you and finding that out.
      this.db.exec("BEGIN");
      try {
        this.db.exec(sql);
        // Not a bound parameter: PRAGMA does not take them. It is an integer we
        // computed from a constant array, not anything a stranger can reach.
        this.db.exec(`PRAGMA user_version = ${version + 1}`);
        this.db.exec("COMMIT");
        this.logger.info("migrated", { from: version, to: version + 1 });
      } catch (thrown: unknown) {
        this.db.exec("ROLLBACK");
        throw thrown;
      }
    }
  }

  // Everything in `work` happens, or none of it does.
  //
  // It is also, incidentally, about a hundred times faster than the same inserts
  // outside one - because SQLite otherwise treats each statement as its own
  // transaction, and each transaction is an fsync, and an fsync is a physical
  // conversation with a disk. See the numbers in the chapter.
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

  // The prepared statements, handed out to the two stores below. No explicit
  // return type: it would be a second list of the same fields, and a second list
  // is a second thing to forget to update.
  statements() {
    return {
      insertMessage: this.insertMessage,
      selectRecent: this.selectRecent,
      selectPage: this.selectPage,
      searchMessages: this.searchMessages,
      selectAccount: this.selectAccount,
      upsertAccount: this.upsertAccount,
      selectNames: this.selectNames,
    };
  }

  close(): void {
    this.db.close();
  }
}

// --- Messages ------------------------------------------------------------

class SqliteMessages implements MessageStore, Measured {
  constructor(private readonly storage: SqliteStorage) {}

  get metrics(): Metrics {
    return this.storage.metrics;
  }

  async open(): Promise<void> {
    await this.storage.open();
  }

  // Every one of these is `async` and every one of them is, underneath,
  // completely synchronous. `node:sqlite` is `DatabaseSync`: it blocks.
  //
  // That deserves a straight answer rather than a shrug, because Chapter 12 went
  // to real trouble to make history asynchronous and this appears to undo it.
  //
  // It does not, because the two are not the same problem. Chapter 12's disk write
  // went through the OS, through a filesystem, possibly over a network, and took
  // milliseconds - during which the server could be serving somebody else, and
  // `await` is what let it. A prepared SQLite statement against a local file is
  // tens of *microseconds*. Blocking the event loop for 40µs is not a problem; it
  // is cheaper than the Promise you would allocate to avoid it.
  //
  // The interface stays `Promise`-shaped anyway, and that is the point of an
  // interface: the day this becomes Postgres over a network, the signature does
  // not change and neither does one line above it. What is honest is *sync
  // underneath an async signature*. What is dishonest is an async signature that
  // makes you think a slow thing is safe. The moment a query here takes 40ms
  // instead of 40µs, it will block every client, and Chapter 15's
  // `eventLoopMaxMs` is the thing that will tell you.
  @timed("sqlite")
  async append(message: MessageSummary): Promise<void> {
    this.storage.statements().insertMessage.run(message.room, message.sender, message.text, message.at);
  }

  @timed("sqlite")
  async recent(room: RoomName, limit: number): Promise<MessageSummary[]> {
    const rows = this.storage.statements().selectRecent.all(room, limit) as unknown as MessageRow[];
    return rows.map(toSummary);
  }

  @timed("sqlite")
  async page(room: RoomName, limit: number, before?: number): Promise<MessageSummary[]> {
    const cursor = before ?? Number.MAX_SAFE_INTEGER;
    const rows = this.storage.statements().selectPage.all(room, cursor, limit) as unknown as MessageRow[];
    return rows.map(toSummary);
  }

  // Free text from a stranger, put into a query. This is the SQL injection, and
  // it is worth being explicit about what does and does not save us.
  //
  // The naive version writes:
  //
  //     db.exec(`SELECT * FROM messages WHERE text LIKE '%${query}%'`)
  //
  // and a query of `%'; DROP TABLE messages; --` does what it says. The bound
  // parameter below does not interpolate anything: SQLite receives the statement
  // and the value down *separate channels*, and a value can never become syntax.
  // That is the fix. It is not "escape the quotes"; escaping is a game you have to
  // win every single time.
  //
  // Note also the LIKE escaping. `%` and `_` are wildcards, so a search for `100%`
  // would otherwise match everything containing "100". That is not a security bug,
  // it is a correctness bug, and it is the same shape: a value being read as
  // syntax.
  @timed("sqlite")
  async search(room: RoomName, query: string, limit: number): Promise<MessageSummary[]> {
    const escaped = query.replace(/[\\%_]/g, (char) => `\\${char}`);
    const rows = this.storage
      .statements()
      .searchMessages.all(room, `%${escaped}%`, limit) as unknown as MessageRow[];
    return rows.map(toSummary);
  }

  // Nothing is buffered, so there is nothing to flush. SQLite committed before it
  // returned - which is exactly the durability Chapter 12 had to build a queue and
  // a drain to get.
  async flush(): Promise<void> {}

  async close(): Promise<void> {
    this.storage.close();
  }
}

function toSummary(row: MessageRow): MessageSummary {
  return { room: row.room, sender: row.sender, text: row.text, at: row.at };
}

// --- Accounts ------------------------------------------------------------

class SqliteAccounts implements AccountStore {
  constructor(private readonly storage: SqliteStorage) {}

  async open(): Promise<void> {
    await this.storage.open();
  }

  async find(name: string): Promise<Account | undefined> {
    const row = this.storage.statements().selectAccount.get(name) as unknown as AccountRow | undefined;
    return row === undefined ? undefined : toAccount(row);
  }

  async save(account: Account): Promise<void> {
    const user = account.user;
    const admin = "adminLevel" in user ? user : undefined;
    this.storage.statements().upsertAccount.run(
      user.name,
      user.id,
      account.passwordHash,
      admin?.adminLevel ?? 0,
      admin?.permissions.join(",") ?? "",
      user.joinedAt,
    );
  }

  async names(): Promise<string[]> {
    const rows = this.storage.statements().selectNames.all() as unknown as { name: string }[];
    return rows.map((row) => row.name);
  }

  async close(): Promise<void> {
    this.storage.close();
  }
}

function toAccount(row: AccountRow): Account {
  const base: User = { id: row.id, name: row.name, joinedAt: row.joined_at };
  const user: User | AdminUser =
    row.admin_level > 0
      ? { ...base, adminLevel: row.admin_level, permissions: row.permissions.split(",").filter(Boolean) }
      : base;
  return { user, passwordHash: row.password_hash };
}
