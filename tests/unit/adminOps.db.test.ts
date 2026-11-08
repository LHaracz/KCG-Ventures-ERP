/* eslint-disable @typescript-eslint/no-explicit-any */
// Employees page operations (src/lib/access/adminOps.ts) against the real
// migration functions in PGlite, with Supabase's auth API mocked. No email is
// sent. Invented people, example.test addresses.
import { beforeEach, describe, expect, it } from "vitest";
import type { PGlite } from "@electric-sql/pglite";
import { addEmployee, asOwner, createAccessDb, roleId } from "./helpers/accessDb";
import { serviceDb } from "./helpers/serviceDb";
import { deleteAccount, inviteEmployee, listEmployees, OpError, resendInvite, revokeInvite, setEmployeeActive, setEmployeeRoles, type AuthApi } from "@/lib/access/adminOps";
import { loadAccess } from "@/lib/access/access";

let pg: PGlite;
let db: ReturnType<typeof serviceDb>;
let actor: string;
let sent: Array<{ kind: string; email: string; redirectTo?: string }>;
let failNextSend = false;
let failNextDelete = false;

function mockAuth(): AuthApi {
  return {
    admin: {
      async inviteUserByEmail(email, opts) {
        if (failNextSend) {
          failNextSend = false;
          return { data: null, error: { message: "smtp down" } };
        }
        await asOwner(pg);
        const r = await pg.query<{ id: string }>(`insert into auth.users (id, email) values (gen_random_uuid(), $1) returning id`, [email]);
        sent.push({ kind: "invite", email, redirectTo: opts.redirectTo });
        return { data: { user: { id: r.rows[0].id } }, error: null };
      },
      async deleteUser(id) {
        if (failNextDelete) {
          failNextDelete = false;
          return { error: { message: "auth unavailable" } };
        }
        await asOwner(pg);
        await pg.query(`delete from auth.users where id = $1`, [id]);
        return { error: null };
      },
      async listUsers({ page }) {
        await asOwner(pg);
        if (page > 1) return { data: { users: [] }, error: null };
        const r = await pg.query<{ id: string; email: string }>(`select id, email from auth.users`);
        return { data: { users: r.rows }, error: null };
      },
    },
    async resetPasswordForEmail(email, opts) {
      sent.push({ kind: "reset", email, redirectTo: opts.redirectTo });
      return { error: null };
    },
  };
}

const authUsers = async () => {
  await asOwner(pg);
  return (await pg.query<{ id: string }>(`select id from auth.users`)).rows.length;
};
const audit = async () => {
  await asOwner(pg);
  return (await pg.query<{ action: string }>(`select action from access_audit_log order by created_at, action`)).rows.map((r) => r.action);
};
const fails = async (fn: () => Promise<unknown>, code: string) => {
  let got: unknown;
  try {
    await fn();
  } catch (e) {
    got = e;
  }
  expect(got).toBeInstanceOf(OpError);
  expect((got as OpError).code).toBe(code);
};

beforeEach(async () => {
  ({ pg } = await createAccessDb());
  db = serviceDb(pg);
  sent = [];
  failNextSend = false;
  failNextDelete = false;
  actor = (await addEmployee(pg, { roles: ["Admin"], first: "Ada", last: "Admin", email: "admin1@example.test" })).accountId;
});

const ORIGIN = "https://erp.example.test";

