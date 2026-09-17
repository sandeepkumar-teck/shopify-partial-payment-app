import "@shopify/ui-extensions/preact";
import { render } from "preact";
import { useEffect, useRef, useState } from "preact/hooks";
import {
  ORDER_BLOCK_POLL_MS,
  fetchPartialPaymentOrder,
} from "./partialPaymentOrderQuery";

const ORDER_DETAILS_TARGET = "admin.order-details.block.render";

/**
 * Preact admin extensions expose the same surface as React `useApi(target)`
 * via the `shopify` global. Admin blocks have no `useAppData` / Order resource
 * subscription, so this block polls with a read-only `query`.
 */
function useApi(_target) {
  return shopify;
}

function extensionIsHidden() {
  try {
    if (typeof document === "undefined") return false;
    if (document.visibilityState === "hidden") return true;
    if (document.hidden === true) return true;
  } catch {
    return false;
  }
  return false;
}

export default async () => {
  render(<OrderBlock />, document.body);
};

function money(amount) {
  return `₹${Number(amount || 0).toLocaleString("en-IN")}`;
}

function shopMoney(set) {
  return Number(set?.shopMoney?.amount || 0);
}

function isInvoiceFullyCollected(order, metafield, remaining) {
  const financial = String(order?.displayFinancialStatus || "").toUpperCase();
  if (financial !== "PAID") return false;
  if (shopMoney(order?.totalOutstandingSet) > 0.009) return false;
  if (!(Number(remaining) > 0.009)) return false;
  const currentTotal = shopMoney(order?.currentTotalPriceSet);
  const captured = shopMoney(order?.totalReceivedSet);
  const fullPrice = Number(metafield?.fullPrice || 0);
  const payNow = Number(metafield?.payNow || metafield?.productDeposit || 0);
  const expectedFull = Math.max(fullPrice, payNow + Number(remaining || 0));
  if (!(expectedFull > 0)) return false;
  const looksDepositOnly =
    currentTotal + 1 < expectedFull && (captured <= 0.009 || captured + 1 < expectedFull);
  return !looksDepositOnly;
}

function afterInvoiceSendMeta(meta = {}, now = new Date()) {
  const sentAt = now.toISOString();
  const mode = String(meta.invoiceMode || "off").toLowerCase();
  if (mode === "monthly" && meta.invoiceScheduled) {
    const due = new Date(meta.invoiceDueAt || sentAt);
    const next = Number.isNaN(due.getTime()) ? new Date(now) : new Date(due.getTime());
    next.setMonth(next.getMonth() + 1);
    if (next.getTime() <= now.getTime()) {
      const fromNow = new Date(now);
      fromNow.setMonth(fromNow.getMonth() + 1);
      return { ...meta, invoiceSentAt: sentAt, invoiceDueAt: fromNow.toISOString() };
    }
    return { ...meta, invoiceSentAt: sentAt, invoiceDueAt: next.toISOString() };
  }
  return {
    ...meta,
    invoiceSentAt: sentAt,
    invoiceScheduled: false,
    invoiceMode: "off",
    invoiceDueAt: null,
  };
}

function noteMoney(amount) {
  const value = Number(amount || 0);
  return `₹${value.toLocaleString("en-IN", {
    maximumFractionDigits: 2,
    minimumFractionDigits: value % 1 === 0 ? 0 : 2,
  })}`;
}

function hasFullyPaidOrderNote(note) {
  return String(note || "").includes("Status: Fully paid.");
}

function formatFullyPaidNoteIst(date = new Date()) {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-GB", {
      timeZone: "Asia/Kolkata",
      weekday: "short",
      day: "numeric",
      month: "short",
      year: "numeric",
      hour: "2-digit",
      minute: "2-digit",
      hour12: true,
    })
      .formatToParts(date instanceof Date ? date : new Date(date))
      .filter((part) => part.type !== "literal")
      .map((part) => [part.type, part.value]),
  );
  const month = String(parts.month || "").replace(/^Sept$/i, "Sep");
  const dayPeriod = String(parts.dayPeriod || "pm")
    .replace(/\./g, "")
    .toLowerCase();
  return `${parts.weekday}, ${parts.day} ${month} ${parts.year}, ${parts.hour}:${parts.minute} ${dayPeriod} IST`;
}

