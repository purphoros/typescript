import { describe, it, expect } from "vitest";
import { Router } from "./router.js";

const req = { method: "GET", path: "", version: "1.1", headers: new Map<string, string>(), body: undefined };
const ok = () => ({ status: 200, headers: {}, body: "" });

describe("Router", () => {
  const router = new Router()
    .on("GET", "/api/status", ok)
    .on("GET", "/api/rooms/:room", ok)
    .on("GET", "/api/rooms/:room/messages/:id", ok)
    .on("POST", "/api/echo", ok);

  it("captures a named parameter", () => {
    expect(router.match("GET", "/api/rooms/general")?.params).toEqual({ room: "general" });
  });

  it("captures several", () => {
    expect(router.match("GET", "/api/rooms/dev/messages/42")?.params).toEqual({ room: "dev", id: "42" });
  });

  it("percent-decodes, once, in one place", () => {
    expect(router.match("GET", "/api/rooms/a%20b")?.params).toEqual({ room: "a b" });
  });

  it("does not match a parameter against nothing", () => {
    expect(router.match("GET", "/api/rooms/")).toBeUndefined();
  });

  it("distinguishes 'no such path' from 'no such verb on this path'", () => {
    expect(router.methodsFor("/api/echo")).toEqual(["POST"]);   // -> 405, Allow: POST
    expect(router.methodsFor("/api/nonsense")).toEqual([]);     // -> 404
  });
});
