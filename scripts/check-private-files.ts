/**
 * check:private
 * Fails (exit 1) if any tracked or staged file is confidential:
 *   - anything under .private/, test-results/ or playwright-report/
 *   - any .pdf not listed in scripts/private-allowlist.txt
 *   - anything that looks like a backup, dump or export of SOP, formula or BOM data
 * Prints file paths only, never file contents.
 */
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

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

if (hits.length > 0) {
  console.error("check:private FAILED. These tracked or staged files must not be committed:");
  for (const h of hits) console.error(`  ${h.file}  (${h.reason})`);
  console.error("Unstage them (git rm --cached <file>) or, for an intentional non-confidential file, add it to scripts/private-allowlist.txt.");
  process.exit(1);
}
console.log(`check:private OK (${files.length} tracked/staged files checked).`);
