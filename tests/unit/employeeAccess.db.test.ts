/* eslint-disable @typescript-eslint/no-explicit-any */
// Employee accounts, roles and the permission engine (migration 1), against
// the real migration SQL in PGlite. Invented people, example.test addresses.
import { beforeEach, describe, expect, it } from "vitest";
import type { PGlite } from "@electric-sql/pglite";
import { addAuthUser, addEmployee, asAnon, asOwner, asService, asUser, createAccessDb, migration, roleId } from "./helpers/accessDb";

let pg: PGlite;
beforeEach(async () => {
  ({ pg } = await createAccessDb());
});

const one = async <T = any>(sql: string, params: unknown[] = []) => (await pg.query<T>(sql, params)).rows[0];
const featuresFor = async (userId: string, keys: string[]) => {
  await asUser(pg, userId);
  const out: Record<string, boolean> = {};
  for (const k of keys) out[k] = (await one<{ v: boolean }>(`select has_feature($1) as v`, [k])).v;
  await asOwner(pg);
  return out;
};

describe("seeded roles", () => {
  it("creates Admin, Warehouse Operations and Production Operations with exactly the listed features", async () => {
    const roles = (await pg.query<any>(`select name, is_admin, is_system from roles order by name`)).rows;
    expect(roles).toEqual([
      { name: "Admin", is_admin: true, is_system: true },
      { name: "Production Operations", is_admin: false, is_system: false },
      { name: "Warehouse Operations", is_admin: false, is_system: false },
    ]);
    const feats = async (name: string) =>
      (await pg.query<{ k: string }>(`select feature_key k from role_features rf join roles r on r.id = rf.role_id where r.name = $1 order by 1`, [name])).rows.map((r) => r.k);
    expect(await feats("Warehouse Operations")).toEqual([
      "compliance.coas", "compliance.logs", "compliance.sops", "fulfillment.orders", "fulfillment.pick_list",
      "inventory.finished_products", "inventory.purchase_orders", "inventory.raw_materials",
    ]);
    expect(await feats("Production Operations")).toEqual([
      "compliance.coas", "compliance.logs", "compliance.sops", "inventory.finished_products", "inventory.purchase_orders",
      "inventory.raw_materials", "production.calibration", "production.formulation", "production.optimization",
      "production.planner", "production.products_bom",
    ]);
    expect(await feats("Admin")).toEqual([]);
    expect((await one<{ n: number }>(`select count(*)::int n from employee_accounts`)).n).toBe(0);
  });

  it("running migration 1 again changes nothing, and an edited role is left alone", async () => {
    await pg.query(`delete from role_features where feature_key = 'compliance.coas' and role_id = $1`, [await roleId(pg, "Warehouse Operations")]);
    await pg.exec(migration("employee_accounts_roles.sql"));
    expect((await one<{ n: number }>(`select count(*)::int n from roles`)).n).toBe(3);
    expect((await one<{ n: number }>(`select count(*)::int n from role_features rf join roles r on r.id = rf.role_id where r.name = 'Warehouse Operations'`)).n).toBe(7);
  });
});

