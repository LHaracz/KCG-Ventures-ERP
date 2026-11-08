import { NextResponse } from "next/server";
import { jsonError, UUID_RE, withSopApi } from "@/lib/sopApi";
import { sopsUsingProduct } from "@/lib/sopService";
import { guardApi } from "@/lib/access/api";

/** SOPs whose current version has a formula table for this product, with an up-to-date flag. */
export async function GET(request: Request, { params }: { params: Promise<{ productId: string }> }) {
  const denied = await guardApi(request);
  if (denied) return denied;
  return withSopApi(request, async ({ admin }) => {
    const { productId } = await params;
    if (!UUID_RE.test(productId)) return jsonError("Invalid product id.");
    return NextResponse.json({ sops: await sopsUsingProduct(admin, productId) });
  });
}
