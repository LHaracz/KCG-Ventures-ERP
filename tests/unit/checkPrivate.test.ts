// check:private email guardrail. Personal addresses are assembled at runtime
// from separate pieces so no literal address appears in this file.
import { describe, expect, it } from "vitest";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { findPersonalEmailsInDiff, parseEmailAllowlist } from "../../scripts/lib/personalEmails";

const at = String.fromCharCode(64);
const personal = (user: string, provider: string, tld: string) => [user, at, provider, ".", tld].join("");
const someone = personal("jane.q" + "doe", "gm" + "ail", "com");
const another = personal("pat", "proton", "me");
const exampleAddr = ["admin1", at, "example", ".", "test"].join("");

const diffFor = (file: string, startLine: number, lines: string[]) =>
  [
    `diff --git a/${file} b/${file}`,
    `--- a/${file}`,
    `+++ b/${file}`,
    `@@ -0,0 +${startLine},${lines.length} @@`,
    ...lines.map((l) => `+${l}`),
  ].join("\n");

describe("findPersonalEmailsInDiff", () => {
  it("reports file and line of an added personal address, never the address", () => {
    const hits = findPersonalEmailsInDiff(diffFor("src/a.ts", 10, ["const x = 1;", `const who = "${someone}";`]));
    expect(hits).toEqual([{ file: "src/a.ts", line: 11 }]);
    expect(JSON.stringify(hits)).not.toContain(at);
  });

  it("covers every listed provider, case-insensitively", () => {
    for (const [p, t] of [["gmail", "com"], ["googlemail", "com"], ["yahoo", "com"], ["outlook", "com"], ["hotmail", "com"], ["icloud", "com"], ["proton", "me"], ["protonmail", "com"]]) {
      const addr = personal("x", p, t).toUpperCase();
      expect(findPersonalEmailsInDiff(diffFor("f.md", 1, [addr]))).toHaveLength(1);
    }
  });

  it("passes example.test addresses, removed lines, context lines and .private files", () => {
    const diff = [
      diffFor("tests/x.test.ts", 1, [`const a = "${exampleAddr}";`]),
      "diff --git a/src/b.ts b/src/b.ts",
      "--- a/src/b.ts",
      "+++ b/src/b.ts",
      "@@ -3,1 +3,0 @@",
      `-old ${someone}`,
      diffFor(".private/notes.txt", 1, [someone]),
    ].join("\n");
    expect(findPersonalEmailsInDiff(diff)).toEqual([]);
  });

  it("does not flag look-alike domains", () => {
    const lookalike = ["a", at, "gmail", ".", "com", ".evil", ".example"].join("");
    const sub = ["a", at, "mail.", "gmail", "x.com"].join("");
    expect(findPersonalEmailsInDiff(diffFor("f.ts", 1, [lookalike, sub]))).toEqual([]);
  });

  it("honors the allowlist", () => {
    const allow = parseEmailAllowlist(`# comment\n${another.toUpperCase()}\n\n`);
    expect(findPersonalEmailsInDiff(diffFor("f.ts", 1, [another]), allow)).toEqual([]);
    expect(findPersonalEmailsInDiff(diffFor("f.ts", 1, [someone]), allow)).toHaveLength(1);
  });

  it("tracks line numbers across hunks", () => {
    const diff = [
      "diff --git a/f.ts b/f.ts",
      "--- a/f.ts",
      "+++ b/f.ts",
      "@@ -1,0 +2,1 @@",
      "+fine",
      "@@ -10,2 +11,2 @@",
      "-gone",
      `+${someone}`,
    ].join("\n");
    expect(findPersonalEmailsInDiff(diff)).toEqual([{ file: "f.ts", line: 11 }]);
  });
});

describe("check:private in a throwaway git repo", () => {
  const repoRoot = path.resolve(__dirname, "../..");
  const tsx = path.join(repoRoot, "node_modules", ".bin", "tsx");

  function scratchRepo() {
    const dir = mkdtempSync(path.join(os.tmpdir(), "check-private-"));
    const git = (...args: string[]) => execFileSync("git", args, { cwd: dir, stdio: "pipe" });
    git("init", "-q");
    git("config", "user.email", ["ci", at, "example", ".", "test"].join(""));
    git("config", "user.name", "CI");
    mkdirSync(path.join(dir, "scripts", "lib"), { recursive: true });
    for (const f of ["scripts/check-private-files.ts", "scripts/lib/personalEmails.ts"]) {
      execFileSync("cp", [path.join(repoRoot, f), path.join(dir, f)]);
    }
    writeFileSync(path.join(dir, "scripts", "email-allowlist.txt"), "");
    return { dir, git };
  }
  const run = (dir: string) => spawnSync(tsx, [path.join(dir, "scripts", "check-private-files.ts")], { cwd: dir, encoding: "utf8" });

  it("fails on a staged personal address and prints only file:line", () => {
    const { dir, git } = scratchRepo();
    writeFileSync(path.join(dir, "notes.md"), `line one\nowner: ${someone}\n`);
    git("add", "-A");
    const r = run(dir);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("notes.md:2");
    expect(r.stderr + r.stdout).not.toContain(someone);
    expect(r.stderr + r.stdout).not.toContain(someone.split(at)[0]);
  }, 30_000);

  it("passes for example.test addresses", () => {
    const { dir, git } = scratchRepo();
    writeFileSync(path.join(dir, "notes.md"), `owner: ${exampleAddr}\n`);
    git("add", "-A");
    const r = run(dir);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("check:private OK");
  }, 30_000);

  it("passes when the address is allowlisted", () => {
    const { dir, git } = scratchRepo();
    writeFileSync(path.join(dir, "scripts", "email-allowlist.txt"), `${another}\n`);
    writeFileSync(path.join(dir, "notes.md"), `contact ${another}\n`);
    git("add", "notes.md");
    expect(run(dir).status).toBe(0);
  }, 30_000);
});
