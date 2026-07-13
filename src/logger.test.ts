import { describe, it, expect } from "vitest";
import { Logger } from "./logger.js";
import { parseCli } from "./cli.js";

const capture = () => {
  const lines: string[] = [];
  return { lines, log: new Logger({ level: "debug", format: "json", write: (l) => lines.push(l) }) };
};

describe("Logger", () => {
  it("writes one JSON object per line, with level and time first", () => {
    const { lines, log } = capture();
    log.info("listening", { port: 8080 });
    const record = JSON.parse(lines[0]!);
    expect(record.level).toBe("info");
    expect(record.msg).toBe("listening");
    expect(record.port).toBe(8080);
    expect(typeof record.time).toBe("string");
  });

  // The reason redaction lives at the sink and not the call site: nobody has to
  // remember it, and the most natural debug line in the world is safe by default.
  it("redacts secrets, however deeply they are buried", () => {
    const { lines, log } = capture();
    log.debug("client said", { message: { type: "login", name: "alice", password: "correct-horse" } });
    log.info("issued", { token: "eyJhbGciOiJIUzI1NiJ9.x.y" });
    log.info("config", { jwtSecret: "super-secret", port: 8080 });
    const all = lines.join("\n");
    expect(all).not.toContain("correct-horse");
    expect(all).not.toContain("eyJhbGci");
    expect(all).not.toContain("super-secret");
    expect(all).toContain("[redacted]");
    expect(all).toContain("alice");   // the non-secret fields survive
  });

  it("does not even format a line below the level", () => {
    const log = new Logger({
      level: "error",
      format: "json",
      write: () => { throw new Error("must not be called"); },
    });
    expect(() => log.debug("expensive", { huge: "x".repeat(1000) })).not.toThrow();
  });

  it("child loggers carry their fields onto every line", () => {
    const { lines, log } = capture();
    log.child({ client: "c7" }).info("connected");
    expect(JSON.parse(lines[0]!).client).toBe("c7");
  });
});

describe("parseCli", () => {
  it("--help exits 0, because asking for help is not a failure", () => {
    const r = parseCli(["--help"], "1.0.0");
    expect(r).toMatchObject({ kind: "exit", code: 0 });
  });

  it("--version prints the version", () => {
    const r = parseCli(["--version"], "1.2.3");
    expect(r).toMatchObject({ kind: "exit", code: 0, message: "1.2.3" });
  });

  it("refuses an unknown flag instead of ignoring it", () => {
    const r = parseCli(["--pORT", "9000"], "1.0.0");
    expect(r.kind).toBe("exit");
    if (r.kind === "exit") expect(r.code).toBe(1);
  });

  it.each([["--port", "banana"], ["--port", "70000"], ["--log-level", "shouting"], ["--log-format", "yaml"]])(
    "refuses %s %s",
    (flag, value) => {
      const r = parseCli([flag, value], "1.0.0");
      expect(r.kind).toBe("exit");
    },
  );

  it("parses the good ones", () => {
    const r = parseCli(["--port", "9000", "--rooms", "a,b", "--log-level", "debug"], "1.0.0");
    expect(r).toMatchObject({
      kind: "run",
      options: { port: 9000, rooms: ["a", "b"], logLevel: "debug" },
    });
  });
});
