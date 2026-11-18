/**
 * Marketing text helpers: the risky-word scan, caption templates and the
 * claims gate for posts.
 */

export type ScanMatch = { phrase: string; index: number };

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * Case-insensitive whole-word or whole-phrase matches. Each phrase found is
 * returned once, with its first position, in the order found. Spaces inside a
 * phrase match any run of whitespace. Letters, digits and apostrophes count
 * as word characters, so "cure" does not match inside "secure".
 */
export function scanText(text: string | null | undefined, phrases: readonly string[]): ScanMatch[] {
  const t = text ?? "";
  if (!t.trim()) return [];
  const out: ScanMatch[] = [];
  const seen = new Set<string>();
  for (const raw of phrases) {
    const phrase = raw.trim();
    const key = phrase.toLowerCase();
    if (!phrase || seen.has(key)) continue;
    seen.add(key);
    const body = phrase.split(/\s+/).map(escapeRe).join("\\s+");
    const re = new RegExp(`(?<![\\p{L}\\p{N}'’])${body}(?![\\p{L}\\p{N}'’])`, "iu");
    const m = re.exec(t);
    if (m) out.push({ phrase, index: m.index });
  }
  return out.sort((a, b) => a.index - b.index);
}

export const TEMPLATE_PLACEHOLDERS = ["product_name", "tagline", "short_description", "hashtags", "link"] as const;
export type TemplateVar = (typeof TEMPLATE_PLACEHOLDERS)[number];

/**
 * Fills {product_name}, {tagline}, {short_description}, {hashtags} and {link}.
 * Unknown placeholders stay as typed and are listed in `unknown`; known ones
 * with no value become empty and are listed in `missing`.
 */
export function applyTemplate(body: string, vars: Partial<Record<TemplateVar, string | null | undefined>>) {
  const unknown = new Set<string>();
  const missing = new Set<string>();
  const text = body.replace(/\{([a-zA-Z_][a-zA-Z0-9_]*)\}/g, (whole, name: string) => {
    if (!(TEMPLATE_PLACEHOLDERS as readonly string[]).includes(name)) {
      unknown.add(name);
      return whole;
    }
    const v = (vars[name as TemplateVar] ?? "").trim();
    if (!v) missing.add(name);
    return v;
  });
  return { text, unknown: [...unknown], missing: [...missing] };
}

export type ClaimLite = { id: string; claim_text: string; status: string };

/** Selected claims that are not approved (these block a post from Ready, Scheduled or Posted). */
export function claimsReadyCheck<T extends ClaimLite>(selected: readonly T[]): T[] {
  return selected.filter((c) => c.status !== "approved");
}

export const READY_STATUSES = ["ready", "scheduled", "posted"] as const;
export const isReadyStatus = (s: string) => (READY_STATUSES as readonly string[]).includes(s);
