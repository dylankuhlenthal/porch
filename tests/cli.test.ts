import { describe, expect, it } from "vitest";

import { EXIT } from "../src/cli/exit-codes.js";
import { SCHEMA_VERSION } from "../src/types.js";
import { bin, cli, scratchEnv, schemaValidators } from "./helpers.js";
import { stubAdapter } from "./stub-adapter.js";

const v = schemaValidators();

describe("porch CLI (in process)", () => {
  it("lists, observes, delivers and reports status, with every output matching its JSON Schema", async () => {
    const env = scratchEnv();
    expect((await cli(["fake", "start", "s1", "--pid", "5"], env)).code).toBe(0);
    await cli(["fake", "set", "s1", "busy"], env);

    expect((await cli(["--help"], env)).stdout).toContain(`"schema": ${SCHEMA_VERSION}`);
    const list = await cli(["list"], env);
    expect(list.code).toBe(EXIT.ok);
    v.list!(list.json);
    expect(list.json.sessions[0]).toMatchObject({ harness: "fake", session: "s1", attached: true, status: "busy" });

    // A session without the inside part: only list --all shows it; observe finds it by name.
    await cli(["fake", "start", "bare", "--no-inside"], env);
    expect((await cli(["list"], env)).json.sessions.map((o: { session: string }) => o.session)).toEqual(["s1"]);
    const all = await cli(["list", "--all"], env);
    v.list!(all.json);
    expect(all.json.sessions.map((o: { session: string; attached: boolean }) => [o.session, o.attached])).toEqual([
      ["bare", false],
      ["s1", true],
    ]);
    expect((await cli(["observe", "bare"], env)).json).toMatchObject({ session: "bare", attached: false });

    // A session that ended: only list --all shows it; observe finds it by name, with how it ended.
    await cli(["fake", "start", "done"], env);
    const end = await cli(["fake", "end", "done", "--reason", "quit"], env);
    v.observation!(end.json);
    expect(end.json).toMatchObject({ status: "ended", endReason: "quit" });
    expect((await cli(["list"], env)).json.sessions.map((o: { session: string }) => o.session)).toEqual(["s1"]);
    const withEnded = await cli(["list", "--all"], env);
    v.list!(withEnded.json);
    expect(withEnded.json.sessions.map((o: { session: string; status: string }) => [o.session, o.status])).toEqual([
      ["bare", "unknown"],
      ["done", "ended"],
      ["s1", "busy"],
    ]);
    expect((await cli(["observe", "done"], env)).json).toMatchObject({ status: "ended", endReason: "quit" });

    const observe = await cli(["observe", "s1"], env);
    v.observation!(observe.json);

    const deliver = await cli(["deliver", "s1", "--from", "tests", "hello", "there"], env);
    expect(deliver.code).toBe(EXIT.ok);
    v.deliver!(deliver.json);
    expect(deliver.json).toMatchObject({ result: "delivered", statusAtSend: "busy" });

    const deliveries = await cli(["fake", "deliveries", "s1"], env);
    v["fake-deliveries"]!(deliveries.json);
    expect(deliveries.json.deliveries[0].text).toBe("[from tests] hello there");

    const setEnv = { ...env, PORCH_FAKE_SESSION_ID: "s1" };
    const status = await cli(["status", "set", "blocked", "waiting", "on", "CI"], setEnv);
    expect(status.code).toBe(EXIT.ok);
    v["status-set"]!(status.json);
    expect(status.json.self).toMatchObject({ status: "blocked", text: "waiting on CI" });

    const current = await cli(["current"], setEnv);
    v.current!(current.json);
    expect(current.json).toEqual({ schema: 2, harness: "fake", session: "s1" });
    v.current!((await cli(["current"], env)).json);

    const adapters = await cli(["adapters"], env);
    v.adapters!(adapters.json);

    v.version!((await cli(["--version"], env)).json);
  });

  it("reads the message from stdin when the text is - or missing", async () => {
    const env = scratchEnv();
    await cli(["fake", "start", "s1"], env);
    await cli(["deliver", "s1", "--from", "t", "-"], env, { stdin: "line one\nline two\n" });
    await cli(["deliver", "s1", "--from", "t"], env, { stdin: "from stdin" });
    const texts = (await cli(["fake", "deliveries"], env)).json.deliveries.map((d: { text: string }) => d.text);
    expect(texts).toEqual(["[from t] line one\nline two", "[from t] from stdin"]);
  });

  it("sets turn times and background tasks on a fake session, for modelling a stale busy record", async () => {
    const env = scratchEnv();
    await cli(["fake", "start", "s1"], env);
    const r = await cli(["fake", "set", "s1", "busy", "--last-turn-end", "2026-01-01T00:00:00Z", "--background-tasks", "2"], env);
    expect(r.json).toMatchObject({ status: "busy", detail: { lastTurnEnd: "2026-01-01T00:00:00.000Z", backgroundTasks: 2 } });
  });

  it("prints the deliver result and exits 4 when not delivered", async () => {
    const env = scratchEnv();
    const r = await cli(["deliver", "ghost", "--from", "t", "hi"], env);
    expect(r.code).toBe(EXIT.notDelivered);
    v.deliver!(r.json);
    expect(r.json.result).toBe("not-running");

    await cli(["fake", "start", "s1"], env);
    await cli(["fake", "fail-deliver", "s1", "broken pipe"], env);
    const failed = await cli(["deliver", "s1", "--from", "t", "hi"], env);
    expect(failed.code).toBe(EXIT.notDelivered);
    expect(failed.json).toMatchObject({ result: "failed", reason: "broken pipe" });
  });

  it.each([
    [["observe", "ghost"], EXIT.notFound, "not-found"],
    [["status", "set", "done"], EXIT.notInSession, "not-in-session"],
    [["frobnicate"], EXIT.usage, "usage"],
    [[], EXIT.usage, "usage"],
    [["list", "--bogus"], EXIT.usage, "usage"],
    [["list", "extra"], EXIT.usage, "usage"],
    [["list", "--all=yes"], EXIT.usage, "usage"],
    [["list", "--harness", "nope"], EXIT.usage, "usage"],
    [["observe"], EXIT.usage, "usage"],
    [["deliver", "s1", "hi"], EXIT.usage, "usage"],
    [["deliver", "s1", "--from", "a\nb", "hi"], EXIT.usage, "usage"],
    [["status", "set", "sleeping"], EXIT.usage, "usage"],
    [["status", "get"], EXIT.usage, "usage"],
    [["fake", "kill", "never-started"], EXIT.notFound, "not-found"],
    [["fake", "set", "never-started", "busy"], EXIT.notFound, "not-found"],
    [["fake", "start", "../escape"], EXIT.usage, "usage"],
    [["fake", "set", "s1", "sleeping"], EXIT.usage, "usage"],
    [["fake", "prompt", "s1"], EXIT.usage, "usage"],
    [["fake", "start", "s1", "--bogus"], EXIT.usage, "usage"],
    [["fake", "set", "s1", "busy", "--last-turn-end", "yesterday"], EXIT.usage, "usage"],
    [["fake", "set", "s1", "busy", "--background-tasks", "-1"], EXIT.usage, "usage"],
    [["fake", "end", "s1", "--reason", " "], EXIT.usage, "usage"],
  ])("porch %j fails as JSON with exit %i (%s)", async (argv, code, errorCode) => {
    const r = await cli(argv as string[], scratchEnv());
    expect(r.code).toBe(code);
    v.error!(r.json);
    expect(r.json.error.code).toBe(errorCode);
  });

  it("refuses to guess between two sessions claiming to be the caller", async () => {
    const adapters = [stubAdapter("aa", { current: async () => "1" }), stubAdapter("bb", { current: async () => "2" })];
    const r = await cli(["current"], scratchEnv(), { adapters });
    expect(r.code).toBe(EXIT.ambiguousSession);
    v.error!(r.json);
  });

  it("reports an unexpected failure as an internal error, exit 1", async () => {
    const adapters = [stubAdapter("aa", { current: async () => Promise.reject(new Error("boom")) })];
    const r = await cli(["current"], scratchEnv(), { adapters });
    expect(r.code).toBe(EXIT.internal);
    expect(r.json.error).toEqual({ code: "internal", message: "boom" });
  });

  it("routes adapter commands by their path, longest match first", async () => {
    const calls: string[][] = [];
    const adapter = stubAdapter("aa", {
      commands: [
        { path: ["hooks", "aa"], summary: "s", usage: "porch hooks aa", run: async (args) => (calls.push(["hooks", ...args]), 0) },
        { path: ["hooks", "aa", "x"], summary: "s", usage: "porch hooks aa x", run: async (args) => (calls.push(["x", ...args]), 7) },
      ],
    });
    expect((await cli(["hooks", "aa", "--flag"], scratchEnv(), { adapters: [adapter] })).code).toBe(0);
    expect((await cli(["hooks", "aa", "x", "y"], scratchEnv(), { adapters: [adapter] })).code).toBe(7);
    expect(calls).toEqual([["hooks", "--flag"], ["x", "y"]]);
    const help = await cli(["--help"], scratchEnv(), { adapters: [adapter] });
    expect(help.stdout).toContain("porch hooks aa x");
  });

  it("prints help on stdout for --help, listing the fake commands", async () => {
    const r = await cli(["--help"], scratchEnv());
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("porch deliver <session> --from <label>");
    expect(r.stdout).toContain("porch fake start");
  });
});

describe("porch binary (separate process)", () => {
  it("runs as a real command: exit codes, JSON on stdout, stdin for deliver", async () => {
    const env = scratchEnv();
    const start = await bin(["fake", "start", "b1"], env);
    expect(start.code).toBe(0);
    v.observation!(start.json);
    const d = await bin(["deliver", "b1", "--from", "bin", "-"], env, "via stdin");
    expect(d.code).toBe(0);
    expect(d.json.result).toBe("delivered");
    const nf = await bin(["observe", "missing"], env);
    expect(nf.code).toBe(3);
    v.error!(nf.json);
    const list = await bin(["list"], env);
    v.list!(list.json);
    expect(list.json.sessions).toHaveLength(1);
  });
});
