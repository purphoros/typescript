// The decoder, and the line Chapter 10 drew that Chapter 14 had to work to keep.
import { describe, it, expect } from "vitest";
import { decodeClientMessage, parsePort } from "./protocol.js";
import { ErrorCode } from "./errors.js";

const decode = (value: unknown) => decodeClientMessage(JSON.stringify(value));

describe("decodeClientMessage", () => {
  it("accepts a well-formed message and hands back a NEW object", () => {
    const result = decode({ type: "chat", text: "hello" });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value).toEqual({ type: "chat", text: "hello" });
  });

  it("narrows: the inferred union still discriminates", () => {
    const result = decode({ type: "join", room: "general" });
    if (!result.ok) throw new Error("expected ok");
    // If this compiles, z.infer produced a real discriminated union.
    if (result.value.type === "join") expect(result.value.room).toBe("general");
  });

  // This table IS the contract. Chapter 10 promised two different kinds of
  // failure, and Chapter 14 rebuilt the validator on Zod without losing them.
  // A Zod upgrade that silently reclassified an error would break here, loudly.
  describe("structural failures are protocol errors", () => {
    const cases: [string, unknown][] = [
      ["a missing field",       { type: "join" }],
      ["a wrong type",          { type: "chat", text: 123 }],
      ["an unknown type",       { type: "jion", room: "general" }],
      ["a typo'd key",          { type: "chat", txet: "hello" }],
      ["not an object",         "just a string"],
    ];
    for (const [label, value] of cases) {
      it(label, () => {
        const result = decode(value);
        expect(result.ok).toBe(false);
        if (!result.ok) expect(result.error.code).toBe(ErrorCode.InvalidMessage);
      });
    }
    it("not even JSON", () => {
      const result = decodeClientMessage("this is not json");
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error.code).toBe(ErrorCode.InvalidMessage);
    });
  });

  describe("constraint failures are validation errors", () => {
    const cases: [string, unknown][] = [
      ["empty text",            { type: "chat", text: "" }],
      ["text over 1000 chars",  { type: "chat", text: "a".repeat(1001) }],
      ["a nickname with a space", { type: "login", name: "has a space", password: "x" }],
      ["an UPPERCASE room",     { type: "join", room: "General" }],
      ["a negative limit",      { type: "history", limit: -3 }],
    ];
    for (const [label, value] of cases) {
      it(label, () => {
        const result = decode(value);
        expect(result.ok).toBe(false);
        if (!result.ok) expect(result.error.code).toBe(ErrorCode.Validation);
      });
    }
  });

  it("names the key you fat-fingered", () => {
    const result = decode({ type: "chat", txet: "hello" });
    if (result.ok) throw new Error("expected failure");
    expect(result.error.message).toContain("txet");
  });
});

describe("parsePort", () => {
  it("accepts a real port", () => {
    const r = parsePort("8080");
    expect(r.ok && r.value).toBe(8080);
  });
  it.each(["0", "70000", "banana", "", "-1"])("refuses %o", (input) => {
    expect(parsePort(input).ok).toBe(false);
  });
});