describe("invite and accept", () => {
  it("creates an invited account, sends one invite to the accept-invite page, and activates on accept", async () => {
    const wh = await roleId(pg, "Warehouse Operations");
    const r = await inviteEmployee(db, mockAuth(), actor, ORIGIN, { firstName: " Sam ", lastName: "Stock", email: "Sam1@Example.test", roleIds: [wh] });
    expect(r.mode).toBe("invited");
    expect(sent).toEqual([{ kind: "invite", email: "sam1@example.test", redirectTo: `${ORIGIN}/auth/accept-invite` }]);
    const list = await listEmployees(db);
    const sam = list.find((e) => e.id === r.accountId)!;
    expect(sam).toMatchObject({ firstName: "Sam", lastName: "Stock", email: "sam1@example.test", status: "invited" });
    expect(sam.roles.map((x) => x.name)).toEqual(["Warehouse Operations"]);
    expect(await audit()).toContain("invited");

    // Invited people have no access yet.
    await asOwner(pg);
    const userId = (await pg.query<{ user_id: string }>(`select user_id from employee_accounts where id = $1`, [r.accountId])).rows[0].user_id;
    expect((await loadAccess(db as any, userId)).active).toBe(false);

    // Accepting (what /api/account/set-password does after saving the password).
    await db.from("employee_accounts").update({ status: "active", accepted_at: new Date().toISOString() }).eq("id", r.accountId).eq("status", "invited");
    const access = await loadAccess(db as any, userId);
    expect(access.active).toBe(true);
    expect(access.fullName).toBe("Sam Stock");
    expect(access.features.has("compliance.coas")).toBe(true);
    expect(access.features.has("production.planner")).toBe(false);
  });

  it("asks for confirmation before inviting an Admin, and rejects duplicates", async () => {
    const adm = await roleId(pg, "Admin");
    await fails(() => inviteEmployee(db, mockAuth(), actor, ORIGIN, { firstName: "A", lastName: "B", email: "new1@example.test", roleIds: [adm] }), "confirm_admin");
    await inviteEmployee(db, mockAuth(), actor, ORIGIN, { firstName: "A", lastName: "B", email: "new1@example.test", roleIds: [adm], confirmAdmin: true });
    await fails(() => inviteEmployee(db, mockAuth(), actor, ORIGIN, { firstName: "A", lastName: "B", email: "admin1@example.test", roleIds: [adm], confirmAdmin: true }), "email_exists");
  });

  it("removes the account again when the invite email can't be sent", async () => {
    const wh = await roleId(pg, "Warehouse Operations");
    failNextSend = true;
    await fails(() => inviteEmployee(db, mockAuth(), actor, ORIGIN, { firstName: "Al", lastName: "Fail", email: "fail1@example.test", roleIds: [wh] }), "send_failed");
    expect((await listEmployees(db)).some((e) => e.email === "fail1@example.test")).toBe(false);
  });

  it("links a stray login with no account and sends a reset link instead", async () => {
    await asOwner(pg);
    await pg.query(`insert into auth.users (id, email) values (gen_random_uuid(), 'stray1@example.test')`);
    const wh = await roleId(pg, "Warehouse Operations");
    const r = await inviteEmployee(db, mockAuth(), actor, ORIGIN, { firstName: "St", lastName: "Ray", email: "stray1@example.test", roleIds: [wh] });
    expect(r.mode).toBe("linked_existing");
    expect(sent).toEqual([{ kind: "reset", email: "stray1@example.test", redirectTo: `${ORIGIN}/auth/accept-invite?flow=recovery` }]);
  });

  it("resend replaces the old login; revoke removes it and the account", async () => {
    const wh = await roleId(pg, "Warehouse Operations");
    const before = await authUsers();
    const r = await inviteEmployee(db, mockAuth(), actor, ORIGIN, { firstName: "Re", lastName: "Send", email: "resend1@example.test", roleIds: [wh] });
    await resendInvite(db, mockAuth(), actor, ORIGIN, r.accountId);
    expect(sent.map((s) => s.kind)).toEqual(["invite", "invite"]);
    expect(await authUsers()).toBe(before + 1);
    await revokeInvite(db, mockAuth(), actor, r.accountId);
    expect(await authUsers()).toBe(before);
    expect((await listEmployees(db)).some((e) => e.id === r.accountId)).toBe(false);
    expect(await audit()).toEqual(expect.arrayContaining(["invited", "invite_resent", "invite_revoked"]));
  });
});

describe("delete, deactivate, roles", () => {
  it("delete needs the typed email, ends access at once, and can be retried if the login delete fails", async () => {
    const p = await addEmployee(pg, { roles: ["Production Operations"], email: "del1@example.test" });
    await fails(() => deleteAccount(db, mockAuth(), actor, p.accountId, "wrong@example.test"), "confirm_mismatch");

    failNextDelete = true;
    await fails(() => deleteAccount(db, mockAuth(), actor, p.accountId, "DEL1@example.test"), "auth_delete_failed");
    expect((await loadAccess(db as any, p.userId)).active).toBe(false);
    const pending = (await listEmployees(db)).find((e) => e.id === p.accountId)!;
    expect(pending.deletePending).toBe(true);

    await deleteAccount(db, mockAuth(), actor, p.accountId, "");
    expect((await listEmployees(db)).some((e) => e.id === p.accountId)).toBe(false);
    await asOwner(pg);
    expect((await pg.query(`select 1 from auth.users where id = $1`, [p.userId])).rows).toHaveLength(0);
  });

  it("the last Admin can't be deactivated, demoted or deleted", async () => {
    const wh = await roleId(pg, "Warehouse Operations");
    // Admins can't act on themselves at all; the last-admin rule also holds
    // when the request names someone else as the actor.
    await fails(() => setEmployeeActive(db, actor, actor, false), "self");
    await asOwner(pg);
    const other = (await addEmployee(pg, { roles: ["Warehouse Operations"] })).accountId;
    await fails(() => setEmployeeActive(db, other, actor, false), "last_admin");
    await fails(() => setEmployeeRoles(db, other, actor, [wh], false), "last_admin");
    await asOwner(pg);
    const email = (await pg.query<{ email: string }>(`select email from employee_accounts where id = $1`, [actor])).rows[0].email;
    await fails(() => deleteAccount(db, mockAuth(), other, actor, email), "last_admin");
  });

  it("deactivating someone ends their access on the next check", async () => {
    const p = await addEmployee(pg, { roles: ["Warehouse Operations"] });
    expect((await loadAccess(db as any, p.userId)).active).toBe(true);
    await setEmployeeActive(db, actor, p.accountId, false);
    expect((await loadAccess(db as any, p.userId)).active).toBe(false);
    await setEmployeeActive(db, actor, p.accountId, true);
    expect((await loadAccess(db as any, p.userId)).active).toBe(true);
  });

  it("making someone an Admin needs confirmation", async () => {
    const p = await addEmployee(pg, { roles: ["Warehouse Operations"] });
    const adm = await roleId(pg, "Admin");
    await fails(() => setEmployeeRoles(db, actor, p.accountId, [adm], false), "confirm_admin");
    await setEmployeeRoles(db, actor, p.accountId, [adm], true);
    expect((await loadAccess(db as any, p.userId)).isAdmin).toBe(true);
  });
});
