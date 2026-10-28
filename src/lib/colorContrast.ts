/**
 * Small, dependency-free color-contrast helpers shared by the Purchase
 * Orders company profile settings page (the "this accent color is hard to
 * read" warning) and the PO PDF document (choosing a readable text color
 * for the accent-colored header band, and mixing an 8% accent tint for
 * light backgrounds). WCAG relative-luminance math, nothing fancier.
 */

export type RgbColor = { r: number; g: number; b: number };

/** Parses a "#rrggbb" string. Returns null for anything else (callers should already validate via the DB's own CHECK constraint, but this stays defensive). */
export function hexToRgb(hex: string): RgbColor | null {
  const match = /^#?([0-9a-f]{6})$/i.exec(hex.trim());
  if (!match) return null;
  const value = match[1];
  return {
    r: parseInt(value.slice(0, 2), 16),
    g: parseInt(value.slice(2, 4), 16),
    b: parseInt(value.slice(4, 6), 16),
  };
}

export function rgbToHex({ r, g, b }: RgbColor): string {
  const toHex = (n: number) => Math.round(Math.min(255, Math.max(0, n))).toString(16).padStart(2, "0");
  return `#${toHex(r)}${toHex(g)}${toHex(b)}`;
}

// WCAG relative luminance (sRGB -> linear -> weighted sum).
function relativeLuminance({ r, g, b }: RgbColor): number {
  const linear = (channel: number) => {
    const c = channel / 255;
    return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
  };
  const [lr, lg, lb] = [linear(r), linear(g), linear(b)];
  return 0.2126 * lr + 0.7152 * lg + 0.0722 * lb;
}

/** WCAG contrast ratio between two colors, 1 (identical) to 21 (black vs white). */
export function contrastRatio(hexA: string, hexB: string): number | null {
  const a = hexToRgb(hexA);
  const b = hexToRgb(hexB);
  if (!a || !b) return null;
  const la = relativeLuminance(a);
  const lb = relativeLuminance(b);
  const lighter = Math.max(la, lb);
  const darker = Math.min(la, lb);
  return (lighter + 0.05) / (darker + 0.05);
}

/**
 * Picks whichever of near-black (#111111) or white (#ffffff) reads better
 * on top of the given background color — used for text sitting on the PDF's
 * accent-colored band, since some business accent colors (a pale green, say)
 * read better with dark text than white.
 */
export function pickReadableTextColor(backgroundHex: string): "#111111" | "#ffffff" {
  const whiteRatio = contrastRatio(backgroundHex, "#ffffff") ?? 1;
  const blackRatio = contrastRatio(backgroundHex, "#111111") ?? 1;
  return whiteRatio >= blackRatio ? "#ffffff" : "#111111";
}

/**
 * Mixes `fraction` of the accent color into white — used for the PDF's
 * light tint band (8% accent mixed into white) and reusable for any other
 * "light version of this brand color" need.
 */
export function mixWithWhite(hex: string, fraction: number): string {
  const rgb = hexToRgb(hex);
  if (!rgb) return "#ffffff";
  const clamped = Math.min(1, Math.max(0, fraction));
  return rgbToHex({
    r: rgb.r * clamped + 255 * (1 - clamped),
    g: rgb.g * clamped + 255 * (1 - clamped),
    b: rgb.b * clamped + 255 * (1 - clamped),
  });
}

/**
 * Settings-page warning: true when this accent color is so close to white
 * that it would barely be visible as a header band / tint accent. Not a
 * strict WCAG pass/fail (an accent color isn't body text) — just a
 * practical "you probably can't see this" threshold.
 */
export function isAccentColorTooLight(hex: string): boolean {
  const ratio = contrastRatio(hex, "#ffffff");
  if (ratio == null) return false;
  return ratio < 1.5;
}
