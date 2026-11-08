/**
 * Default-deny registry check (npm run check:access). Fails when:
 *  - a page (src/app/** /page.tsx) has no entry in PAGE_RULES, or doesn't call
 *    guardPage() with its own route as the first thing it does;
 *  - an API route (src/app/api/** /route.ts) has no entry in API_RULES, or an
 *    exported handler doesn't start with guardApi();
 *  - a server action ("use server") exists (none are registered).
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";

export type RegistryProblem = { file: string; problem: string };

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = path.join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else out.push(p);
  }
  return out;
}

const toRoute = (appDir: string, file: string) => {
  const rel = path.relative(appDir, path.dirname(file)).split(path.sep).join("/");
  // Route groups "(name)" don't appear in URLs.
  const parts = rel.split("/").filter((s) => s && !/^\(.+\)$/.test(s));
  return "/" + parts.join("/");
};

export function checkAccessRegistry(
  srcDir: string,
  pageRules: Record<string, unknown>,
  apiRules: Record<string, unknown>,
): RegistryProblem[] {
  const appDir = path.join(srcDir, "app");
  const problems: RegistryProblem[] = [];
  const files = walk(appDir);
  const rel = (f: string) => path.relative(path.dirname(srcDir), f).split(path.sep).join("/");

  for (const f of files.filter((x) => /[\\/]page\.(tsx|ts|jsx|js)$/.test(x))) {
    const route = toRoute(appDir, f);
    if (!(route in pageRules)) problems.push({ file: rel(f), problem: `page ${route} is not registered in PAGE_RULES (src/lib/access/catalog.ts)` });
    const src = readFileSync(f, "utf8");
    const body = src.match(/export default (?:async )?function\s*\w*\s*\([^)]*\)\s*\{([\s\S]*)$/);
    const firstCall = body?.[1].trim() ?? "";
    const expected = `guardPage("${route}")`;
    if (!firstCall.startsWith(`if ((await ${expected})`) && !firstCall.startsWith(`await ${expected}`)) {
      problems.push({ file: rel(f), problem: `page must start with ${expected}` });
    }
    if (/^\s*["']use client["']/.test(src)) problems.push({ file: rel(f), problem: "page.tsx must be a server component (move the client code to client-page.tsx)" });
  }

  for (const f of files.filter((x) => /[\\/]route\.(ts|js)$/.test(x))) {
    const route = toRoute(appDir, f);
    if (!(route in apiRules)) problems.push({ file: rel(f), problem: `API route ${route} is not registered in API_RULES (src/lib/access/catalog.ts)` });
    const src = readFileSync(f, "utf8");
    const handlers = Array.from(src.matchAll(/export\s+(?:async\s+)?function\s+(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)\s*\(/g));
    if (/export\s+const\s+(GET|POST|PUT|PATCH|DELETE)\b/.test(src)) problems.push({ file: rel(f), problem: "handlers must be `export async function` so the guard can be checked" });
    for (const h of handlers) {
      const after = src.slice((h.index ?? 0) + h[0].length);
      const brace = after.indexOf("{", after.indexOf(")"));
      const firstLines = after.slice(brace + 1, brace + 200).trim();
      if (!/^const denied = await guardApi\([A-Za-z_]\w*\);\s*if \(denied\) return denied;/.test(firstLines)) {
        problems.push({ file: rel(f), problem: `${h[1]} handler must start with: const denied = await guardApi(request); if (denied) return denied;` });
      }
    }
  }

  for (const f of walk(srcDir).filter((x) => /\.(tsx?|jsx?)$/.test(x))) {
    const src = readFileSync(f, "utf8");
    if (/^\s*["']use server["']/m.test(src)) problems.push({ file: rel(f), problem: "server actions are not registered; use an API route with guardApi" });
  }
  return problems;
}
