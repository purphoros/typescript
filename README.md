# Chapter 17 - Authentication & Sessions

Since Chapter 4, this server has had a comment in it promising that Chapter 17 would deal with something:

```typescript
const knownUsers = new Map([["alice", { adminLevel: 2, permissions: ["kick", "ban"] }]]);
// Chapter 17 replaces this with real authentication; for now a "nick" message
// simply claims an identity.
```

`{"type":"nick","name":"alice"}` made you an admin **because you said so**.

Thirteen chapters of type safety, a validated protocol, a bounded runtime, a branded id that cannot be confused with a nickname - all of it guarding a door that was propped open the entire time. It is worth sitting with that for a second, because it is the most important thing in the chapter: **types cannot tell you whether somebody is lying. They can only make sure the lie is well-formed.**

## The Shape of It

`nick` is gone. Two messages replace it, and the split is the design:

```json
{"type":"login","name":"alice","password":"correct-horse"}   → {"type":"token","token":"eyJhbGci..."}
{"type":"auth","token":"eyJhbGci..."}                        → {"type":"authenticated","user":"alice","admin":true}
```

The password is seen **once**, by one function, and then forgotten. Everything afterwards - including reconnecting tomorrow morning - happens with a token that expires on its own. The browser page does the second step for you and keeps the token, so a page reload does not mean typing a password again.

## JWT, built by hand

> **Warning**
>
> **Use a library in production.** `jose` and `jsonwebtoken` are audited, and they handle key rotation, JWKS, the other algorithms, and the mistakes you have not thought of yet. `src/jwt.ts` exists so that when you *do* import one, you know exactly what it is doing on your behalf - and so the two attacks below stop being trivia and become things you have personally defended against.

A JWT is three base64url strings joined by dots:

```
eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9 . eyJzdWIiOiJ1MSIsIm5hbWUi... . 4x8KfQ...
└──────── header ─────────────────┘   └──────── payload ──────┘   └ signature ┘
```

Decode the first two from a real token this server just issued:

```json
{"alg":"HS256","typ":"JWT"}
{"sub":"u1","name":"alice","admin":true,"iat":1783925502,"exp":1784011902}
```

**That is not encrypted. It is merely encoded.** Anyone holding the token can read every claim in it. Base64 is an envelope, not a lock - the signature proves the postcard was not *altered*, and does precisely nothing to stop it being *read*. Never put anything in a JWT you would not write on a postcard.

### Attack one: `alg: "none"`

The header is supplied by whoever sent the token. Early JWT libraries did the obvious, catastrophic thing: they read `alg` out of the header and used *that* algorithm to verify. So you send:

```json
{"alg":"none","typ":"JWT"}
{"sub":"u1","name":"alice","admin":true,"exp":9999999999}
```

...with an empty signature, and a library that trusts the header agrees the unsigned token is valid. You have just minted yourself an admin.

**The header must never decide how the header is checked.** We know what we issued:

```typescript
if (algorithm !== "HS256") {
  return err(new AuthError("Unsupported token algorithm.", ErrorCode.BadToken));
}
```

```
--- ATTACK: alg:none - forge an admin token with no signature ---
  mallory <- {"type":"error","code":"bad_token","message":"Unsupported token algorithm."}
```

### Attack two: the timing side channel

```typescript
if (signature === expected) { ... }    // NO
```

`===` on strings short-circuits at the first differing character. An attacker who can measure how long the comparison took learns whether the first byte was right, then the second, and can walk a valid signature out of you one byte at a time. It sounds far-fetched over a network. It has been done.

```typescript
function equalsConstantTime(a: string, b: string): boolean {
  const left = Buffer.from(a, "utf8");
  const right = Buffer.from(b, "utf8");
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);   // always compares every byte
}
```

The separate length check is fine here: an HMAC-SHA256 signature is always exactly 43 base64url characters, so its length tells an attacker nothing they did not know.

```
--- ATTACK: tamper with the payload, reuse the signature ---
  mallory <- {"type":"error","code":"bad_token","message":"Bad token signature."}
```

> **Note**
>
> The signature is checked **before the payload is parsed**, and then the payload is run through a Zod schema anyway. Both matter. A good signature means *we* wrote this token - it does not mean the token is the shape this version of the server expects. A token issued by last month's build, signed with the same secret, is perfectly authentic and may be missing a field. Chapter 14's rule does not stop applying just because the data is signed.