describe("has_feature, is_admin, is_active_employee", () => {
  it("unions features across two roles", async () => {
    const both = await addEmployee(pg, { roles: ["Warehouse Operations", "Production Operations"] });
    expect(await featuresFor(both.userId, ["fulfillment.pick_list", "production.planner", "fulfillment.sales_data", "minileaf.guide"])).toEqual({
      "fulfillment.pick_list": true,
      "production.planner": true,
      "fulfillment.sales_data": false,
      "minileaf.guide": false,
    });
    const wh = await addEmployee(pg, { roles: ["Warehouse Operations"] });
    expect(await featuresFor(wh.userId, ["production.planner", "compliance.coas"])).toEqual({ "production.planner": false, "compliance.coas": true });
    await asUser(pg, both.userId);
    expect((await one<{ v: boolean }>(`select has_any_feature(array['minileaf.guide', 'production.planner']) v`)).v).toBe(true);
    expect((await one<{ v: boolean }>(`select has_any_feature(array['minileaf.guide', 'fulfillment.stats']) v`)).v).toBe(false);
    expect((await one<{ v: boolean }>(`select is_admin() v`)).v).toBe(false);
    expect((await one<{ v: boolean }>(`select is_active_employee() v`)).v).toBe(true);
  });

  it("an Admin has every feature, including ones no role lists", async () => {
    const admin = await addEmployee(pg, { roles: ["Admin"] });
    expect(await featuresFor(admin.userId, ["minileaf.guide", "fulfillment.setup", "anything.new"])).toEqual({
      "minileaf.guide": true,
      "fulfillment.setup": true,
      "anything.new": true,
    });
  });

  it("invited, deactivated and deleted accounts, and logins without an account, get nothing", async () => {
    await addEmployee(pg, { roles: ["Admin"] }); // someone must stay admin
    const invited = await addEmployee(pg, { roles: ["Admin"], status: "invited" });
    const off = await addEmployee(pg, { roles: ["Warehouse Operations"], status: "deactivated" });
    const del = await addEmployee(pg, { roles: ["Warehouse Operations"] });
    await pg.query(`delete from employee_roles where employee_id = $1`, [del.accountId]);
    await pg.query(`update employee_accounts set status = 'deleted' where id = $1`, [del.accountId]);
    const stranger = await addAuthUser(pg);
    for (const u of [invited.userId, off.userId, del.userId, stranger]) {
      await asUser(pg, u);
      expect(await one(`select is_active_employee() a, is_admin() b, has_feature('compliance.logs') c, current_account_id() d`)).toEqual({ a: false, b: false, c: false, d: null });
    }
    await asAnon(pg);
    await expect(pg.query(`select has_feature('compliance.logs')`)).rejects.toThrow(/permission denied/);
  });

  it("deactivation takes effect on the very next call", async () => {
    const admin = await addEmployee(pg, { roles: ["Admin"] });
    const wh = await addEmployee(pg, { roles: ["Warehouse Operations"] });
    await asUser(pg, wh.userId);
    expect((await one<{ v: boolean }>(`select has_feature('fulfillment.orders') v`)).v).toBe(true);
    await asService(pg);
    await pg.query(`select admin_set_employee_status($1, $2, false)`, [admin.accountId, wh.accountId]);
    await asUser(pg, wh.userId);
    expect((await one<{ v: boolean }>(`select has_feature('fulfillment.orders') v`)).v).toBe(false);
  });

  it("access_for_user returns the account, admin flag, roles and feature union (service role only)", async () => {
    const both = await addEmployee(pg, { roles: ["Warehouse Operations", "Production Operations"], first: "Jane", last: "Doe" });
    await asService(pg);
    const a = (await one<{ a: any }>(`select access_for_user($1) a`, [both.userId])).a;
    expect(a).toMatchObject({ account_id: both.accountId, status: "active", first_name: "Jane", last_name: "Doe", is_admin: false });
    expect(a.roles).toEqual(["Production Operations", "Warehouse Operations"]);
    expect(a.features).toHaveLength(13);
    await asOwner(pg);
    const stranger = await addAuthUser(pg);
    await asService(pg);
    expect((await one<{ a: any }>(`select access_for_user($1) a`, [stranger])).a).toBeNull();
    await asUser(pg, both.userId);
    await expect(pg.query(`select access_for_user($1)`, [both.userId])).rejects.toThrow(/permission denied/);
  });
});

