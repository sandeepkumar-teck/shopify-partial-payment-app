import { SETTINGS_METAFIELD } from "./partial-payment";
import { parsePartialPaymentMeta } from "./order-edit-partial-payment.server";
import { mapDashboardOrder } from "./dashboard";
import {
  afterInvoiceSend,
  buildInvoiceSchedulePatch,
  invoiceIsDue,
  orderAllowsInvoice,
  parseInvoiceSchedule,
  parseScheduleFormValue,
  repairStaleMonthlySchedule,
} from "./invoice-schedule";
import { syncOrderSnapshotFromAdmin } from "./reporting-snapshot.server";

const MAX_AUTO_SENDS = 15;

async function fetchOrderForInvoice(admin, orderId) {
  const id = toOrderGid(orderId);
  if (!id) return null;
  const query = (includeCancelledAt, includeMoneyExtras = true) => `#graphql
      query PartialPaymentOrderInvoice($id: ID!) {
        order(id: $id) {
          id
          name
          createdAt
          ${includeCancelledAt ? "cancelledAt" : ""}
          tags
          displayFinancialStatus
          currentTotalPriceSet {
            shopMoney { amount currencyCode }
          }
          ${includeMoneyExtras ? `totalOutstandingSet {
            shopMoney { amount currencyCode }
          }
          totalReceivedSet {
            shopMoney { amount currencyCode }
          }` : ""}
          customAttributes { key value }
          metafield(namespace: "$app", key: "partial_payment") { value }
          lineItems(first: 50) {
            nodes {
              title
              customAttributes { key value }
              originalUnitPriceSet { shopMoney { amount } }
              discountedUnitPriceSet { shopMoney { amount } }
            }
          }
        }
      }
    `;
  let json = await graphqlJson(admin, query(true, true), { id });
  let errorText = mutationErrors(json, "order").join(" ");
  if (/cancelledat|totaloutstandingset|totalreceivedset/i.test(errorText)) {
    json = await graphqlJson(
      admin,
      query(!/cancelledat/i.test(errorText), !/totaloutstandingset|totalreceivedset/i.test(errorText)),
      { id },
    );
  }
  const errors = mutationErrors(json, "order");
  if (errors.length) {
    console.warn("Invoice order lookup:", errors.join("; "));
  }
  return json?.data?.order || null;
}

function asErrorList(value) {
  if (value == null) return [];
  if (Array.isArray(value)) return value;
  if (typeof value === "object" && value.message) return [value];
  return [{ message: String(value) }];
}

function mutationErrors(json, mutationName) {
  const payload = json?.data?.[mutationName];
  return [
    ...asErrorList(json?.errors),
    ...asErrorList(payload?.userErrors),
  ]
    .map((error) => error.message || JSON.stringify(error))
    .filter(Boolean);
}

function toOrderGid(value) {
  const raw = String(value || "").trim();
  if (!raw) return "";
  if (raw.startsWith("gid://")) return raw;
  const digits = raw.replace(/\D/g, "");
  return digits ? `gid://shopify/Order/${digits}` : "";
}

function mergeOrderMeta(order, nextMeta) {
  if (!order) return nextMeta;
  const encoded = JSON.stringify(nextMeta);
  if (order.metafield && typeof order.metafield === "object") {
    order.metafield.value = encoded;
  } else {
    order.metafield = { value: encoded };
  }
  return nextMeta;
}

async function graphqlJson(admin, query, variables) {
  try {
    const response = await admin.graphql(query, variables ? { variables } : undefined);
    return await response.json();
  } catch (error) {
    if (error?.body && typeof error.body === "object") {
      return error.body;
    }
    throw error;
  }
}

async function writeInvoiceMeta(admin, order, patch) {
  const meta = parsePartialPaymentMeta(order);
  const next = { ...meta, ...patch };
  const json = await graphqlJson(
    admin,
    `#graphql
      mutation SetOrderInvoiceSchedule($metafields: [MetafieldsSetInput!]!) {
        metafieldsSet(metafields: $metafields) {
          userErrors { field message }
        }
      }
    `,
    {
      metafields: [
        {
          ownerId: order.id,
          namespace: SETTINGS_METAFIELD.namespace,
          key: SETTINGS_METAFIELD.key,
          type: "json",
          value: JSON.stringify(next),
        },
      ],
    },
  );
  const errors = mutationErrors(json, "metafieldsSet");
  if (errors.length) {
    throw new Error(errors.join("; "));
  }
  mergeOrderMeta(order, next);
  void syncOrderSnapshotFromAdmin(admin, order.id);
  return next;
}

