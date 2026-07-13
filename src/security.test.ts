import { describe, it, expect } from "vitest";
import { isOriginAllowed, defaultOrigins, securityHeaders, ConnectionLimits } from "./security.js";
import type { HttpRequest } from "./http.js";

const upgrade = (origin?: string): HttpRequest => {
  const headers = new Map<string, string>([["upgrade", "websocket"], ["connection", "Upgrade"]]);
  if (origin !== undefined) headers.set("origin", origin);
  return { method: "GET", path: "/", version: "1.1", headers, body: undefined };
};

const policy = { allowed: ["http://127.0.0.1:8080", "https://chat.example.com"], allowNonBrowser: true };

describe("Cross-Site WebSocket Hijacking", () => {
  // The vulnerability, stated as a test. Before this chapter, this returned true.
  it("refuses an upgrade from another website", () => {
    expect(isOriginAllowed(upgrade("https://evil.example"), policy)).toBe(false);
  });

  it("allows the page it actually serves", () => {
    expect(isOriginAllowed(upgrade("http://127.0.0.1:8080"), policy)).toBe(true);
  });

  // The two classic ways people get this wrong. Both of these pass an
  // `endsWith`/`startsWith` check, and both are attacker-controlled domains.
  it.each([
    "https://chat.example.com.evil.net",   // beats startsWith
    "https://evil-chat.example.com",        // beats endsWith on a bad boundary
    "https://chat.example.com:9999",        // a different port is a different origin
    "http://chat.example.com",              // a different scheme is a different origin
    "null",                                  // a sandboxed iframe sends this
  ])("refuses %o", (origin) => {
    expect(isOriginAllowed(upgrade(origin), policy)).toBe(false);
  });

  // nc, wscat, a mobile app, a script. None of them send an Origin, and none of
  // them can be tricked into attaching somebody else's credentials - which is the
  // entire problem Origin exists to solve.
  it("allows a non-browser client with no Origin at all", () => {
    expect(isOriginAllowed(upgrade(undefined), policy)).toBe(true);
  });

  it("can refuse browsers entirely - the right answer for a server with no web UI", () => {
    const headless = { allowed: [], allowNonBrowser: true };
    expect(isOriginAllowed(upgrade("http://127.0.0.1:8080"), headless)).toBe(false);
    expect(isOriginAllowed(upgrade(undefined), headless)).toBe(true);
  });

  it("derives its own origins from where it is listening", () => {
    expect(defaultOrigins("127.0.0.1", 8080)).toContain("http://127.0.0.1:8080");
    expect(defaultOrigins("0.0.0.0", 8080)).toContain("http://localhost:8080");
  });
});

describe("securityHeaders", () => {
  it("refuses to be framed, sniffed, or to load anything external", () => {
    const h = securityHeaders();
    expect(h["X-Frame-Options"]).toBe("DENY");
    expect(h["X-Content-Type-Options"]).toBe("nosniff");
    expect(h["Content-Security-Policy"]).toContain("default-src 'none'");
    expect(h["Content-Security-Policy"]).toContain("frame-ancestors 'none'");
  });
});

describe("ConnectionLimits", () => {
  it("caps how many sockets one address may hold", () => {
    const limits = new ConnectionLimits(100, 2);
    expect(limits.refuse("1.2.3.4")).toBeUndefined();
    limits.opened("1.2.3.4");
    limits.opened("1.2.3.4");
    expect(limits.refuse("1.2.3.4")).toContain("too many");
    expect(limits.refuse("5.6.7.8")).toBeUndefined();   // somebody else is fine
  });

  it("caps the server as a whole", () => {
    const limits = new ConnectionLimits(2, 100);
    limits.opened("a"); limits.opened("b");
    expect(limits.refuse("c")).toBe("server is full");
  });

  // A Map keyed by every IP that has ever connected is a slow memory leak with a
  // respectable job title.
  it("forgets an address once its last connection closes", () => {
    const limits = new ConnectionLimits(100, 5);
    limits.opened("1.2.3.4");
    limits.closed("1.2.3.4");
    expect(limits.addressCount).toBe(0);
    expect(limits.openCount).toBe(0);
  });
});