describe("last active admin", () => {
  it("cannot lose the Admin role, be deactivated or be deleted; a second admin unlocks it", async () => {
    const a1 = await addEmployee(pg, { roles: ["Admin"] });
    const other = await addEmployee(pg, { roles: ["Warehouse Operations"] });
    const admin = await roleId(pg, "Admin");
    await expect(pg.query(`delete from employee_roles where employee_id = $1 and role_id = $2`, [a1.accountId, admin])).rejects.toThrow(/last active admin/);
    await expect(pg.query(`update employee_accounts set status = 'deactivated' where id = $1`, [a1.accountId])).rejects.toThrow(/last active admin/);
    await expect(pg.query(`update employee_accounts set status = 'deleted' where id = $1`, [a1.accountId])).rejects.toThrow(/last active admin/);
    await expect(pg.query(`update employee_accounts set user_id = null where id = $1`, [a1.accountId])).rejects.toThrow(/last active admin/);
    await expect(pg.query(`delete from employee_accounts where id = $1`, [a1.accountId])).rejects.toThrow(/last active admin/);
    await expect(pg.query(`select admin_delete_employee($1, $2)`, [other.accountId, a1.accountId])).rejects.toThrow(/last active admin/);
    await expect(pg.query(`select admin_set_employee_roles($1, $1, array[$2]::uuid[])`, [a1.accountId, await roleId(pg, "Warehouse Operations")])).rejects.toThrow(/last active admin/);
    // An invited or deactivated admin doesn't count as a second admin.
    const invited = await addEmployee(pg, { roles: ["Admin"], status: "invited" });
    await expect(pg.query(`delete from employee_roles where employee_id = $1 and role_id = $2`, [a1.accountId, admin])).rejects.toThrow(/last active admin/);
    await pg.query(`update employee_accounts set status = 'active' where id = $1`, [invited.accountId]);
    await pg.query(`delete from employee_roles where employee_id = $1 and role_id = $2`, [a1.accountId, admin]);
    expect((await one<{ n: number }>(`select access_active_admin_count() n`)).n).toBe(1);
  });
});