## Passwords

```typescript
export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const key = await scryptAsync(password, salt, KEY_LENGTH);
  return `scrypt$${salt.toString("base64url")}$${key.toString("base64url")}`;
}
```

**scrypt, not SHA-256.** A password hash must be *slow* - deliberately, expensively slow - because the attacker holding your leaked database is not going to guess once, they are going to guess ten billion times on a rented GPU. SHA-256 is fast, which is exactly the property you want in a checksum and exactly the one that gets your users' passwords cracked. scrypt is slow and, more importantly, **memory-hard**: each guess needs real RAM, which is what stops a GPU running fifty thousand of them in parallel.

The salt is random and per-user. Without it, two people who chose the same bad password get the same hash - crack one, crack both - and an attacker can precompute the ten million most common passwords **once** and reuse the answer against every database in the world.

The stored string carries its parameters (`scrypt$salt$key`) because you will change them one day, when computers get faster, and you will need to read the old ones.

### The two failures that must look identical

```typescript
const account = this.byName.get(name);

if (account === undefined) {
  // Hash anyway, against a throwaway.
  await checkPassword(password, DUMMY_HASH);
  return err(new AuthError("Wrong name or password.", ErrorCode.BadCredentials));
}
```

"No such user" and "wrong password" must be the **same answer**, because a server that distinguishes them is a free tool for enumerating who has an account here - and knowing that `alice` exists is the first half of attacking `alice`.

And it is not enough to say the same words. If "unknown user" returns in a microsecond while "wrong password" takes 100ms of scrypt, **the timing says what the message would not**. So the unknown-user path does the work anyway, against a dummy hash of a value nobody knows.

```
--- wrong password, and a user who does not exist ---
  alice <- {"type":"error","code":"bad_credentials","message":"Wrong name or password."}
  alice <- {"type":"error","code":"bad_credentials","message":"Wrong name or password."}
```

The log knows which was which. The stranger at the door does not.

## The line where privilege escalation lives

The token says `admin: true`. We signed it. It is authentic. **Do not read it.**

```typescript
const account = accounts.find(claims.value.name);
if (account === undefined) {
  return err(new AuthError("That account no longer exists.", ErrorCode.BadToken));
}

return ok({
  user: account.user,   // from the account. Never from the token.
  ...
});
```

A signed `admin: true` is still a permission flag **in the client's pocket**, and the whole discipline of authorization is: never ask the client what it is allowed to do. The `admin` claim is informational - the browser may use it to decide whether to draw a Kick button - and the server uses the account.

Re-reading the account also closes the revocation window. A token is valid for its entire lifetime and **cannot be recalled**, so an account deleted five minutes ago still has a perfectly good token in somebody's hands. Looking it up on every `auth` is what makes a token a *claim* rather than an authority.

## The Middleware Pattern

The switch in `handler.ts` answers *what does this message mean*. It should not also answer *is this person allowed to say it* and *have they said it forty times this second* - those are true of every message, and a rule that applies to everything belongs somewhere it is written once.

```typescript
export type Middleware = (
  client: ChatClient,
  message: ClientMessage,
  next: () => Promise<void>,
) => Promise<void>;
```

```typescript
this.pipeline = chain(rateLimit(20, 10), requireAuth(this.sessions));
```

**Order is an argument about cost.** `rateLimit` first, because it is the cheapest check in the building - one subtraction - and refusing a flood should not require doing the expensive thing first. Put auth first and a flood of unauthenticated messages makes the server do a map lookup per message before declining. Put rate-limiting first and it does arithmetic.

A middleware that refuses simply **throws** - and the `catch` in `handleLine`, unchanged since Chapter 10, turns it into an error message without knowing that middleware exists:

```typescript
const message = decoded.value;
await this.pipeline(client, message, () => this.handleMessage(client, message));
```

The gate list is typed:

```typescript
const OPEN: ReadonlySet<ClientMessageType> = new Set<ClientMessageType>([
  "login", "auth", "help", "quit",
]);
```

`Set<ClientMessageType>`, not `Set<string>`. Rename a message in `schemas.ts` and this stops compiling. **A door that quietly stops being locked because somebody renamed the thing behind it** is exactly the bug worth making impossible.

