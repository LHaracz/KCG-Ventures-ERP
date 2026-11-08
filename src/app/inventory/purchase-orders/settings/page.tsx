import { guardPage } from "@/lib/access/server";
import { Forbidden } from "@/components/access/Forbidden";
import ClientPage from "./client-page";

// Access is checked on the server for every request (feature catalog: "/inventory/purchase-orders/settings").
export default async function Page() {
  if ((await guardPage("/inventory/purchase-orders/settings")) === "forbidden") return <Forbidden />;
  return <ClientPage />;
}