function buildFullyPaidOrderNote({
  payNow = 0,
  payCod = 0,
  fullPrice = 0,
  checkoutCharged = 0,
  collectedVia = "COD collected",
  markedAt = new Date(),
} = {}) {
  const via = collectedVia === "Invoice paid" ? "Invoice paid" : "COD collected";
  return [
    "Status: Fully paid.",
    `At checkout: Pay now ${noteMoney(payNow)}. Remaining COD ${noteMoney(payCod)}. Full ${noteMoney(fullPrice)}. Charged ${noteMoney(checkoutCharged)}.`,
    `Remaining collected: ${noteMoney(payCod)}.`,
    `Collected via: ${via}`,
    `Marked fully paid: ${formatFullyPaidNoteIst(markedAt)}`,
  ].join("\n");
}

function upsertCustomAttributes(existing = [], updates = []) {
  const next = [];
  const seen = new Set();
  const updateMap = new Map();
  for (const attr of updates || []) {
    const key = attr?.key;
    if (!key || updateMap.has(key)) continue;
    updateMap.set(key, String(attr.value ?? ""));
  }
  for (const attr of existing || []) {
    const key = attr?.key;
    if (!key || seen.has(key)) continue;
    seen.add(key);
    next.push({
      key,
      value: updateMap.has(key) ? updateMap.get(key) : String(attr.value ?? ""),
    });
  }
  for (const [key, value] of updateMap) {
    if (seen.has(key)) continue;
    seen.add(key);
    next.push({ key, value });
  }
  return next;
}

function orderAttributesAlreadyFullyPaid(attributes = []) {
  const attrs = attrMap(attributes);
  const status = String(attrs.partial_payment_status || "")
    .trim()
    .toLowerCase();
  if (status === "fully_paid") return true;
  return String(attrs.Status || "")
    .trim()
    .toLowerCase() === "fully paid";
}

function buildFullyPaidCustomAttributeUpdates({ remaining = 0, markedAt = new Date() } = {}) {
  return [
    { key: "partial_payment_status", value: "fully_paid" },
    { key: "Status", value: "Fully paid" },
    { key: "Due on delivery", value: "0" },
    { key: "partial_remaining_cod", value: "0" },
    { key: "Remaining collected", value: String(Number(remaining) || 0) },
    { key: "Marked fully paid", value: formatFullyPaidNoteIst(markedAt) },
  ];
}

function statusLabel(status) {
  if (status === "fully_paid") return "Paid";
  if (status === "unpaid_cod") return "Unpaid (COD)";
  if (status === "refunded") return "Refunded";
  return "Partial paid";
}

function statusTone(status) {
  if (status === "fully_paid") return "success";
  if (status === "unpaid_cod") return "critical";
  if (status === "refunded") return "info";
  return "warning";
}

function attrMap(attributes = []) {
  return Object.fromEntries(attributes.map((attribute) => [attribute.key, attribute.value]));
}

function parseMoney(value) {
  if (value == null || value === "") return 0;
  const cleaned = String(value).replace(/[^0-9.-]/g, "");
  const parsed = Number(cleaned);
  return Number.isFinite(parsed) ? parsed : 0;
}

function paymentFromAttributes(attributes = []) {
  const map = attrMap(attributes);
  if (map._cod_surcharge === "1") return null;
  const hasFriendly = map["Pay now"] != null && map["Pay now"] !== "";
  if (!map._partial_pay_now && !map.pay_now && !map.description && map._partial_info !== "1" && !hasFriendly) {
    return null;
  }
  const statusRaw = String(map.Status || map._partial_status || "partial_paid");
  const status =
    statusRaw === "Unpaid (COD)" || statusRaw === "unpaid_cod"
      ? "unpaid_cod"
      : statusRaw === "Paid" || statusRaw === "fully_paid" || statusRaw === "Fully paid"
        ? "fully_paid"
        : statusRaw === "Refunded" || statusRaw === "refunded"
          ? "refunded"
          : "partial_paid";
  return {
    isInfo: map._partial_info === "1",
    description: map.description || map["Partial payment"] || "",
    payNow: parseMoney(map["Pay now"] || map._partial_pay_now || map.pay_now),
    payCod: parseMoney(map["Remaining COD"] || map._partial_pay_cod),
    fullPrice: parseMoney(map["Full price"] || map._partial_full),
    surcharge: parseMoney(map["COD extra"] || map._partial_surcharge),
    status,
    title: "",
  };
}

