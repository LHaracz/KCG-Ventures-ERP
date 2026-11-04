/**
 * Browser-test fakes for EasyPost and Shopify. Active only when the server
 * runs with E2E_MODE=1 AND the id is an invented test id (EasyPost shipment
 * "shp_e2e_…", Shopify order "TEST-…"). Never active in production: Vercel
 * does not set E2E_MODE, and real ids never match.
 */
export function e2eModeOn(): boolean {
  return process.env.E2E_MODE === "1" && process.env.NODE_ENV !== "production";
}

export function isFakeShipment(shipmentId: string | null | undefined): boolean {
  return e2eModeOn() && !!shipmentId && shipmentId.startsWith("shp_e2e_");
}

export function isFakeOrder(orderId: string | null | undefined): boolean {
  return e2eModeOn() && !!orderId && orderId.startsWith("TEST-");
}
