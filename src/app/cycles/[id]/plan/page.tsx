import { guardPage } from "@/lib/access/server";
import { Forbidden } from "@/components/access/Forbidden";
import ClientPage from "./client-page";

// Access is checked on the server for every request (feature catalog: "/cycles/[id]/plan").
export default async function Page() {
  if ((await guardPage("/cycles/[id]/plan")) === "forbidden") return <Forbidden />;
  return <ClientPage />;
}