describe("audit log and roles", () => {
  it("the audit log is append-only", async () => {
    await pg.query(`insert into access_audit_log (actor_name, action, target) values ('System', 'invited', 'Test')`);
    await expect(pg.query(`update access_audit_log set target = 'x'`)).rejects.toThrow(/append-only/);
    await expect(pg.query(`delete from access_audit_log`)).rejects.toThrow(/append-only/);
    await expect(pg.query(`truncate access_audit_log`)).rejects.toThrow(/append-only/);
  });

  it("the Admin role is locked; a role in use can't be deleted; names are unique ignoring case", async () => {
    const a1 = await addEmployee(pg, { roles: ["Admin"] });
    await addEmployee(pg, { roles: ["Warehouse Operations"] });
    await asService(pg);
    const adminRole = await roleId(pg, "Admin");
    await expect(pg.query(`select admin_save_role($1, $2, 'Boss', null, '{}')`, [a1.accountId, adminRole])).rejects.toThrow(/locked/);
    await expect(pg.query(`select admin_delete_role($1, $2)`, [a1.accountId, adminRole])).rejects.toThrow(/cannot be deleted/);
    await expect(pg.query(`select admin_delete_role($1, $2)`, [a1.accountId, await roleId(pg, "Warehouse Operations")])).rejects.toThrow(/still have this role/);
    await expect(pg.query(`select admin_save_role($1, null, 'warehouse OPERATIONS', null, '{}')`, [a1.accountId])).rejects.toThrow(/already has this name/);
    const id = (await one<{ id: string }>(`select admin_save_role($1, null, 'Packers', 'Packing only', array['fulfillment.pick_list']) id`, [a1.accountId])).id;
    await pg.query(`select admin_save_role($1, $2, 'Packers', 'Packing', array['fulfillment.pick_list', 'fulfillment.orders'])`, [a1.accountId, id]);
    expect((await pg.query(`select feature_key from role_features where role_id = $1 order by 1`, [id])).rows).toEqual([
      { feature_key: "fulfillment.orders" },
      { feature_key: "fulfillment.pick_list" },
    ]);
    await pg.query(`select admin_delete_role($1, $2)`, [a1.accountId, id]);
    await asOwner(pg);
    await expect(pg.query(`update roles set is_admin = true where name = 'Production Operations'`)).rejects.toThrow(/full access/);
    await expect(pg.query(`insert into role_features (role_id, feature_key) values ($1, 'minileaf.guide')`, [adminRole])).rejects.toThrow(/every feature/);
    const actions = (await pg.query<{ action: string }>(`select action from access_audit_log order by created_at`)).rows.map((r) => r.action);
    expect(actions).toEqual(["role_created", "role_edited", "role_deleted"]);
  });

  it("invites refuse a duplicate email and require a role; delete clears email and login and keeps the name", async () => {
    const a1 = await addEmployee(pg, { roles: ["Admin"], first: "Ada", last: "Admin" });
    await asService(pg);
    const wh = await roleId(pg, "Warehouse Operations");
    const id = (await one<{ id: string }>(`select admin_create_invite($1, 'Jane', 'Doe', ' Jane.Doe@Example.Test ', array[$2]::uuid[]) id`, [a1.accountId, wh])).id;
    await pg.query(`select admin_finish_invite($1, $2, null, 'invited')`, [a1.accountId, id]);
    expect(await one(`select email, status, first_name from employee_accounts where id = $1`, [id])).toEqual({ email: "jane.doe@example.test", status: "invited", first_name: "Jane" });
    await expect(pg.query(`select admin_create_invite($1, 'J', 'D', 'jane.doe@example.test', array[$2]::uuid[])`, [a1.accountId, wh])).rejects.toThrow(/already has an account/);
    await expect(pg.query(`select admin_create_invite($1, 'J', 'D', 'j2@example.test', '{}'::uuid[])`, [a1.accountId])).rejects.toThrow(/at least one role/);
    await expect(pg.query(`select admin_create_invite($1, 'J', 'D', 'not-an-email', array[$2]::uuid[])`, [a1.accountId, wh])).rejects.toThrow(/valid email/);
    await asOwner(pg);
    const userId = await addAuthUser(pg, "jane.doe2@example.test");
    await asService(pg);
    await pg.query(`update employee_accounts set user_id = $2 where id = $1`, [id, userId]);
    const del = (await one<{ r: any }>(`select admin_delete_employee($1, $2) r`, [a1.accountId, id])).r;
    expect(del).toEqual({ user_id: userId, already: false });
    expect(await one(`select email, user_id, status, first_name, last_name, auth_delete_pending_user_id from employee_accounts where id = $1`, [id])).toEqual({
      email: null, user_id: null, status: "deleted", first_name: "Jane", last_name: "Doe", auth_delete_pending_user_id: userId,
    });
    expect((await one<{ n: number }>(`select count(*)::int n from employee_roles where employee_id = $1`, [id])).n).toBe(0);
    // The same address can be invited again.
    const again = (await one<{ id: string }>(`select admin_create_invite($1, 'Jane', 'Doe', 'jane.doe@example.test', array[$2]::uuid[]) id`, [a1.accountId, wh])).id;
    await pg.query(`select admin_finish_invite($1, $2, null, 'invited')`, [a1.accountId, again]);
    await expect(pg.query(`select admin_delete_employee($1, $1)`, [a1.accountId])).rejects.toThrow(/your own account/);
    const log = (await pg.query<any>(`select actor_name, action from access_audit_log order by created_at`)).rows;
    expect(log.map((l) => l.action)).toEqual(["invited", "deleted", "invited"]);
    expect(log[0].actor_name).toBe("Ada Admin");
  });
});

