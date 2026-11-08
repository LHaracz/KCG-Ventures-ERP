/**
 * check:private
 * Fails (exit 1) if any tracked or staged file is confidential:
 *   - anything under .private/, test-results/ or playwright-report/
 *   - any .pdf not listed in scripts/private-allowlist.txt
 *   - anything that looks like a backup, dump or export of SOP, formula or BOM data
 *   - any staged ADDED line (outside .private/) containing an email address at
 *     a personal-provider domain (gmail.com, yahoo.com, ...) unless the address
 *     is listed in scripts/email-allowlist.txt
 * Prints file paths (and line numbers) only, never file contents or addresses.
 */
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { findPersonalEmailsInDiff, parseEmailAllowlist } from "./lib/personalEmails";

const root = execFileSync("git", ["rev-parse", "--show-toplevel"], { encoding: "utf8" }).trim();

function gitList(args: string[]): string[] {
  const out = execFileSync("git", args, { cwd: root, encoding: "utf8" });
  return out.split("\0").map((s) => s.trim()).filter(Boolean);
}

const tracked = gitList(["ls-files", "-z"]);
const staged = gitList(["diff", "--cached", "--name-only", "--diff-filter=ACMR", "-z"]);
const files = Array.from(new Set([...tracked, ...staged])).map((f) => f.replace(/\\/g, "/"));

const allowFile = path.join(root, "scripts", "private-allowlist.txt");
const allow = new Set(
  existsSync(allowFile)
    ? readFileSync(allowFile, "utf8")
        .split(/\r?\n/)
        .map((l) => l.trim().replace(/\\/g, "/"))
        .filter((l) => l && !l.startsWith("#"))
    : []
);

const DATA_EXT = /\.(json|jsonl|csv|tsv|xlsx|xls|sql|txt|html|zip|gz|tar)$/i;
const BACKUP_WORD = /(^|[\/._-])(backup|backups|dump|export|exports|snapshot-data)([\/._-]|$)/i;
const SENSITIVE_WORD = /(sop|formula|formulation|bom)/i;
const CODE_DIRS = /^(src|supabase-migrations|scripts\/sql)\//;

type Hit = { file: string; reason: string };
const hits: Hit[] = [];

for (const f of files) {
  if (allow.has(f)) continue;
  const lower = f.toLowerCase();
  if (lower.startsWith(".private/") || lower.includes("/.private/")) {
    hits.push({ file: f, reason: "under .private/" });
  } else if (/^(test-results|playwright-report)\//.test(lower)) {
    hits.push({ file: f, reason: "test output folder" });
  } else if (lower.endsWith(".pdf")) {
    hits.push({ file: f, reason: "PDF not in scripts/private-allowlist.txt" });
  } else if (DATA_EXT.test(lower) && BACKUP_WORD.test(lower)) {
    hits.push({ file: f, reason: "looks like a backup/dump/export" });
  } else if (
    DATA_EXT.test(lower) &&
    !CODE_DIRS.test(lower) &&
    !/^(package(-lock)?\.json|tsconfig\.json|vercel\.json|scripts\/private-allowlist\.txt)$/.test(lower) &&
    SENSITIVE_WORD.test(path.basename(lower))
  ) {
    hits.push({ file: f, reason: "SOP/formula/BOM data file outside code folders" });
  }
}

// Personal email addresses on staged added lines (file and line only).
const emailAllowFile = path.join(root, "scripts", "email-allowlist.txt");
const emailAllow = existsSync(emailAllowFile) ? parseEmailAllowlist(readFileSync(emailAllowFile, "utf8")) : [];
const stagedDiff = execFileSync("git", ["diff", "--cached", "-U0", "--no-color", "--no-ext-diff", "--diff-filter=ACMR"], {
  cwd: root,
  encoding: "utf8",
  maxBuffer: 256 * 1024 * 1024,
});
for (const e of findPersonalEmailsInDiff(stagedDiff, emailAllow)) {
  hits.push({ file: `${e.file}:${e.line}`, reason: "personal email address on an added line" });
}

if (hits.length > 0) {
  console.error("check:private FAILED. These tracked or staged files must not be committed:");
  for (const h of hits) console.error(`  ${h.file}  (${h.reason})`);
  console.error("Unstage them (git rm --cached <file>) or, for an intentional non-confidential file, add it to scripts/private-allowlist.txt.");
  console.error("For a personal email address: remove it from the line, or (only if it must be committed) add it to scripts/email-allowlist.txt.");
  process.exit(1);
}
console.log(`check:private OK (${files.length} tracked/staged files checked).`);
