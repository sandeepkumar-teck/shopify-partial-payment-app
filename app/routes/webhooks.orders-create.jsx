import { authenticate, unauthenticated } from "../shopify.server";
import {
  applyPartialPaymentRefundStatus,
  detectInvoiceFullyPaid,
  restorePartialPaymentOrderById,
} from "../lib/process-partial-payment-order.server";
import { customerFromOrderPayload, enrichCustomerFromAdmin, recordWebhookLog } from "../lib/webhook-log.server";
import { syncOrderSnapshotFromAdmin } from "../lib/reporting-snapshot.server";

function isPartialPaymentOrderTopic(topic) {
  const normalized = String(topic || "")
    .toUpperCase()
    .replace(/\//g, "_");
  return normalized === "ORDERS_CREATE" || normalized === "ORDERS_UPDATED" || normalized === "ORDERS_PAID";
}

function orderGidFromPayload(payload) {
  if (payload?.admin_graphql_api_id) return String(payload.admin_graphql_api_id);
  if (payload?.id) return `gid://shopify/Order/${payload.id}`;
  return null;
}

export const action = async ({ request }) => {
  const { admin: webhookAdmin, topic, payload, shop } = await authenticate.webhook(request);
  const orderId = orderGidFromPayload(payload);
  let customer = customerFromOrderPayload(payload);
  console.log("[partial-payment] webhook received", {
    topic,
    shop,
    orderId,
    restId: payload?.id || null,
    financialStatus: payload?.financial_status || null,
    lineCount: (payload?.line_items || payload?.lineItems || []).length,
    tags: payload?.tags || null,
  });

  if (!isPartialPaymentOrderTopic(topic)) {
    return new Response();
  }

  let admin = webhookAdmin;
  if (!admin && shop) {
    try {
      const fallback = await unauthenticated.admin(shop);
      admin = fallback.admin;
    } catch (error) {
      console.warn("[partial-payment] webhook: no admin session for", shop, error.message);
      await recordWebhookLog({ shop, topic, orderId, ...customer, ok: false, reason: "no_admin_session" });
      return new Response();
    }
  }

  if (!admin) {
    console.warn("[partial-payment] webhook: missing admin client", { topic, shop, orderId });
    await recordWebhookLog({ shop, topic, orderId, ...customer, ok: false, reason: "missing_admin" });
    return new Response();
  }

  if (!orderId) {
    console.warn("[partial-payment] webhook: missing order id", { topic, shop });
    await recordWebhookLog({ shop, topic, orderId, ...customer, ok: false, reason: "missing_order_id" });
    return new Response();
  }

  customer = await enrichCustomerFromAdmin(admin, orderId, customer);

  let markedFullyPaid = false;
  const topicKey = String(topic || "")
    .toUpperCase()
    .replace(/\//g, "_");
  if (topicKey === "ORDERS_UPDATED" || topicKey === "ORDERS_PAID") {
    try {
      const refund = await applyPartialPaymentRefundStatus(admin, payload);
      if (!refund?.skipped) {
        console.log("[partial-payment] refund status", { shop, orderId, refund });
      }
    } catch (error) {
      console.warn("[partial-payment] refund status failed", {
        shop,
        orderId,
        error: error.message,
      });
    }

    try {
      const fullyPaid = await detectInvoiceFullyPaid(admin, payload, { topic });
      markedFullyPaid = Boolean(fullyPaid && !fullyPaid.skipped && !fullyPaid.error);
      if (!fullyPaid?.skipped) {
        console.log("[partial-payment] invoice fully paid", { shop, orderId, fullyPaid });
      }
    } catch (error) {
      console.warn("[partial-payment] invoice fully paid failed", {
        shop,
        orderId,
        error: error.message,
      });
    }
  }

  try {
    const restore = await restorePartialPaymentOrderById(admin, orderId, {
      topic,
      webhookPayload: payload,
      preserveFullyPaidNote: markedFullyPaid,
    });
    const skipped = restore?.skipped || restore?.result?.skipped || false;
    const reason = restore?.reason || restore?.result?.reason || restore?.error || null;
    console.log("[partial-payment] restore result", {
      topic,
      shop,
      orderId,
      restore,
      skipped,
      reason,
      orderEdited: restore?.result?.orderEdited ?? null,
    });
    await recordWebhookLog({
      shop,
      topic,
      orderId,
      ...customer,
      ok: !restore?.error,
      reason: reason || (skipped ? "skipped" : null),
    });
    void syncOrderSnapshotFromAdmin(admin, orderId, { shop, ...customer });
  } catch (error) {
    console.warn("[partial-payment] restore failed", {
      topic,
      shop,
      orderId,
      error: error.message,
    });
    await recordWebhookLog({
      shop,
      topic,
      orderId,
      ...customer,
      ok: false,
      reason: error.message,
    });
    void syncOrderSnapshotFromAdmin(admin, orderId, { shop, ...customer });
  }

  return new Response();
};
