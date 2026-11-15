import { guardPage } from "@/lib/access/server";
import { Forbidden } from "@/components/access/Forbidden";
import ClientPage from "./client-page";

// Admin only, checked on the server for every request (catalog: "/fulfillment/retail/invoices/[id]").
export default async function Page() {
  if ((await guardPage("/fulfillment/retail/invoices/[id]")) === "forbidden") return <Forbidden />;
  return <ClientPage />;
}