> **Warning**
>
> The `chain` function guards against a middleware calling `next()` twice. That is not paranoia: awaiting `next()` twice runs the entire rest of the chain twice - including the handler, including the broadcast - and the symptom is messages being delivered in duplicate, intermittently. Fail loudly instead.

## The secret

```typescript
if (e.NODE_ENV === "production" && e.JWT_SECRET === undefined) {
  console.error("JWT_SECRET is required in production. Refusing to start with a public default.");
  process.exit(1);
}
if (e.JWT_SECRET === undefined) {
  console.warn("⚠  JWT_SECRET is not set. Using the development default - do not deploy this.");
}
```

**A signing secret with a default is not a default, it is a published private key.** Every deployment that forgets to set it shares one, and anyone who has read this file can mint an admin token for any of them.

So in production its absence is fatal. In development it falls back, loudly - and the noise is the *feature*. A warning you see every single time you start the server is one you will eventually act on. A silent fallback is one you will ship.

## Try It

```bash
npm run build && npm start
```

```
⚠  JWT_SECRET is not set. Using the development default - do not deploy this.
```

```json
{"type":"join","room":"general"}
```
```json
{"type":"error","code":"unauthenticated","message":"Log in first, e.g. {\"type\":\"login\",\"name\":\"alice\",\"password\":\"correct-horse\"}"}
```

```json
{"type":"login","name":"alice","password":"correct-horse"}
{"type":"auth","token":"<the token you just got>"}
{"type":"join","room":"general"}
```

Now try to break in. Forge an admin token with no signature:

```bash
node -e 'const b=o=>Buffer.from(JSON.stringify(o)).toString("base64url");
console.log(b({alg:"none",typ:"JWT"})+"."+b({sub:"u1",name:"alice",admin:true,exp:9999999999})+".")'
```

```json
{"type":"error","code":"bad_token","message":"Unsupported token algorithm."}
```

And in production, without a secret:

```bash
NODE_ENV=production npm start
# JWT_SECRET is required in production. Refusing to start with a public default.
# exit 1
```

## Putting It Together

`src/jwt.ts`, `src/auth.ts` and `src/middleware.ts` are on the `chapter17` branch. The single most important line is the algorithm check.

The `alg:none` defence: the header must never decide how the header is checked. We know what we issued:

```typescript
    return err(new AuthError("Malformed token.", ErrorCode.BadToken));
  }
  if (algorithm !== "HS256") {
    return err(new AuthError("Unsupported token algorithm.", ErrorCode.BadToken));
  }
```

> **Tip**
>
> The full files show scrypt password hashing, constant-time comparison, and the rule that the admin flag comes from the account, never from the token. Use `jose` or `jsonwebtoken` in production - this is built by hand to show what they do for you.
## Exercise

1. Delete the `algorithm !== "HS256"` check and re-run the `alg:none` forgery. You are now an admin. Put it back, and never take it out of anything again.
2. Replace `equalsConstantTime` with `===`. Everything still works, every test passes, and you have introduced a vulnerability that no test you are likely to write will ever catch. What does that tell you about the limits of testing?
3. The browser page keeps the token in `localStorage`, which any script on the page can read - one XSS and the token is gone. An `httpOnly` cookie cannot be read by script. Why is a cookie awkward for a WebSocket, and what would you do about it?
4. Add a `revoked` set of token IDs (a `jti` claim) so a stolen token can be killed before it expires. Notice you have just reinvented a session table, and ask what the JWT was buying you.
5. `rateLimit(20, 10)` is per connection. Open forty connections. Now rate-limit per *account* instead - and then ask what happens to a user behind a corporate NAT if you rate-limit per IP.

## What's Next

The door is shut. Passwords are hashed with something slow, tokens are signed and verified in constant time, the `alg:none` forgery is refused, permissions come from the account rather than the client's copy of them, and a flood is refused before it costs anything.

The middleware chain we just built - `rateLimit → requireAuth → handler` - is a cross-cutting concern expressed as a wrapper. TypeScript has another way to express exactly that, one that has been in the language for years and is finally standardised. Next: **decorators and metadata**, and an honest look at when they earn their keep and when they are middleware with worse error messages.

---

Source: <https://purphoros.com/howto/typescript/auth>
