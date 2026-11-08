/* eslint-disable @typescript-eslint/no-explicit-any */
// Migration 2 (employee_access_policies.sql) against the real migration SQL in
// PGlite. Invented people, example.test addresses.
import { beforeEach, describe, expect, it } from "vitest";
import type { PGlite } from "@electric-sql/pglite";
import { readFileSync } from "node:fs";
import path from "node:path";
import { addEmployee, applyPolicies, asAnon, asOwner, asUser, createAccessDb, migration } from "./helpers/accessDb";
import { BUCKET_MATRIX, TABLE_MATRIX } from "@/lib/access/tableMatrix";
import { FEATURE_KEYS } from "@/lib/access/catalog";

let pg: PGlite;
beforeEach(async () => {
  ({ pg } = await createAccessDb());
});

const rows = async <T = any>(sql: string, params: unknown[] = []) => (await pg.query<T>(sql, params)).rows;
const count = async (sql: string, params: unknown[] = []) => (await rows<{ n: number }>(sql, params))[0].n;
const failsWith = async (fn: () => Promise<unknown>, re: RegExp) => {
  let msg = "";
  try {
    await fn();
  } catch (e) {
    msg = (e as Error).message;
  }
  expect(msg).toMatch(re);
};

/** A custom role holding exactly these features. */
async function roleWith(name: string, features: string[]) {
  const id = (await rows<{ id: string }>(`insert into roles (name) values ($1) returning id`, [name]))[0].id;
  for (const f of features) await pg.query(`insert into role_features (role_id, feature_key) values ($1, $2)`, [id, f]);
  return name;
}

describe("guard", () => {
  it("stops when there is no Admin account", async () => {
    await failsWith(() => applyPolicies(pg), /No active Admin account yet/);
  });

  it("stops when the only Admin is still invited or has no login", async () => {
    const admin = (await rows<{ id: string }>(`select id from roles where is_admin`))[0].id;
    const invited = (await rows<{ id: string }>(
      `insert into employee_accounts (email, first_name, last_name, status, invited_at) values ('invited1@example.test', 'In', 'Vited', 'invited', now()) returning id`,
    ))[0].id;
    await pg.query(`insert into employee_roles (employee_id, role_id) values ($1, $2)`, [invited, admin]);
    expect(await count(`select access_active_admin_count(null) n`)).toBe(0);
    await failsWith(() => applyPolicies(pg), /No active Admin account yet/);
  });

  it("runs once an active Admin exists, and can run again", async () => {
    await addEmployee(pg, { roles: ["Admin"] });
    await applyPolicies(pg);
    await applyPolicies(pg);
    expect(await count(`select count(*)::int n from pg_policies where schemaname = 'public' and tablename = 'log_types'`)).toBe(4);
  });
});

