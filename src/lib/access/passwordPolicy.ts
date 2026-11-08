/**
 * Password policy: at least 11 characters, with an uppercase letter, a
 * lowercase letter, a number and a special character. Checked live in the
 * forms and again on the server before a password is saved (and in Supabase
 * Auth's own password requirements setting).
 */
export const PASSWORD_RULES = [
  { id: "length", label: "At least 11 characters", test: (p: string) => p.length >= 11 },
  { id: "upper", label: "An uppercase letter", test: (p: string) => /[A-Z]/.test(p) },
  { id: "lower", label: "A lowercase letter", test: (p: string) => /[a-z]/.test(p) },
  { id: "number", label: "A number", test: (p: string) => /[0-9]/.test(p) },
  { id: "special", label: "A special character", test: (p: string) => /[^A-Za-z0-9]/.test(p) },
] as const;

export type PasswordCheck = { id: string; label: string; ok: boolean };

export function checkPassword(password: string): PasswordCheck[] {
  return PASSWORD_RULES.map((r) => ({ id: r.id, label: r.label, ok: r.test(password) }));
}

/** Null when the password meets the policy; otherwise a sentence listing what's missing. */
export function passwordProblem(password: unknown): string | null {
  if (typeof password !== "string") return "Enter a password.";
  if (password.length > 72) return "Use at most 72 characters.";
  const missing = checkPassword(password).filter((c) => !c.ok).map((c) => c.label.toLowerCase());
  return missing.length ? `The password needs: ${missing.join(", ")}.` : null;
}
