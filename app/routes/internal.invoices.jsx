import { unauthenticated } from "../shopify.server";
import { loadDashboardOrders } from "../lib/dashboard.server";
import { syncDueInvoices } from "../lib/invoice.server";

/**
 * POST /internal/invoices?shop=store.myshopify.com
 * Header: Authorization: Bearer {CRON_SECRET}
 * Sends due remaining-balance invoices (same path as dashboard load).
 */
export const action = async ({ request }) => {
  if (request.method !== "POST") {
    return new Response("Method not allowed", { status: 405 });
  }

  // eslint-disable-next-line no-undef
  const secret = process.env.CRON_SECRET || "";
  const auth = request.headers.get("Authorization") || "";
  const token = auth.startsWith("Bearer ") ? auth.slice(7) : "";
  if (!secret || token !== secret) {
    return new Response("Unauthorized", { status: 401 });
  }

  const shop = new URL(request.url).searchParams.get("shop");
  if (!shop) {
    return Response.json({ error: "Missing shop query parameter." }, { status: 400 });
  }

  let admin;
  try {
    ({ admin } = await unauthenticated.admin(shop));
  } catch (error) {
    return Response.json(
      { error: error?.message || "Could not load shop session." },
      { status: 401 },
    );
  }

  const { orders } = await loadDashboardOrders(admin);
  const payload = await syncDueInvoices(admin, orders);
  return Response.json({
    ok: true,
    shop,
    sent: payload.sent,
    repaired: payload.repaired,
    skipped: payload.skipped,
    errors: payload.errors,
  });
};

export const loader = async () =>
  Response.json({
    ok: true,
    message:
      "POST with Authorization: Bearer CRON_SECRET and ?shop=store.myshopify.com to send due invoices.",
  });
