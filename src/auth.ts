// Proving who you are, rather than announcing it.
//
// Since Chapter 4 the server has had this, with a comment promising Chapter 17
// would deal with it:
//
//     const knownUsers = new Map([["alice", { adminLevel: 2, ... }]]);
//     // a "nick" message simply claims an identity
//
// `{"type":"nick","name":"alice"}` made you an admin because you said so. Twelve
// chapters of type safety, a validated protocol, a bounded runtime - guarding a
// door that was propped open the whole time. Types cannot tell you whether
// somebody is lying; they can only make sure the lie is well-formed.

import { randomBytes, scrypt, timingSafeEqual } from "node:crypto";
import { promisify } from "node:util";
import { issue, verify, type JwtPayload } from "./jwt.js";
import { timed, type Measured } from "./decorators.js";
import { AuthError, ErrorCode, type ChatError, type Result } from "./errors.js";
import type { Metrics } from "./runtime.js";
import type { Account, AccountStore } from "./store.js";
import type { ClientId, User, AdminUser } from "./types.js";

const scryptAsync = promisify(scrypt) as (
  password: string,
  salt: Buffer,
  keylen: number,
) => Promise<Buffer>;

const KEY_LENGTH = 64;

// --- Passwords -----------------------------------------------------------

// Passwords are never stored. What is stored is proof that you could produce one.
//
// scrypt, not SHA-256. A password hash must be *slow* - deliberately, expensively
// slow - because the attacker with your leaked database is not going to guess
// once, they are going to guess ten billion times on a rented GPU. SHA-256 is
// fast, which is exactly the property you want in a checksum and exactly the one
// that gets your users' passwords cracked. scrypt is slow and, more importantly,
// *memory-hard*: it needs a lot of RAM per guess, which is what stops a GPU from
// running fifty thousand guesses in parallel.
//
// The salt is random and per-user. Without it, two people who chose the same bad
// password get the same hash, and cracking one cracks both - and an attacker can
// precompute the answers for the ten million most common passwords once and reuse
// them against every database in the world.
export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const key = await scryptAsync(password, salt, KEY_LENGTH);
  // Store the parameters alongside the hash. When you change them - and you will,
  // because computers get faster - you need to be able to read the old ones.
  return `scrypt$${salt.toString("base64url")}$${key.toString("base64url")}`;
}

export async function checkPassword(password: string, stored: string): Promise<boolean> {
  const [scheme, salt, expected] = stored.split("$");
  if (scheme !== "scrypt" || salt === undefined || expected === undefined) {
    return false;
  }

  const expectedKey = Buffer.from(expected, "base64url");
  const actualKey = await scryptAsync(password, Buffer.from(salt, "base64url"), expectedKey.length);

  // Constant time, for the same reason as the JWT signature: a comparison that
  // returns early tells the attacker how much of the answer they had right.
  return timingSafeEqual(actualKey, expectedKey);
}

// --- Accounts ------------------------------------------------------------
//
// `Account` moved to store.ts, because it is a storage shape. What is left here is
// the *policy*: how a login is checked, what is said when it fails, and how long
// the wrong answer is made to take. That is not a database's business, and now it
// is not in the database's file.

export class Accounts implements Measured {
  constructor(
    private readonly store: AccountStore,
    readonly metrics: Metrics,
  ) {}

  // Seeding hashes takes real time - that is the whole point of scrypt - so it
  // happens once, at startup, and not on the first login while somebody waits.
  //
  // Chapter 21 replaces this with a database. The shape does not change: something
  // hands back an Account with a hash in it, and nothing above this line knows
  // whether that came from a Map or from Postgres.
  async seedDefaults(): Promise<void> {
    // Only if there is nobody. A seed that runs on every boot would reset alice's
    // password back to the one printed in a book every time you restarted the
    // server, which is a memorable way to learn what "idempotent" means.
    if ((await this.store.names()).length > 0) {
      return;
    }
    await this.add(
      { id: "u1", name: "alice", joinedAt: Date.now(), adminLevel: 2, permissions: ["kick", "ban", "mute"] },
      "correct-horse",
    );
    await this.add({ id: "u2", name: "bob", joinedAt: Date.now() }, "hunter2");
  }

  async add(user: User | AdminUser, password: string): Promise<void> {
    await this.store.save({ user, passwordHash: await hashPassword(password) });
  }

  async names(): Promise<string[]> {
    return this.store.names();
  }

  async find(name: string): Promise<Account | undefined> {
    return this.store.find(name);
  }

