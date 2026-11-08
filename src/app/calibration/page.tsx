import { guardPage } from "@/lib/access/server";
import { Forbidden } from "@/components/access/Forbidden";
import ClientPage from "./client-page";

// Access is checked on the server for every request (feature catalog: "/calibration").
export default async function Page() {
  if ((await guardPage("/calibration")) === "forbidden") return <Forbidden />;
  return <ClientPage />;
}