describe("after migration 2", () => {
  let admin: Awaited<ReturnType<typeof addEmployee>>;
  let warehouse: Awaited<ReturnType<typeof addEmployee>>;
  let production: Awaited<ReturnType<typeof addEmployee>>;
  let ordersOnly: Awaited<ReturnType<typeof addEmployee>>;
  let logType: string;
  let cycleId: string;

  beforeEach(async () => {
    // Like the hosted database before this build: an owner-only policy on
    // production data and an open policy on a table the matrix doesn't list.
    await pg.exec(`
      alter table production_cycles enable row level security;
      create policy "owner only" on production_cycles for all using (auth.uid() = user_id) with check (auth.uid() = user_id);
      create table unmapped_example (id serial primary key, note text);
      alter table unmapped_example enable row level security;
      create policy "open read" on unmapped_example for select using (auth.role() = 'authenticated');
      insert into unmapped_example (note) values ('hello');
      grant select on unmapped_example to authenticated, anon;
    `);
    admin = await addEmployee(pg, { roles: ["Admin"], first: "Ada", last: "Admin", email: "admin1@example.test" });
    warehouse = await addEmployee(pg, { roles: ["Warehouse Operations"], email: "wh1@example.test" });
    production = await addEmployee(pg, { roles: ["Production Operations"], email: "prod1@example.test" });
    ordersOnly = await addEmployee(pg, { roles: [await roleWith("Orders only", ["fulfillment.orders"])], email: "orders1@example.test" });
    logType = (await rows<{ id: string }>(`select id from log_types limit 1`))[0].id;
    cycleId = (await rows<{ id: string }>(`insert into production_cycles (user_id, status) values ($1, 'planned') returning id`, [admin.userId]))[0].id;
    await applyPolicies(pg);
    // Like Supabase: anon and authenticated have table grants; RLS decides.
    await pg.exec(`
      grant usage on schema storage to anon, authenticated;
      grant select, insert, update, delete on storage.objects to authenticated;
      grant select on all tables in schema public to anon;
    `);
  });

  it("non-admins cannot create or change log types or fields; Admins can", async () => {
    for (const who of [warehouse, production]) {
      await asUser(pg, who.userId);
      expect((await rows(`select id from log_types`)).length).toBeGreaterThan(0);
      await failsWith(() => pg.query(`insert into log_types (slug, name) values ('x-${who.accountId.slice(0, 6)}', 'X')`), /row-level security/);
      expect((await pg.query(`update log_types set name = name || '!' returning id`)).rows).toHaveLength(0);
      expect((await pg.query(`update log_fields set label = label || '!' returning id`)).rows).toHaveLength(0);
      expect((await pg.query(`delete from log_fields returning id`)).rows).toHaveLength(0);
    }
    await asUser(pg, admin.userId);
    expect((await pg.query(`update log_types set name = name returning id`)).rows.length).toBeGreaterThan(0);
    await asOwner(pg);
  });

  it("a compliance.logs user can add a log entry; someone without it cannot see or add one", async () => {
    await asUser(pg, warehouse.userId);
    const id = (await rows<{ id: string }>(
      `insert into log_entries (log_type_id, entry_number, performed_by_name, values) values ($1, 5001, 'x', '{}') returning id`,
      [logType],
    ))[0].id;
    expect(await count(`select count(*)::int n from log_entries where id = $1`, [id])).toBe(1);
    // Entries stay append-only for the browser.
    expect((await pg.query(`update log_entries set values = '{}' returning id`)).rows).toHaveLength(0);
    expect((await pg.query(`delete from log_entries returning id`)).rows).toHaveLength(0);

    await asUser(pg, ordersOnly.userId);
    expect(await count(`select count(*)::int n from log_entries`)).toBe(0);
    await failsWith(
      () => pg.query(`insert into log_entries (log_type_id, entry_number, performed_by_name, values) values ($1, 5002, 'x', '{}')`, [logType]),
      /row-level security/,
    );
    await asOwner(pg);
  });

  it("production data is shared with everyone who has the planner feature", async () => {
    await asUser(pg, production.userId);
    // The cycle was created by the Admin's login; before, only that login saw it.
    expect(await count(`select count(*)::int n from production_cycles where id = $1`, [cycleId])).toBe(1);
    expect((await pg.query(`update production_cycles set status = 'active' where id = $1 returning id`, [cycleId])).rows).toHaveLength(1);
    // Compliance logs read cycles (for batch links); orders alone does not.
    await asUser(pg, ordersOnly.userId);
    expect(await count(`select count(*)::int n from production_cycles`)).toBe(0);
    await asOwner(pg);
  });

  it("deactivated people and anon get nothing", async () => {
    await asOwner(pg);
    await pg.query(`update employee_accounts set status = 'deactivated' where id = $1`, [warehouse.accountId]);
    await asUser(pg, warehouse.userId);
    expect(await count(`select count(*)::int n from log_types`)).toBe(0);
    expect(await count(`select count(*)::int n from products`)).toBe(0);
    expect(await count(`select count(*)::int n from unmapped_example`)).toBe(0);
    await asAnon(pg);
    expect(await count(`select count(*)::int n from products`)).toBe(0);
    expect(await count(`select count(*)::int n from unmapped_example`)).toBe(0);
    await asOwner(pg);
  });

  it("a table without a mapping keeps its commands but needs an active employee", async () => {
    await asUser(pg, ordersOnly.userId);
    expect(await count(`select count(*)::int n from unmapped_example`)).toBe(1);
    await asOwner(pg);
    const pols = await rows<any>(`select policyname, cmd, qual from pg_policies where tablename = 'unmapped_example'`);
    expect(pols).toEqual([{ policyname: "open read", cmd: "SELECT", qual: "is_active_employee()" }]);
  });

  it("permission tables: Admins can read, nobody writes from the browser", async () => {
    await asUser(pg, warehouse.userId);
    expect(await count(`select count(*)::int n from employee_accounts`)).toBe(0);
    await asUser(pg, admin.userId);
    expect(await count(`select count(*)::int n from employee_accounts`)).toBe(4);
    expect((await pg.query(`update roles set description = 'x' returning id`)).rows).toHaveLength(0);
    await asOwner(pg);
  });

  it("storage: company-assets needs purchase orders", async () => {
    await asUser(pg, warehouse.userId);
    await pg.query(`insert into storage.objects (bucket_id, name) values ('company-assets', 'logo.png')`);
    await asUser(pg, ordersOnly.userId);
    await failsWith(() => pg.query(`insert into storage.objects (bucket_id, name) values ('company-assets', 'logo2.png')`), /row-level security/);
    expect(await count(`select count(*)::int n from storage.objects`)).toBe(0);
    await asOwner(pg);
    const names = (await rows<{ policyname: string }>(`select policyname from pg_policies where schemaname = 'storage' order by 1`)).map((r) => r.policyname);
    expect(names).toEqual(["access_company_assets_objects", "access_log_entry_docs_objects", "access_sops_objects"]);
  });
});

