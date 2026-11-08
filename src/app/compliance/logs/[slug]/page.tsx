import { guardPage } from "@/lib/access/server";
import { Forbidden } from "@/components/access/Forbidden";
import ClientPage from "./client-page";

// Access is checked on the server for every request (feature catalog: "/compliance/logs/[slug]").
export default async function Page() {
  if ((await guardPage("/compliance/logs/[slug]")) === "forbidden") return <Forbidden />;
  return <ClientPage />;
}
