import { redirect } from "next/navigation";
import { guardPage } from "@/lib/access/server";
import { Forbidden } from "@/components/access/Forbidden";

// The old employee roster page. People are now managed on the Employees page
// (accounts and roles); the roster table and its data are kept for old records.
// Admins are redirected; everyone else sees the forbidden message.
export default async function Page() {
  if ((await guardPage("/settings/employees")) === "forbidden") return <Forbidden />;
  redirect("/employees");
}