export async function sendShopifyOrderInvoice(admin, orderId) {
  const id = toOrderGid(orderId);
  const json = await graphqlJson(
    admin,
    `#graphql
      mutation SendRemainingInvoice($id: ID!) {
        orderInvoiceSend(id: $id) {
          userErrors { field message }
        }
      }
    `,
    { id },
  );
  const errors = mutationErrors(json, "orderInvoiceSend");
  if (errors.length) {
    return {
      ok: false,
      error:
        errors[0] ||
        "Could not send invoice. Email a Shopify invoice from Admin → Order → Send invoice.",
    };
  }
  return { ok: true };
}

export async function sendOrderInvoice(admin, orderRef) {
  const order = await fetchOrderForInvoice(admin, orderRef);
  if (!order) return { ok: false, error: "Order not found", orderId: String(orderRef || "") };
  const mapped = mapDashboardOrder(order);
  if (!mapped || !orderAllowsInvoice(mapped)) {
    return {
      ok: false,
      error: "No remaining balance to invoice.",
      orderId: order.id,
      name: order.name,
    };
  }

  const sent = await sendShopifyOrderInvoice(admin, order.id);
  if (!sent.ok) {
    return { ...sent, orderId: order.id, name: order.name };
  }

  const meta = parsePartialPaymentMeta(order);
  const next = afterInvoiceSend(meta, { stillUnpaid: true, now: new Date() });
  try {
    await writeInvoiceMeta(admin, order, next);
  } catch (error) {
    console.warn("Invoice sent but metafield update failed:", error?.message || error);
  }

  return {
    ok: true,
    orderId: order.id,
    name: order.name,
    invoiceSentAt: next.invoiceSentAt,
  };
}

export async function scheduleOrderInvoice(admin, orderRef, form) {
  const order = await fetchOrderForInvoice(admin, orderRef);
  if (!order) return { ok: false, error: "Order not found", orderId: String(orderRef || "") };
  const mapped = mapDashboardOrder(order);
  if (!mapped || !orderAllowsInvoice(mapped)) {
    return {
      ok: false,
      error: "Auto invoice is only available while a balance is due.",
      orderId: order.id,
      name: order.name,
    };
  }

  const { mode, days } = parseScheduleFormValue(
    form?.schedule ?? form?.invoiceMode,
    form?.invoiceDays ?? form?.days,
  );
  const meta = parsePartialPaymentMeta(order);
  const patch = buildInvoiceSchedulePatch(
    { mode, days, orderCreatedAt: order.createdAt, now: new Date() },
    meta,
  );
  await writeInvoiceMeta(admin, order, patch);
  return {
    ok: true,
    orderId: order.id,
    name: order.name,
    invoiceMode: patch.invoiceMode,
    invoiceDueAt: patch.invoiceDueAt,
  };
}

function mappedAllowsAuto(order, mapped) {
  if (!mapped || !orderAllowsInvoice(mapped)) return false;
  if (order?.cancelledAt) return false;
  const financial = String(order?.displayFinancialStatus || "").toUpperCase();
  if (financial === "VOIDED") return false;
  return true;
}

export async function syncDueInvoices(admin, orders = [], { now = new Date() } = {}) {
  const list = Array.isArray(orders) ? orders : [];
  const result = { sent: 0, repaired: 0, skipped: 0, errors: [] };

  for (const order of list) {
    if (!order?.id) continue;
    const mapped = mapDashboardOrder(order);
    if (!mappedAllowsAuto(order, mapped)) {
      result.skipped += 1;
      continue;
    }

    const meta = parsePartialPaymentMeta(order);
    const schedule = parseInvoiceSchedule(meta);
    const repaired = repairStaleMonthlySchedule(meta, now);
    if (repaired) {
      try {
        await writeInvoiceMeta(admin, order, repaired);
        result.repaired += 1;
      } catch (error) {
        result.errors.push({ orderId: order.id, error: error?.message || String(error) });
      }
      continue;
    }

    if (!invoiceIsDue(schedule, now)) continue;
    if (result.sent >= MAX_AUTO_SENDS) break;

    const sent = await sendShopifyOrderInvoice(admin, order.id);
    if (!sent.ok) {
      result.errors.push({ orderId: order.id, name: order.name, error: sent.error });
      continue;
    }

    try {
      await writeInvoiceMeta(admin, order, afterInvoiceSend(meta, { stillUnpaid: true, now }));
      result.sent += 1;
    } catch (error) {
      result.errors.push({ orderId: order.id, error: error?.message || String(error) });
    }
  }

  return result;
}
