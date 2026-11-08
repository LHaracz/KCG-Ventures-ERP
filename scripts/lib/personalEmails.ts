/**
 * Finds email addresses at personal-provider domains on ADDED lines of a
 * staged diff (git diff --cached -U0). Used by check:private.
 *
 * Reports file and line number only. The matched address itself is never
 * returned, printed or logged.
 */

export const PERSONAL_DOMAINS = [
  "gmail.com",
  "googlemail.com",
  "yahoo.com",
  "outlook.com",
  "hotmail.com",
  "icloud.com",
  "proton.me",
  "protonmail.com",
] as const;

const domainAlternation = PERSONAL_DOMAINS.map((d) => d.replace(/\./g, "\\.")).join("|");
// local-part@domain, with the domain not followed by more domain characters.
const EMAIL_RE = new RegExp(`[A-Za-z0-9._%+-]+@(?:${domainAlternation})(?![A-Za-z0-9.-]*[A-Za-z0-9])`, "gi");

export type EmailHit = { file: string; line: number };

/** Parses `git diff --cached -U0` output and returns where personal addresses were added. */
export function findPersonalEmailsInDiff(diff: string, allowlist: Iterable<string> = []): EmailHit[] {
  const allowed = new Set(Array.from(allowlist, (a) => a.trim().toLowerCase()).filter(Boolean));
  const hits: EmailHit[] = [];
  let file: string | null = null;
  let newLine = 0;
  for (const raw of diff.split("\n")) {
    const line = raw.replace(/\r$/, "");
    if (line.startsWith("+++ ")) {
      const target = line.slice(4).trim();
      file = target === "/dev/null" ? null : target.replace(/^b\//, "");
      continue;
    }
    if (line.startsWith("--- ") || line.startsWith("diff --git")) continue;
    const hunk = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line);
    if (hunk) {
      newLine = Number(hunk[1]);
      continue;
    }
    if (!file) continue;
    if (line.startsWith("+")) {
      const inPrivate = file.startsWith(".private/") || file.includes("/.private/");
      if (!inPrivate) {
        const found = line.slice(1).match(EMAIL_RE) ?? [];
        if (found.some((addr) => !allowed.has(addr.toLowerCase()))) hits.push({ file, line: newLine });
      }
      newLine += 1;
    } else if (line.startsWith(" ")) {
      newLine += 1;
    }
    // "-" lines and "\ No newline" markers don't advance the new-file line.
  }
  return hits;
}

/** Reads scripts/email-allowlist.txt content: one address per line, # comments. */
export function parseEmailAllowlist(text: string): string[] {
  return text
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith("#"));
}
