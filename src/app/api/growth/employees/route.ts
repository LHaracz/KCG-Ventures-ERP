import { NextResponse } from "next/server";
import { guardApi } from "@/lib/access/api";
import { listAssignableEmployees } from "@/lib/growth/employees";
import { growthDb, growthError } from "@/lib/growth/routeHelpers";

/** Active employees (id and name only) for owner dropdowns. Any of the three Marketing & Sales features. */
export async function GET(request: Request) {
  const denied = await guardApi(request);
  if (denied) return denied;
  try {
    return NextResponse.json({ employees: await listAssignableEmployees(growthDb()) });
  } catch (error) {
    return growthError(error);
  }
}