function OrderBlock() {
  const { data, query } = useApi(ORDER_DETAILS_TARGET);
  const [order, setOrder] = useState(null);
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);
  const [invoiceBusy, setInvoiceBusy] = useState(false);
  const [invoiceMessage, setInvoiceMessage] = useState("");
  const savingRef = useRef(false);
  const invoiceBusyRef = useRef(false);
  const requestIdRef = useRef(0);

  async function loadOrder({ silent = false } = {}) {
    const requestId = ++requestIdRef.current;
    const orderId = data?.selected?.[0]?.id || shopify.data?.selected?.[0]?.id;
    if (!orderId) {
      if (!silent) setError("Order not found");
      return;
    }

    let result;
    try {
      result = await fetchPartialPaymentOrder(query, orderId);
    } catch (err) {
      if (requestId !== requestIdRef.current) return;
      if (!silent) setError(err?.message || "Could not load order");
      return;
    }

    if (requestId !== requestIdRef.current) return;

    if (result.errors?.length) {
      if (!silent) setError(result.errors[0].message);
      return;
    }

    const next = result.data?.order;
    if (!next) {
      if (!silent) setError("Order not found");
      return;
    }

    setError("");
    setOrder(next);
  }

  useEffect(() => {
    let cancelled = false;
    let timeoutId = 0;

    const schedule = () => {
      timeoutId = setTimeout(runPoll, ORDER_BLOCK_POLL_MS);
    };

    async function runPoll() {
      if (cancelled) return;
      if (!savingRef.current && !invoiceBusyRef.current && !extensionIsHidden()) {
        await loadOrder({ silent: true });
      }
      if (!cancelled) schedule();
    }

    loadOrder();
    schedule();

    function onVisibility() {
      if (cancelled) return;
      if (extensionIsHidden() || savingRef.current || invoiceBusyRef.current) return;
      loadOrder({ silent: true });
    }

    try {
      document.addEventListener("visibilitychange", onVisibility);
    } catch {
      // Admin sandbox may not expose visibility events; polling continues.
    }

    return () => {
      cancelled = true;
      clearTimeout(timeoutId);
      try {
        document.removeEventListener("visibilitychange", onVisibility);
      } catch {
        // ignore
      }
    };
  }, []);

  const metafield = (() => {
    try {
      return JSON.parse(order?.metafield?.value || "{}");
    } catch {
      return {};
    }
  })();

  const orderAttrs = attrMap(order?.customAttributes || []);
  const parsed = (order?.lineItems?.nodes || [])
    .map((item) => {
      const payment = paymentFromAttributes(item.customAttributes);
      const charged = Number(
        item.discountedUnitPriceSet?.shopMoney?.amount ||
          item.originalUnitPriceSet?.shopMoney?.amount ||
          0,
      );
      const variantPrice = Number(item.variant?.price || 0);
      const fallbackFull = parseMoney(orderAttrs["Full price"]) || variantPrice;
      const fallbackPayNow =
        parseMoney(orderAttrs["Pay now"] || orderAttrs.partial_deposit) || charged;
      const fallbackCod =
        parseMoney(orderAttrs["Due on delivery"] || orderAttrs["Remaining COD"]) ||
        Math.max(0, fallbackFull - fallbackPayNow);
      const merged = payment || {
        isInfo: false,
        payNow: fallbackPayNow,
        payCod: fallbackCod,
        fullPrice: fallbackFull,
        surcharge: 0,
        status: orderAttrs.partial_payment_status || "partial_paid",
      };
      if (!payment && fallbackFull) {
        merged.payNow = fallbackPayNow;
        merged.payCod = fallbackCod;
        merged.fullPrice = fallbackFull;
      }
      return {
        ...merged,
        title: item.title,
        image: item.image?.url,
        catalogPrice: Number(merged.fullPrice || variantPrice || charged),
        shopifyCharged: charged,
        isSurcharge: attrMap(item.customAttributes || [])._cod_surcharge === "1",
        isAdminPartialLine: String(item.title || "")
          .toLowerCase()
          .startsWith("partial payment"),
      };
    })
    .filter((line) => !line.isSurcharge && !line.isInfo && !line.isAdminPartialLine);

  const amountLines = parsed.filter((line) => line.payNow || line.payCod || line.fullPrice);

  const financial = String(order?.displayFinancialStatus || "").toUpperCase();
  const remainingCod =
    Number(metafield.payCod) > 0
      ? Number(metafield.payCod)
      : amountLines.reduce((sum, line) => sum + Number(line.payCod || 0), 0);
  const invoicePaid = isInvoiceFullyCollected(order, metafield, remainingCod);
  const status = order?.tags?.includes("refunded") || metafield.status === "refunded" || financial === "REFUNDED"
    ? "refunded"
    : order?.tags?.includes("fully_paid") || metafield.status === "fully_paid" || invoicePaid
      ? "fully_paid"
      : order?.tags?.includes("unpaid_cod") || metafield.status === "unpaid_cod"
        ? "unpaid_cod"
        : metafield.status ||
          amountLines[0]?.status ||
          (financial === "PARTIALLY_PAID" ? "partial_paid" : "partial_paid");

  async function saveStatus(nextStatus, options = {}) {
    if (!order?.id) return;
    savingRef.current = true;
    setSaving(true);
    try {
    const remainingCollected =
      Number(metafield.payCod) > 0
        ? Number(metafield.payCod)
        : amountLines.reduce((sum, line) => sum + Number(line.payCod || 0), 0);
    const payNow = Number(
      metafield.payNow ??
        metafield.productDeposit ??
        amountLines.reduce((sum, line) => sum + Number(line.payNow || 0), 0),
    );
    const fullPrice = Number(
      metafield.fullPrice ??
        amountLines.reduce((sum, line) => sum + Number(line.fullPrice || 0), 0),
    );
    const checkoutCharged = Number(
      metafield.checkoutCharged ?? metafield.productDeposit ?? metafield.payNow ?? payNow,
    );
    const due = nextStatus === "fully_paid" || nextStatus === "refunded" ? 0 : remainingCollected;
    const add =
      nextStatus === "fully_paid"
        ? ["fully_paid"]
        : nextStatus === "unpaid_cod"
          ? ["unpaid_cod"]
          : nextStatus === "refunded"
            ? ["refunded"]
            : ["partial_paid"];
    const remove = ["partial_paid", "unpaid_cod", "fully_paid", "refunded"].filter((tag) => !add.includes(tag));
    const isFullyPaid = nextStatus === "fully_paid";
    const alreadyNoted = hasFullyPaidOrderNote(order.note) || Boolean(metafield.fullyPaidNoteAt);
    const attrsAlreadyFullyPaid = orderAttributesAlreadyFullyPaid(order.customAttributes || []);
    const fullyPaidNoteAt = metafield.fullyPaidNoteAt || new Date().toISOString();
    const collectedVia = options.collectedVia === "Invoice paid" ? "Invoice paid" : "COD collected";

    const orderInput = { id: order.id };
    if (isFullyPaid) {
      if (!alreadyNoted) {
        orderInput.note = buildFullyPaidOrderNote({
          payNow,
          payCod: remainingCollected,
          fullPrice,
          checkoutCharged,
          collectedVia,
          markedAt: fullyPaidNoteAt,
        });
      }
      if (!attrsAlreadyFullyPaid) {
        orderInput.customAttributes = upsertCustomAttributes(
          order.customAttributes || [],
          buildFullyPaidCustomAttributeUpdates({
            remaining: remainingCollected,
            markedAt: fullyPaidNoteAt,
          }),
        );
      }
    } else {
      orderInput.note = [order.note, `Partial payment status set to ${statusLabel(nextStatus)}.`]
        .filter(Boolean)
        .join("\n");
      orderInput.customAttributes = upsertCustomAttributes(order.customAttributes || [], [
        { key: "partial_payment_status", value: nextStatus },
        { key: "Status", value: statusLabel(nextStatus) },
        { key: "Due on delivery", value: String(due) },
      ]);
    }

    const skipOrderUpdate = isFullyPaid && alreadyNoted && attrsAlreadyFullyPaid;
    await shopify.query(
      skipOrderUpdate
        ? `#graphql
        mutation UpdatePartialPaymentStatus($id: ID!, $add: [String!]!, $remove: [String!]!, $metafields: [MetafieldsSetInput!]!) {
          tagsRemove(id: $id, tags: $remove) {
            userErrors { message }
          }
          tagsAdd(id: $id, tags: $add) {
            userErrors { message }
          }
          metafieldsSet(metafields: $metafields) {
            userErrors { field message }
          }
        }
      `
        : `#graphql
        mutation UpdatePartialPaymentStatus($id: ID!, $add: [String!]!, $remove: [String!]!, $metafields: [MetafieldsSetInput!]!, $order: OrderInput!) {
          tagsRemove(id: $id, tags: $remove) {
            userErrors { message }
          }
          tagsAdd(id: $id, tags: $add) {
            userErrors { message }
          }
          metafieldsSet(metafields: $metafields) {
            userErrors { field message }
          }
          orderUpdate(input: $order) {
            userErrors { field message }
          }
        }
      `,
      {
        variables: {
          id: order.id,
          add,
          remove,
          metafields: [
            {
              ownerId: order.id,
              namespace: "$app",
              key: "partial_payment",
              type: "json",
              value: JSON.stringify({
                ...metafield,
                status: nextStatus,
                payCod: due,
                ...(isFullyPaid
                  ? { fullyPaidNoteAt, collectedVia }
                  : {}),
              }),
            },
          ],
          ...(skipOrderUpdate ? {} : { order: orderInput }),
        },
      },
    );
    await loadOrder();
    } finally {
      savingRef.current = false;
      setSaving(false);
    }
  }

  async function sendInvoice() {
    if (!order?.id) return;
    invoiceBusyRef.current = true;
    setInvoiceBusy(true);
    setInvoiceMessage("");
    try {
      const result = await shopify.query(
        `#graphql
          mutation SendRemainingInvoice($id: ID!) {
            orderInvoiceSend(id: $id) {
              userErrors { field message }
            }
          }
        `,
        { variables: { id: order.id } },
      );
      const errors = result.errors || result.data?.orderInvoiceSend?.userErrors || [];
      if (errors.length) {
        setInvoiceMessage(
          errors[0].message ||
            "Could not send invoice. Email a Shopify invoice from Admin → Order → Send invoice.",
        );
      } else {
        setInvoiceMessage("Shopify invoice emailed to the customer (if the order allows invoices).");
        try {
          await shopify.query(
            `#graphql
              mutation RememberOrderInvoiceSent($metafields: [MetafieldsSetInput!]!) {
                metafieldsSet(metafields: $metafields) {
                  userErrors { field message }
                }
              }
            `,
            {
              variables: {
                metafields: [
                  {
                    ownerId: order.id,
                    namespace: "$app",
                    key: "partial_payment",
                    type: "json",
                    value: JSON.stringify(afterInvoiceSendMeta(metafield)),
                  },
                ],
              },
            },
          );
        } catch {
          // Invoice email already sent; dashboard will show sent on next refresh if metafield lags.
        }
      }
    } finally {
      invoiceBusyRef.current = false;
      setInvoiceBusy(false);
    }
  }

  if (error) {
    return (
      <s-admin-block heading="Partial payment">
        <s-banner tone="critical">{error}</s-banner>
      </s-admin-block>
    );
  }

  if (!amountLines.length && !metafield.payCod && !metafield.payNow) {
    return (
      <s-admin-block heading="Partial payment">
        <s-text>This order has no partial payment details.</s-text>
      </s-admin-block>
    );
  }

  const lineDue = amountLines.reduce((sum, line) => sum + Number(line.payCod || 0), 0);
  const lineFull = amountLines.reduce((sum, line) => sum + Number(line.fullPrice || 0), 0);
  const charged =
    metafield.productDeposit ??
    metafield.payNow ??
    amountLines.reduce((sum, line) => sum + line.payNow, 0);
  const full =
    metafield.fullPrice ??
    (lineFull > 0 ? lineFull : amountLines.reduce((sum, line) => sum + line.fullPrice, 0));
  const metaDue = metafield.payCod;
  const due =
    metaDue != null && Number(metaDue) > 0
      ? Number(metaDue)
      : lineDue > 0
        ? lineDue
        : Math.max(0, Number(full) - Number(charged));

  const remaining = status === "fully_paid" || status === "refunded" ? 0 : due;

  return (
    <s-admin-block heading="Partial payment">
      <s-stack gap="base">
        <s-badge tone={statusTone(status)}>{statusLabel(status)}</s-badge>
        <s-text color="subdued">
          Shopify Paid / Authorized cannot be renamed. Use this badge and tag `partial_paid`.
        </s-text>
        <s-box padding="small" borderWidth="base" borderRadius="base">
          <s-stack gap="none">
            <s-text>Payment summary</s-text>
            <s-text>Order Total: {money(full)}</s-text>
            <s-text>Paid Online: {money(charged)}</s-text>
            <s-text>Remaining COD: {money(remaining)}</s-text>
            <s-text>Payment Status: {statusLabel(status)}</s-text>
          </s-stack>
        </s-box>
        {remaining > 0 ? (
          <s-text color="subdued">
            Remaining {money(remaining)} can be collected on delivery, or you can email a native
            Shopify order invoice from Admin so the customer pays the rest online. After they pay,
            record it here.
          </s-text>
        ) : null}
        <s-select
          label="Change status"
          name="partial_status"
          value={status}
          disabled={saving}
          onChange={(event) => saveStatus(event.currentTarget.value)}
        >
          <s-option value="partial_paid">Partial paid</s-option>
          <s-option value="fully_paid">Paid</s-option>
          <s-option value="unpaid_cod">Unpaid COD</s-option>
        </s-select>
        {remaining > 0 ? (
          <s-stack direction="inline" gap="base">
            <s-button
              variant="primary"
              disabled={saving}
              onClick={() => saveStatus("fully_paid", { collectedVia: "COD collected" })}
            >
              Mark COD collected
            </s-button>
            <s-button
              disabled={saving}
              onClick={() => saveStatus("fully_paid", { collectedVia: "Invoice paid" })}
            >
              Record remaining paid online
            </s-button>
            <s-button disabled={invoiceBusy} onClick={sendInvoice}>
              Email Shopify invoice
            </s-button>
          </s-stack>
        ) : null}
        {invoiceMessage ? <s-text color="subdued">{invoiceMessage}</s-text> : null}
        <s-text color="subdued">
          After the order is created, the product line is restored to catalog price in Admin.
          Paid Online was {money(charged)}. Remaining COD is the unpaid balance. Shopify cannot
          recapture on the same checkout.
        </s-text>
        {amountLines.map((product, index) => (
          <s-stack gap="base" key={`${product.title}-${index}`}>
            <s-box padding="small" borderWidth="base" borderRadius="base">
              <s-stack direction="inline" gap="base">
                {product.image ? <s-thumbnail src={product.image} alt={product.title} size="small" /> : null}
                <s-stack gap="none">
                  <s-text>{product.title}</s-text>
                  <s-text>Order Total {money(product.fullPrice || product.catalogPrice)}</s-text>
                  <s-text color="subdued">Paid Online {money(product.shopifyCharged || product.payNow)}</s-text>
                </s-stack>
              </s-stack>
            </s-box>
            <s-box padding="small" borderWidth="base" borderRadius="base">
              <s-stack direction="inline" gap="base">
                {product.image ? (
                  <s-thumbnail src={product.image} alt={`${product.title} partial payment`} size="small" />
                ) : null}
                <s-stack gap="none">
                  <s-text>Partial payment</s-text>
                  <s-text>Paid Online {money(product.payNow)}</s-text>
                  <s-text>Remaining COD {money(product.payCod)}</s-text>
                  <s-text>Payment Status {statusLabel(product.status)}</s-text>
                </s-stack>
              </s-stack>
            </s-box>
          </s-stack>
        ))}
      </s-stack>
    </s-admin-block>
  );
}