describe("matrix file and migration agree", () => {
  const sql = readFileSync(path.resolve(__dirname, "../../supabase-migrations/employee_access_policies.sql"), "utf8");
  const between = (tag: string) => JSON.parse(sql.split(`$${tag}$`)[1]);
  const norm = (m: Record<string, any>) =>
    Object.fromEntries(Object.entries(m).map(([t, p]) => [t, Object.fromEntries(Object.entries(p).filter(([, v]) => v !== undefined))]));

  it("table matrix is identical", () => {
    expect(between("table_matrix")).toEqual(norm(TABLE_MATRIX));
  });
  it("bucket matrix is identical", () => {
    expect(between("bucket_matrix")).toEqual(BUCKET_MATRIX);
  });
  it("every feature key in the matrix exists", () => {
    for (const p of Object.values(TABLE_MATRIX)) {
      for (const who of Object.values(p)) {
        if (Array.isArray(who)) for (const k of who) expect(FEATURE_KEYS).toContain(k);
      }
    }
  });
  it("Admin-only items stay Admin-only: log types and fields, notification settings, permission tables", () => {
    for (const t of ["log_types", "log_fields"]) {
      expect(TABLE_MATRIX[t].insert).toBe("admin");
      expect(TABLE_MATRIX[t].update).toBe("admin");
      expect(TABLE_MATRIX[t].delete).toBe("admin");
    }
    expect(TABLE_MATRIX.notification_config).toEqual({ read: "admin", insert: "admin", update: "admin", delete: "admin" });
    for (const t of ["employee_accounts", "roles", "role_features", "employee_roles", "access_audit_log"]) {
      expect(TABLE_MATRIX[t]).toEqual({ read: "admin" });
    }
  });
  it("contains no email address", () => {
    expect(migration("employee_access_policies.sql")).not.toMatch(/[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+\.[A-Za-z]{2,}/);
  });
});