  // A login attempt. Note what the two failure paths have in common: nothing the
  // caller can tell apart.
  //
  // "No such user" and "wrong password" must be the *same* answer, because a
  // server that distinguishes them is a free tool for enumerating who has an
  // account here - and knowing that alice exists is the first half of attacking
  // alice. The log may know the difference. The stranger at the door may not.
  // The slowest thing this server does on purpose. Worth watching: if
  // `accounts.login.meanMs` ever drops to near zero, somebody has "optimised" the
  // password hash and the passwords are no longer safe.
  @timed("accounts")
  async login(name: string, password: string): Promise<Result<Account, ChatError>> {
    const account = await this.store.find(name);

    if (account === undefined) {
      // Hash anyway, against a throwaway. Otherwise "unknown user" returns in a
      // microsecond and "wrong password" takes 100ms, and the timing alone tells
      // an attacker which names are real - which is the thing we just went to the
      // trouble of not saying out loud.
      await checkPassword(password, DUMMY_HASH);
      return { ok: false, error: new AuthError("Wrong name or password.", ErrorCode.BadCredentials) };
    }

    if (!(await checkPassword(password, account.passwordHash))) {
      return { ok: false, error: new AuthError("Wrong name or password.", ErrorCode.BadCredentials) };
    }

    return { ok: true, value: account };
  }
}

// A real, valid scrypt hash of a value nobody knows, so the "no such user" path
// does the same work as the "wrong password" path. Computed once at load.
const DUMMY_HASH = `scrypt$${randomBytes(16).toString("base64url")}$${randomBytes(KEY_LENGTH).toString("base64url")}`;

// --- Sessions ------------------------------------------------------------

// What a client earns by presenting a valid token. Distinct from the token
// itself: the token is a bearer credential that lives in the client's hands and
// that we cannot take back, and this is our record of *this connection*, which we
// can revoke the instant we like.
export interface Session {
  readonly user: User | AdminUser;
  readonly authenticatedAt: number;
  readonly expiresAt: number;   // milliseconds, matching Date.now()
}

export class Sessions {
  private readonly byClient = new Map<ClientId, Session>();

  // Keyed by ClientId, and Chapter 16's brand is why that is safe. A session map
  // keyed by "whatever string was handy" is the same bug as a room keyed by a
  // nickname, and it would be a considerably worse one to have.
  establish(client: ClientId, session: Session): void {
    this.byClient.set(client, session);
  }

  // An expired session is not a session. Checking on read rather than sweeping on
  // a timer means there is no window in which a stale one is still honoured - and
  // no timer holding the event loop open (Chapter 15).
  get(client: ClientId): Session | undefined {
    const session = this.byClient.get(client);
    if (session === undefined) {
      return undefined;
    }
    if (session.expiresAt <= Date.now()) {
      this.byClient.delete(client);
      return undefined;
    }
    return session;
  }

  revoke(client: ClientId): void {
    this.byClient.delete(client);
  }

  get size(): number {
    return this.byClient.size;
  }
}

// --- The two doors -------------------------------------------------------

// Password in, token out. This is the only place a password is ever seen.
export async function authenticate(
  accounts: Accounts,
  name: string,
  password: string,
  secret: string,
  ttlSeconds: number,
): Promise<Result<{ token: string; expiresAt: number; user: User | AdminUser }, ChatError>> {
  const attempt = await accounts.login(name, password);
  if (!attempt.ok) {
    return attempt;
  }

  const { user } = attempt.value;
  const admin = "adminLevel" in user;
  const { token, expiresAt } = issue({ sub: user.id, name: user.name, admin }, secret, ttlSeconds);

  return { ok: true, value: { token, expiresAt, user } };
}

// Token in, session out. This is the door every reconnect comes through, and it
// never sees a password.
export async function resume(
  accounts: Accounts,
  token: string,
  secret: string,
): Promise<Result<Session, ChatError>> {
  const claims: Result<JwtPayload, ChatError> = verify(token, secret);
  if (!claims.ok) {
    return claims;
  }

  // The token says who you are. It does not say what you may do, and it does not
  // say you still exist.
  //
  // Both of those have to be re-established from the account, every time, and
  // this is the line where privilege escalation lives or dies. The token carries
  // `admin: true` - we signed it, so it is authentic - and it would be extremely
  // convenient to read it. It is also a permission flag *in the client's pocket*,
  // and the whole discipline of authorization is: never ask the client what it is
  // allowed to do.
  //
  // The `admin` claim is therefore informational only. The browser page may use
  // it to decide whether to draw a Kick button. The server uses the account.
  //
  // Re-reading the account also closes the revocation window: a token is valid
  // for its entire lifetime and cannot be recalled, so an account deleted five
  // minutes ago still has a perfectly good token in somebody's hands. Looking it
  // up here is what makes a token a *claim* rather than an authority.
  const account = await accounts.find(claims.value.name);
  if (account === undefined) {
    return { ok: false, error: new AuthError("That account no longer exists.", ErrorCode.BadToken) };
  }

  return {
    ok: true,
    value: {
      user: account.user, // from the account. Never from the token.
      authenticatedAt: Date.now(),
      expiresAt: claims.value.exp * 1000,
    },
  };
}