describe("bootstrap_admins", () => {
  const run = async (emails: string[]) =>
    (await pg.query<{ email: string; result: string }>(`select * from bootstrap_admins($1)`, [emails])).rows;

  it("makes existing logins Admins, reports unknown addresses, and is idempotent", async () => {
    const u1 = await addAuthUser(pg, "admin1@example.test");
    const u2 = await addAuthUser(pg, "Admin2@Example.Test");
    const usersBefore = (await one<{ n: number }>(`select count(*)::int n from auth.users`)).n;
    const first = await run([" ADMIN1@example.test", "admin2@example.test", "", "admin1@example.test", "nobody@example.test"]);
    expect(first).toEqual([
      { email: "admin1@example.test", result: "admin added" },
      { email: "admin2@example.test", result: "admin added" },
      { email: "nobody@example.test", result: "no sign-in account found" },
    ]);
    expect((await one<{ n: number }>(`select count(*)::int n from auth.users`)).n).toBe(usersBefore);
    const accounts = (await pg.query<any>(`select user_id, email, status, first_name, last_name from employee_accounts order by email`)).rows;
    expect(accounts).toEqual([
      { user_id: u1, email: "admin1@example.test", status: "active", first_name: null, last_name: null },
      { user_id: u2, email: "admin2@example.test", status: "active", first_name: null, last_name: null },
    ]);
    await asUser(pg, u1);
    expect((await one<{ v: boolean }>(`select is_admin() v`)).v).toBe(true);
    await asOwner(pg);
    const audit = (await pg.query<any>(`select actor_name, action, target from access_audit_log order by target`)).rows;
    expect(audit).toEqual([
      { actor_name: "System", action: "admin_bootstrapped", target: "admin1@example.test" },
      { actor_name: "System", action: "admin_bootstrapped", target: "admin2@example.test" },
    ]);

    const again = await run(["admin1@example.test", "admin2@example.test"]);
    expect(again.map((r) => r.result)).toEqual(["already admin", "already admin"]);
    expect((await one<{ n: number }>(`select count(*)::int n from access_audit_log`)).n).toBe(2);
    expect((await one<{ n: number }>(`select count(*)::int n from employee_accounts`)).n).toBe(2);
  });

  it("reuses an existing (invited) account for the address", async () => {
    const a = await addEmployee(pg, { roles: ["Warehouse Operations"], email: "admin3@example.test" });
    await pg.query(`update employee_accounts set status = 'invited', accepted_at = null where id = $1`, [a.accountId]);
    expect(await run(["admin3@example.test"])).toEqual([{ email: "admin3@example.test", result: "admin added" }]);
    expect(await one(`select status from employee_accounts where id = $1`, [a.accountId])).toEqual({ status: "active" });
    expect((await one<{ n: number }>(`select count(*)::int n from employee_roles where employee_id = $1`, [a.accountId])).n).toBe(2);
  });

  it("cannot be executed by anon, authenticated or service_role", async () => {
    const u = await addAuthUser(pg, "admin4@example.test");
    await asAnon(pg);
    await expect(pg.query(`select * from bootstrap_admins(array['admin4@example.test'])`)).rejects.toThrow(/permission denied/);
    await asUser(pg, u);
    await expect(pg.query(`select * from bootstrap_admins(array['admin4@example.test'])`)).rejects.toThrow(/permission denied/);
    await asService(pg);
    await expect(pg.query(`select * from bootstrap_admins(array['admin4@example.test'])`)).rejects.toThrow(/permission denied/);
    await asOwner(pg);
    expect((await one<{ n: number }>(`select count(*)::int n from employee_accounts`)).n).toBe(0);
  });

  it("the migration file contains no email address", () => {
    expect(migration("employee_accounts_roles.sql")).not.toMatch(/[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+\.[A-Za-z]{2,}/);
  });
});

describe("names come from the signed-in account", () => {
  it("a browser insert of a log entry stores the account's name and id, whatever was sent", async () => {
    const wh = await addEmployee(pg, { roles: ["Warehouse Operations"], first: "Jane", last: "Doe" });
    const lt = (await one<{ id: string }>(`select id from log_types limit 1`)).id;
    await asUser(pg, wh.userId);
    const row = await one<any>(
      `insert into log_entries (log_type_id, entry_number, performed_by_name, values) values ($1, 999, 'Someone Else', '{}') returning performed_by_name, performed_by_account_id`,
      [lt],
    );
    expect(row).toEqual({ performed_by_name: "Jane Doe", performed_by_account_id: wh.accountId });
    // Server (service role) inserts keep the name the server set from the session.
    await asService(pg);
    const srv = await one<any>(
      `insert into log_entries (log_type_id, entry_number, performed_by_name, performed_by_account_id, values) values ($1, 1000, 'Jane Doe', $2, '{}') returning performed_by_name`,
      [lt, wh.accountId],
    );
    expect(srv.performed_by_name).toBe("Jane Doe");
  });
});
