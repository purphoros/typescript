// The two things this server needs to remember, expressed as ports.
//
// For nine chapters `FileHistory` *was* the storage layer. handler.ts imported
// the class, bus.ts imported the class, and "where messages live" was
// `data/general.jsonl` as a matter of fact rather than a matter of choice.
//
// That was fine while there was one answer. It stops being fine the moment there
// are two - and there are now: a JSONL file and a SQLite database, which have
// genuinely different strengths and neither of which is wrong.
//
// So the strategy is Chapter 11's, one level up. Everything above these
// interfaces deals in `MessageStore` and `AccountStore` and cannot tell which
// implementation it has. The handler does not import SQLite. It could not open a
// database if it wanted to.

import type { MessageSummary, RoomName } from "./protocol.js";
import type { AdminUser, User } from "./types.js";

// What the server keeps about a person. The hash is here because storage is where
// hashes live; the *policy* - how to check one, what to say when it does not
// match - stays in auth.ts, which is a different question.
export interface Account {
  readonly user: User | AdminUser;
  readonly passwordHash: string;
}

export interface MessageStore {
  open(): Promise<void>;
  append(message: MessageSummary): Promise<void>;

  // The last `limit` messages in a room, oldest first.
  //
  // Note the shape of this. It is not "give me everything and I will slice it" -
  // that was the JSONL implementation leaking through the door, and it is the
  // difference between a query that stays fast forever and one that gets slower
  // every day the server runs.
  recent(room: RoomName, limit: number): Promise<MessageSummary[]>;

  // Free text, which a JSONL file can only answer by reading every byte it has.
  // This is the method that makes a database worth having, and - because the
  // query is text a stranger typed - it is also the one that would be an SQL
  // injection if anybody wrote it carelessly. See sqlite.ts.
  search(room: RoomName, query: string, limit: number): Promise<MessageSummary[]>;

  flush(): Promise<void>;
  close(): Promise<void>;
}

export interface AccountStore {
  open(): Promise<void>;
  find(name: string): Promise<Account | undefined>;
  save(account: Account): Promise<void>;
  names(): Promise<string[]>;
  close(): Promise<void>;
}

// One object holding both, because a SQLite file is one file and opening it twice
// would be silly. The interfaces stay separate - a future Postgres accounts store
// and an S3 message store is a perfectly reasonable thing to want - but the thing
// you are handed is allowed to be one object.
export interface Storage {
  readonly messages: MessageStore;
  readonly accounts: AccountStore;
}

// The accounts store that Chapter 17 actually had: a Map.
//
// It is here, named, rather than hidden inside `Accounts` - because that is what
// extracting a port *does*. What was an implicit assumption ("accounts live in
// memory and always will") becomes a class with a name, sitting next to the one
// that replaces it. You cannot choose between two things until both of them have
// names.
//
// It is also honest about what it is: `--storage file` gives you a JSONL log of
// messages and accounts that vanish on restart. That is a fine thing for a laptop
// and a terrible thing for a server, and it is now possible to say so.
export class MemoryAccounts implements AccountStore {
  private readonly byName = new Map<string, Account>();

  async open(): Promise<void> {}

  async find(name: string): Promise<Account | undefined> {
    return this.byName.get(name);
  }

  async save(account: Account): Promise<void> {
    this.byName.set(account.user.name, account);
  }

  async names(): Promise<string[]> {
    return [...this.byName.keys()];
  }

  async close(): Promise<void> {}
}
