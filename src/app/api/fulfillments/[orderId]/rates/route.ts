import { NextResponse } from "next/server";
import { requireApiUserFromBearerToken } from "@/lib/apiAuth";
import { supabaseAdmin } from "@/lib/supabaseAdmin";
import { createEasyPostShipment, type EasyPostAddress, type EasyPostRate } from "@/lib/easypost";

/**
 * Fulfillments Part 2b — quote-only route. Creates an EasyPost shipment and
 * returns its rates plus a pre-selection suggestion. Never buys anything;
 * that only happens when the employee confirms inside the Generate Label
 * popup and the client calls buy-label with the returned shipment/rate ids.
 */

type ShippingAddressInput = {
  name: string;
  address1: string | null;
  address2: string | null;
  city: string | null;
  province: string | null;
  zip: string | null;
  country: string | null;
  phone: string | null;
};

type RatesRequestBody = {
  parcel: {
    length_in: number;
    width_in: number;
    height_in: number;
    weight_oz: number;
  };
  shippingAddress: ShippingAddressInput | null;
  shippingMethodTitle: string | null;
};

function badRequest(message: string) {
  return NextResponse.json({ error: message }, { status: 400 });
}

async function loadShipFromAddress(): Promise<EasyPostAddress | null> {
  if (!supabaseAdmin) return null;
  const { data, error } = await supabaseAdmin
    .from("fulfillments_settings")
    .select(
      "ship_from_name, ship_from_address1, ship_from_address2, ship_from_city, ship_from_state, ship_from_zip, ship_from_country, ship_from_phone",
    )
    .eq("id", "c0000000-0000-0000-0000-000000000001")
    .maybeSingle();

  if (error || !data) return null;
  if (!data.ship_from_name || !data.ship_from_address1 || !data.ship_from_city || !data.ship_from_zip) {
    return null;
  }

  return {
    name: data.ship_from_name,
    street1: data.ship_from_address1,
    street2: data.ship_from_address2 || undefined,
    city: data.ship_from_city,
    state: data.ship_from_state,
    zip: data.ship_from_zip,
    country: data.ship_from_country || "US",
    phone: data.ship_from_phone || undefined,
  };
}

// Substring match (not exact): does the order's shipping_line.title CONTAIN
// a shipping_method_map row's shopify_title, case-insensitively? If no row
// matches, or the matched carrier/service isn't in this shipment's actual
// rates, return no pre-selection — never guess.
async function findPreselectedRate(
  shippingMethodTitle: string | null,
  rates: EasyPostRate[],
): Promise<EasyPostRate | null> {
  if (!supabaseAdmin || !shippingMethodTitle?.trim()) return null;

  const { data } = await supabaseAdmin
    .from("shipping_method_map")
    .select("shopify_title, easypost_carrier, easypost_service");

  const titleLower = shippingMethodTitle.trim().toLowerCase();
  const match = (data || []).find((row) => titleLower.includes(row.shopify_title.trim().toLowerCase()));
  if (!match) return null;

  return (
    rates.find(
      (r) =>
        r.carrier.toLowerCase() === match.easypost_carrier.toLowerCase() &&
        r.service.toLowerCase() === match.easypost_service.toLowerCase(),
    ) ?? null
  );
}

export async function POST(request: Request, { params }: { params: Promise<{ orderId: string }> }) {
  try {
    await requireApiUserFromBearerToken(request);
    const { orderId } = await params;
    if (!orderId?.trim()) return badRequest("Missing orderId.");

    const body = (await request.json()) as RatesRequestBody;
    if (!body?.parcel) return badRequest("Missing package dimensions. Select a package preset first.");

    const fromAddress = await loadShipFromAddress();
    if (!fromAddress) {
      return badRequest(
        "Ship-from address is not configured. Set it on the Fulfillments Settings page before generating a label.",
      );
    }

    if (!body.shippingAddress) return badRequest("This order has no shipping address.");
    const addr = body.shippingAddress;
    if (!addr.address1 || !addr.city || !addr.zip) {
      return badRequest("This order's shipping address is missing required fields.");
    }

    const toAddress: EasyPostAddress = {
      name: addr.name || "Customer",
      street1: addr.address1,
      street2: addr.address2 || undefined,
      city: addr.city,
      state: addr.province || "",
      zip: addr.zip,
      country: addr.country || "US",
      phone: addr.phone || undefined,
    };

    const shipment = await createEasyPostShipment({
      to_address: toAddress,
      from_address: fromAddress,
      parcel: {
        length: body.parcel.length_in,
        width: body.parcel.width_in,
        height: body.parcel.height_in,
        weight: body.parcel.weight_oz,
      },
    });

    if (!shipment.rates || shipment.rates.length === 0) {
      return NextResponse.json(
        { error: "EasyPost returned no shipping rates for this order." },
        { status: 500 },
      );
    }

    const preselected = await findPreselectedRate(body.shippingMethodTitle, shipment.rates);

    return NextResponse.json({
      easypostShipmentId: shipment.id,
      rates: shipment.rates,
      preselectedRateId: preselected?.id ?? null,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unexpected server error.";
    const status = message === "Unauthorized." || message.includes("bearer token") ? 401 : 500;
    return NextResponse.json({ error: message }, { status });
  }
}
