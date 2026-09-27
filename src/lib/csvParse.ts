/**
 * Minimal RFC4180-ish CSV text parser: handles quoted fields (including
 * embedded commas, escaped "" quotes, and embedded newlines), CRLF/LF line
 * endings, and ragged row lengths. Good enough for machine-generated
 * exports like Shopify's order CSV — not a general-purpose parser for
 * hand-edited files with unusual delimiters.
 */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let inQuotes = false;
  let i = 0;
  const len = text.length;

  const pushField = () => {
    row.push(field);
    field = "";
  };
  const pushRow = () => {
    pushField();
    rows.push(row);
    row = [];
  };

  while (i < len) {
    const char = text[i];

    if (inQuotes) {
      if (char === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i += 2;
          continue;
        }
        inQuotes = false;
        i += 1;
        continue;
      }
      field += char;
      i += 1;
      continue;
    }

    if (char === '"') {
      inQuotes = true;
      i += 1;
      continue;
    }
    if (char === ",") {
      pushField();
      i += 1;
      continue;
    }
    if (char === "\r") {
      i += 1;
      continue; // swallow — the following \n (or end of input) closes the row
    }
    if (char === "\n") {
      pushRow();
      i += 1;
      continue;
    }
    field += char;
    i += 1;
  }

  // Final field/row when the file doesn't end with a trailing newline.
  if (field.length > 0 || row.length > 0) {
    pushRow();
  }

  // Drop fully-blank trailing rows (e.g. produced by a trailing newline).
  return rows.filter((r) => !(r.length === 1 && r[0] === ""));
}
