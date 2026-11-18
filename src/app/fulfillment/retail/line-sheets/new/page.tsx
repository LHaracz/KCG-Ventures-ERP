import { guardPage } from "@/lib/access/server";
import { Forbidden } from "@/components/access/Forbidden";
import ClientPage from "./client-page";

// Admin only, checked on the server for every request (catalog: "/fulfillment/retail/line-sheets/new").
export default async function Page() {
  if ((await guardPage("/fulfillment/retail/line-sheets/new")) === "forbidden") return <Forbidden />;
  return <ClientPage />;
}
