import { spawn } from "node:child_process";
import { promises as fs, utimesSync, writeFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { sessionsDir } from "../src/home.js";
import { withLock } from "../src/fsutil.js";
import { CorruptRecordError, RecordError, RecordStore } from "../src/records.js";
import { REPO, scratchEnv, schemaValidators } from "./helpers.js";

function store(now?: () => Date) {
  const env = scratchEnv();
  return new RecordStore(sessionsDir(env), { now });
}

const validators = schemaValidators();

/** The pid of a process that has exited, so no running process has it (barring immediate reuse). */
function deadPid(): Promise<number> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["-e", ""]);
    child.on("error", reject);
    child.on("close", () => resolve(child.pid!));
  });
}

describe("RecordStore", () => {
  it("creates a record on first write, at <harness>-<session>.json, matching the record schema", async () => {
    const s = store(() => new Date("2026-01-01T00:00:00.000Z"));
    const rec = await s.updateInside("claude", "abc-123", { pid: 42, status: "idle" });
    expect(rec).toMatchObject({ schema: 1, harness: "claude", session: "abc-123", self: null });
    expect(rec.inside).toEqual({ pid: 42, status: "idle", since: "2026-01-01T00:00:00.000Z" });
    const text = await fs.readFile(path.join(s.dir, "claude-abc-123.json"), "utf8");
    validators.record!(JSON.parse(text));
  });

  it("merges patches, and merges data key by key", async () => {
    const s = store();
    await s.updateInside("claude", "s1", { pid: 1, data: { a: 1 } });
    const rec = await s.updateInside("claude", "s1", { lastTurnStart: "2026-01-01T00:00:00.000Z", data: { b: 2 } });
    expect(rec.inside).toMatchObject({ pid: 1, lastTurnStart: "2026-01-01T00:00:00.000Z", data: { a: 1, b: 2 } });
  });

  it("sets since when status changes without one, keeps it when status is unchanged, and respects a given since", async () => {
    let t = 0;
    const s = store(() => new Date(Date.UTC(2026, 0, 1, 0, 0, t)));
    await s.updateInside("fake", "s1", { status: "idle" });
    t = 5;
    let rec = await s.updateInside("fake", "s1", { status: "idle", pid: 3 });
    expect(rec.inside?.since).toBe("2026-01-01T00:00:00.000Z");
    t = 10;
    rec = await s.updateInside("fake", "s1", { status: "busy" });
    expect(rec.inside?.since).toBe("2026-01-01T00:00:10.000Z");
    rec = await s.updateInside("fake", "s1", { status: "idle", since: "2025-12-31T00:00:00.000Z" });
    expect(rec.inside?.since).toBe("2025-12-31T00:00:00.000Z");
  });

  it("keeps the two parts separate: inside writes never touch self, and self writes never touch inside", async () => {
    const s = store();
    await s.updateInside("fake", "s1", { status: "busy" });
    await s.setSelf("fake", "s1", { status: "blocked", text: "CI", since: "2026-01-01T00:00:00.000Z" });
    const rec = await s.updateInside("fake", "s1", { status: "idle" });
    expect(rec.self).toEqual({ status: "blocked", text: "CI", since: "2026-01-01T00:00:00.000Z" });
    const rec2 = await s.setSelf("fake", "s1", { status: "done", text: null, since: "2026-01-01T00:00:01.000Z" });
    expect(rec2.inside?.status).toBe("idle");
  });

  it("loses no update when many writers change both parts at once (lock + atomic replace)", async () => {
    const s = store();
    await s.updateInside("fake", "s1", { data: {} });
    await Promise.all(
      Array.from({ length: 30 }, (_, i) =>
        i % 3 === 0
          ? s.setSelf("fake", "s1", { status: "working", text: String(i), since: new Date().toISOString() })
          : s.updateInside("fake", "s1", { data: { [`k${i}`]: i } }),
      ),
    );
    const rec = await s.read("fake", "s1");
    const keys = Object.keys(rec?.inside?.data ?? {});
    expect(keys).toHaveLength(20);
    expect(rec?.self?.status).toBe("working");
    const leftovers = (await fs.readdir(s.dir)).filter((f) => f !== "fake-s1.json");
    expect(leftovers).toEqual([]);
  });

  it("loses no update across separate processes", async () => {
    const env = scratchEnv();
    const dir = sessionsDir(env);
    const script = `
      import { RecordStore } from ${JSON.stringify(path.join(REPO, "dist", "records.js"))};
      const s = new RecordStore(${JSON.stringify(dir)});
      const n = Number(process.argv[1]);
      for (let i = 0; i < 10; i++) await s.updateInside("fake", "p1", { data: { ["p" + n + "_" + i]: i } });
    `;
    await Promise.all(
      [0, 1, 2, 3].map(
        (n) =>
          new Promise<void>((resolve, reject) => {
            const child = spawn(process.execPath, ["--input-type=module", "-e", script, String(n)], { stdio: "inherit" });
            child.on("close", (code) => (code === 0 ? resolve() : reject(new Error(`child ${n} exited ${code}`))));
          }),
      ),
    );
    const rec = await new RecordStore(dir).read("fake", "p1");
    expect(Object.keys(rec?.inside?.data ?? {})).toHaveLength(40);
  });

  it("breaks a lock left behind by a crashed writer", async () => {
    const s = new RecordStore(sessionsDir(scratchEnv()), { staleLockMs: 100, lockTimeoutMs: 2000 });
    await fs.mkdir(s.dir, { recursive: true });
    const lock = `${s.recordPath("fake", "s1")}.lock`;
    writeFileSync(lock, `${await deadPid()}:abcd`);
    const old = new Date(Date.now() - 60_000);
    utimesSync(lock, old, old);
    await s.updateInside("fake", "s1", { status: "idle" });
    expect((await s.read("fake", "s1"))?.inside?.status).toBe("idle");
  });

  it("does not break an old lock whose writer is still running, until the hard limit", async () => {
    const dir = sessionsDir(scratchEnv());
    await fs.mkdir(dir, { recursive: true });
    const file = path.join(dir, "fake-s1.json");
    const lock = `${file}.lock`;
    writeFileSync(lock, `${process.pid}:live`);
    const old = new Date(Date.now() - 60_000);
    utimesSync(lock, old, old);
    await expect(withLock(file, async () => "x", { staleMs: 100, hardStaleMs: 120_000, timeoutMs: 150 })).rejects.toThrow(/timed out/);
    expect(await withLock(file, async () => "x", { staleMs: 100, hardStaleMs: 1000, timeoutMs: 1000 })).toBe("x");
  });

  it("never deletes a lock it no longer holds", async () => {
    const dir = sessionsDir(scratchEnv());
    await fs.mkdir(dir, { recursive: true });
    const file = path.join(dir, "fake-s1.json");
    await withLock(file, async () => {
      // Another writer breaks this lock and takes its own while we are still working.
      writeFileSync(`${file}.lock`, "12345:someone-else");
    });
    expect(await fs.readFile(`${file}.lock`, "utf8")).toBe("12345:someone-else");
  });

  it("gives up with an error when a live lock is held too long", async () => {
    const s = new RecordStore(sessionsDir(scratchEnv()), { staleLockMs: 60_000, lockTimeoutMs: 100 });
    await fs.mkdir(s.dir, { recursive: true });
    writeFileSync(`${s.recordPath("fake", "s1")}.lock`, "1");
    await expect(s.updateInside("fake", "s1", { status: "idle" })).rejects.toThrow(/timed out/);
  });

  it("updateInsideIfExists changes an existing record but never creates one", async () => {
    const s = store();
    expect(await s.updateInsideIfExists("claude", "abc", { status: "busy" })).toBeNull();
    expect(await s.read("claude", "abc")).toBeNull();
    expect(await fs.readdir(s.dir)).toEqual([]);
    await s.updateInside("claude", "abc", { status: "idle", pid: 1 });
    const rec = await s.updateInsideIfExists("claude", "abc", { status: "busy" });
    expect(rec!.inside).toMatchObject({ status: "busy", pid: 1 });
    expect((await s.read("claude", "abc"))!.inside!.status).toBe("busy");
  });

  it("treats a key given as undefined as not part of the patch", async () => {
    const s = store();
    await s.updateInside("fake", "s1", { pid: 9, status: "busy" });
    const rec = await s.updateInside("fake", "s1", { pid: undefined, status: undefined, cwd: "/w" });
    expect(rec.inside).toMatchObject({ pid: 9, status: "busy", cwd: "/w" });
  });

  it("refuses to overwrite a record it cannot read, with a clear error", async () => {
    const s = store();
    await fs.mkdir(s.dir, { recursive: true });
    writeFileSync(s.recordPath("fake", "bad"), "{not json");
    await expect(s.setSelf("fake", "bad", { status: "done", text: null, since: new Date().toISOString() })).rejects.toBeInstanceOf(CorruptRecordError);
    await expect(s.updateInside("fake", "bad", { status: "idle" })).rejects.toThrow(/not valid JSON/);
    expect(await fs.readFile(s.recordPath("fake", "bad"), "utf8")).toBe("{not json");
  });

  it("refuses session ids and harness names that could escape the folder", async () => {
    const s = store();
    for (const bad of ["../x", "a/b", ".hidden", "", "a..b", "a b"]) {
      await expect(s.updateInside("fake", bad, { status: "idle" })).rejects.toBeInstanceOf(RecordError);
    }
    for (const bad of ["Fake", "fa-ke", "1fake", ""]) {
      expect(() => s.recordPath(bad, "s1")).toThrow(RecordError);
    }
  });

  it("lists records by harness, ignores lock and temp files, and reports unreadable files instead of throwing", async () => {
    const s = store();
    await s.updateInside("fake", "a", { status: "idle" });
    await s.updateInside("other", "b", { status: "busy" });
    writeFileSync(path.join(s.dir, "fake-x.json.lock"), "1");
    writeFileSync(path.join(s.dir, "fake-y.json.123.abcd.tmp"), "{");
    writeFileSync(path.join(s.dir, "fake-broken.json"), "{not json");
    writeFileSync(path.join(s.dir, "fake-wrong.json"), JSON.stringify({ schema: 1, harness: "fake", session: "other", inside: null, self: null }));
    const all = await s.list();
    expect(all.records.map((r) => `${r.harness}/${r.session}`)).toEqual(["fake/a", "other/b"]);
    expect(all.problems.map((p) => path.basename(p.file)).sort()).toEqual(["fake-broken.json", "fake-wrong.json"]);
    const fakeOnly = await s.list("fake");
    expect(fakeOnly.records.map((r) => r.session)).toEqual(["a"]);
  });

  it("lists nothing, without error, when the folder does not exist yet", async () => {
    expect(await store().list()).toEqual({ records: [], problems: [] });
  });

  it("removes a record, and reports whether there was one", async () => {
    const s = store();
    await s.updateInside("fake", "a", { status: "idle" });
    expect(await s.remove("fake", "a")).toBe(true);
    expect(await s.remove("fake", "a")).toBe(false);
    expect(await s.read("fake", "a")).toBeNull();
  });

  it("writes files only the user can read", async () => {
    const s = store();
    await s.updateInside("fake", "a", { status: "idle" });
    const st = await fs.stat(s.recordPath("fake", "a"));
    expect(st.mode & 0o077).toBe(0);
  });
});
