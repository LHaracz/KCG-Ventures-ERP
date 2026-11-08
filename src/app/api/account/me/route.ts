import { NextResponse } from "next/server";
import { callerOf, guardApi } from "@/lib/access/api";
import { buildSidebar } from "@/lib/access/catalog";

/** The signed-in login's access, read from the database now. Used to build the sidebar and hide links. */
export async function GET(request: Request) {
  const denied = await guardApi(request);
  if (denied) return denied;
  const { access } = callerOf(request);
  return NextResponse.json({
    active: access.active,
    status: access.status,
    isAdmin: access.isAdmin,
    features: Array.from(access.features).sort(),
    roles: access.roles,
    firstName: access.firstName,
    lastName: access.lastName,
    fullName: access.fullName,
    accountId: access.accountId,
    sidebar: buildSidebar(access),
  });
}
