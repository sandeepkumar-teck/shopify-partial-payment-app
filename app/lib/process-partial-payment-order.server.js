import {
  restoreCatalogPriceOnAdminOrder,
  isPartialPaymentCustomTitle,
  parsePartialPaymentMeta,
  orderHasDuplicateCatalogLines,
  catalogRestoreStillNeeded,
  restoreLockIsActive,
} from "./order-edit-partial-payment.server";
import {
  TAGS,
  SETTINGS_METAFIELD,
  ATTR,
  VISIBLE,
  paymentFromProperties,
  propertiesFromPayment,
  summarizeOrderPayments,
  overallStatus,
  parseMoney,
  roundMoney,
  parseSettings,
  hasFullyPaidOrderNote,
  buildFullyPaidOrderNote,
  upsertCustomAttributes,
  orderAttributesAlreadyFullyPaid,
  buildFullyPaidCustomAttributeUpdates,
  COLLECTED_VIA,
} from "./partial-payment";
import { syncOrderSnapshotFromAdmin } from "./reporting-snapshot.server";

const RESTORE_ATTEMPTS = 2;
const RESTORE_RETRY_MS = 1500;
const CREATE_LOCK_RETRY_MS = 2000;

const ORDER_RESTORE_FIELDS = `
  id
  name
  note
  tags
  customAttributes { key value }
  metafield(namespace: "$app", key: "partial_payment") { value }
  lineItems(first: 250) {
    nodes {
      title
      name
      quantity
      variant { id price }
      lineItemGroup { id title variantId quantity customAttributes { key value } }
      customAttributes { key value }
      originalUnitPriceSet { shopMoney { amount } }
      discountedUnitPriceSet { shopMoney { amount } }
    }
  }
`;

const ORDER_RESTORE_FIELDS_NO_GROUP = `
  id
  name
  note
  tags
  customAttributes { key value }
  metafield(namespace: "$app", key: "partial_payment") { value }
  lineItems(first: 250) {
    nodes {
      title
      name
      quantity
      variant { id price }
      customAttributes { key value }
      originalUnitPriceSet { shopMoney { amount } }
      discountedUnitPriceSet { shopMoney { amount } }
    }
  }
`;

function gidFromRestId(id) {
  if (String(id).startsWith("gid://")) return String(id);
  return `gid://shopify/Order/${id}`;
}

async function graphqlJson(admin, query, variables) {
  try {
    const response = await admin.graphql(query, variables ? { variables } : undefined);
    return await response.json();
  } catch (error) {
    if (error?.body && typeof error.body === "object") {
      console.warn("[partial-payment] GraphqlQueryError", error.message);
      return error.body;
    }
    throw error;
  }
}

function mutationErrors(json, mutationName) {
  const payload = json?.data?.[mutationName];
  return [
    ...(json?.errors || []),
    ...(payload?.userErrors || []),
  ]
    .map((error) => error.message || JSON.stringify(error))
    .filter(Boolean);
}

function payloadLineItems(payload) {
  return payload?.line_items || payload?.lineItems || [];
}

function payloadNoteAttributes(payload) {
  return payload?.note_attributes || payload?.customAttributes || payload?.attributes || [];
}

function attributeMap(list = []) {
  return Object.fromEntries(
    (list || []).map((attr) => [attr.name || attr.key, attr.value]),
  );
}

function firstPositive(...values) {
  for (const value of values) {
    const amount = parseMoney(value);
    if (amount > 0) return amount;
  }
  return 0;
}

const PARTIAL_MARKER_KEYS = new Set([
  VISIBLE.payNow,
  VISIBLE.payCod,
  VISIBLE.full,
  VISIBLE.status,
  ATTR.payNow,
  ATTR.payCod,
  ATTR.full,
  ATTR.status,
  ATTR.unit,
  ATTR.depositUnit,
  "partial_deposit",
  "partial_remaining_cod",
  "partial_full_price",
  "partial_payment_status",
  "pay_now",
]);

function hasPartialPaymentMarkers(payload) {
  const lineItems = payloadLineItems(payload);
  for (const item of lineItems) {
    for (const prop of item.properties || item.customAttributes || []) {
      const key = String(prop.key || prop.name || "");
      if (PARTIAL_MARKER_KEYS.has(key) || key.startsWith("_partial_")) return true;
    }
  }
  const attrs = attributeMap(payloadNoteAttributes(payload));
  return Object.keys(attrs).some(
    (key) => PARTIAL_MARKER_KEYS.has(key) || String(key).startsWith("_partial_"),
  );
}

function payloadTags(payload) {
  const raw = payload.tags;
  if (Array.isArray(raw)) return raw.map((tag) => String(tag).trim()).filter(Boolean);
  return String(raw || "")
    .split(/\s*,\s*/)
    .map((tag) => tag.trim())
    .filter(Boolean);
}

function isShopifyCodGateway(payload) {
  const names = [payload.gateway, payload.processing_method, ...(payload.payment_gateway_names || [])]
    .filter(Boolean)
    .map((value) => String(value).toLowerCase());
  return names.some(
    (name) =>
      name.includes("cash on delivery") ||
      name.includes("cash_on_delivery") ||
      name.includes("cash-on-delivery") ||
      name === "cod" ||
      /\bcod\b/.test(name),
  );
}

function payloadLooksUnpaidCod(payload, lineSummary = null) {
  const payNowFromSummary = Number(lineSummary?.payNow || 0);
  if (payNowFromSummary > 0) return false;
  const attrs = attributeMap(payloadNoteAttributes(payload));
  const statusText = String(attrs.partial_payment_status || attrs.Status || "").toLowerCase();
  if (statusText.includes("unpaid")) return true;
  const lineItems = payloadLineItems(payload);
  for (const item of lineItems) {
    const payment = paymentFromProperties(item.properties || item.customAttributes || []);
    if (!payment || payment.isInfo) continue;
    if (Number(payment.payNow) > 0) return false;
    const status = String(payment.status || "").toLowerCase();
    if (status === "unpaid_cod" || status.includes("unpaid")) return true;
  }
  const payNow = Number(lineSummary?.payNow || 0);
  const payCod = Number(lineSummary?.payCod || 0);
  return payNow <= 0 && payCod > 0 && hasPartialPaymentMarkers(payload);
}

function statusForPartialOrder(summary, payload) {
  const payNow = Number(summary.payNow) || 0;
  const payCod = Number(summary.payCod) || 0;
  const surcharge = Number(summary.surcharge) || 0;

  if (payloadLooksUnpaidCod(payload, summary) && payNow <= 0) {
    return "unpaid_cod";
  }
  if (payNow <= 0 && payCod > 0 && hasPartialPaymentMarkers(payload)) {
    return "unpaid_cod";
  }
  if (payNow <= 0 && surcharge > 0 && hasPartialPaymentMarkers(payload)) {
    return "unpaid_cod";
  }
  if (payNow > 0 && payCod > 0) return "partial_paid";
  if (payNow > 0 && payCod <= 0) {
    const remaining = roundMoney(Math.max(0, Number(summary.fullPrice || 0) - payNow));
    if (remaining > 0.009) return "partial_paid";
    return "fully_paid";
  }
  return overallStatus(summary);
}

function extraAlreadyInTotals(summary) {
  const extra = Number(summary?.surcharge || 0);
  const full = Number(summary?.fullPrice || 0);
  const due = Number(summary?.payCod || 0);
  const payNow = Number(summary?.payNow || 0);
  if (!(extra > 0) || !(full > 0)) return false;
  // Extra is baked into Full price only when Full covers pay-now + remaining (catalog+extra).
  if (Math.abs(payNow + due - full) <= 0.009 && full > due + 0.009) return true;
  if (payNow <= 0 && full + 0.009 >= roundMoney(due + extra)) return true;
  return false;
}

function isOrdersPaidTopic(topic) {
  return (
    String(topic || "")
      .toUpperCase()
      .replace(/\//g, "_") === "ORDERS_PAID"
  );
}

function isLaterOrderTopic(topic) {
  return isOrdersUpdatedTopic(topic) || isOrdersPaidTopic(topic);
}

function shouldAutoMarkFullyPaid(summary, payload, options = {}) {
  if (!isLaterOrderTopic(options.topic)) return false;
  const tags = payloadTags(payload);
  if (tags.includes(TAGS.fullyPaid)) return false;

  const financial = String(payload.financial_status || "").toLowerCase();
  // COD at delivery stays pending/authorized. Only Shopify "paid" (card/capture/invoice) auto-closes.
  if (financial !== "paid") return false;

  const payNow = Number(summary.payNow) || 0;
  const payCod = Number(summary.payCod) || 0;
  const totalPaid = parseMoney(payload.current_total_price ?? payload.total_price);
  const expectedFull = extraAlreadyInTotals(summary)
    ? roundMoney(Number(summary.fullPrice || 0))
    : roundMoney(Number(summary.fullPrice || 0) + Number(summary.surcharge || 0));
  const expectedCollected = roundMoney(payNow + payCod);
  const outstandingRaw = payload.total_outstanding;
  const outstandingKnown = outstandingRaw != null && outstandingRaw !== "";
  const outstanding = parseMoney(outstandingRaw);
  const captured = parseMoney(payload.total_received ?? payload.net_payments);

  // Remaining COD is still due until Shopify has no outstanding AND captured the catalog total.
  // Deposit-only checkout is also financial=paid, but current total is only the deposit.
  if (payCod > 0.009) {
    if (outstandingKnown && outstanding > 0.009) return false;
    const catalogFull = expectedFull > 0 ? expectedFull : expectedCollected;
    if (!(catalogFull > 0)) return false;
    if (captured > 0.009) return captured + 1 >= catalogFull;
    return totalPaid + 1 >= catalogFull;
  }

  if (payCod <= 0 || payNow <= 0) return false;

  if (expectedFull > 0 && totalPaid + 1 >= expectedFull) return true;
  if (expectedCollected > 0 && totalPaid + 1 >= expectedCollected) return true;
  return false;
}

function resolvePartialOrderStatus(summary, payload, options = {}) {
  const tags = payloadTags(payload);
  if (tags.includes(TAGS.fullyPaid)) {
    return { status: "fully_paid", summary: { ...summary, payCod: 0 } };
  }
  if (shouldAutoMarkFullyPaid(summary, payload, options)) {
    return { status: "fully_paid", summary: { ...summary, payCod: 0 } };
  }
  return { status: statusForPartialOrder(summary, payload), summary };
}

function parseLinePayments(lineItems = []) {
  return lineItems
    .map((item) => paymentFromProperties(item.properties || item.customAttributes || []))
    .filter(Boolean)
    .filter((payment) => !payment.isInfo)
    .filter((payment) => payment.payNow > 0 || payment.payCod > 0 || payment.fullPrice > 0);
}

function isSurchargePayloadItem(item) {
  const props = item?.properties || item?.customAttributes || [];
  const map = Object.fromEntries(props.map((prop) => [prop.key || prop.name, prop.value]));
  return map._cod_surcharge === "1" || map[ATTR.surcharge] === "1";
}

function surchargeFromProductLines(lineItems = []) {
  let total = 0;
  for (const item of lineItems) {
    if (!isSurchargePayloadItem(item)) continue;
    const qty = Number(item.quantity) || 1;
    const unit = parseMoney(
      item.price ??
        item.discounted ??
        item.original ??
        item.discountedUnitPriceSet?.shopMoney?.amount ??
        item.originalUnitPriceSet?.shopMoney?.amount,
    );
    if (unit > 0) total = roundMoney(total + unit * qty);
  }
  return total;
}

function resolveOrderPaymentSummary(payload) {
  const lineItems = payloadLineItems(payload);
  const attrs = attributeMap(payloadNoteAttributes(payload));
  const lineSummary = summarizeOrderPayments(parseLinePayments(lineItems));
  const productLineSurcharge = surchargeFromProductLines(lineItems);
  const unpaidCod = payloadLooksUnpaidCod(payload, lineSummary);

  let catalogFromLines = 0;
  let chargedFromLines = 0;
  for (const item of lineItems) {
    if (isPartialPaymentCustomTitle(item.title) || isSurchargePayloadItem(item)) continue;
    const qty = Number(item.quantity) || 1;
    if (qty <= 0) continue;
    const variantPrice = parseMoney(item.variant_price || item.variantPrice || item.variant?.price);
    const charged = parseMoney(
      item.discounted ||
        item.original ||
        item.price ||
        item.price_set?.shop_money?.amount ||
        item.pre_tax_price ||
        item.discountedUnitPriceSet?.shopMoney?.amount ||
        item.originalUnitPriceSet?.shopMoney?.amount,
    );
    if (variantPrice > 0) catalogFromLines = roundMoney(catalogFromLines + variantPrice * qty);
    if (charged > 0) chargedFromLines = roundMoney(chargedFromLines + charged * qty);
  }

  let payNow = unpaidCod
    ? firstPositive(attrs.partial_deposit, lineSummary.payNow)
    : firstPositive(attrs.partial_deposit, lineSummary.payNow, chargedFromLines);
  let fullPrice = firstPositive(
    attrs.partial_full_price,
    lineSummary.fullPrice,
    catalogFromLines,
  );
  if (catalogFromLines > fullPrice + 0.009) fullPrice = catalogFromLines;
  if (unpaidCod && lineSummary.fullPrice > 0) {
    fullPrice = lineSummary.fullPrice;
    if (catalogFromLines > fullPrice + 0.009) fullPrice = catalogFromLines;
  }
  let payCod = firstPositive(
    attrs.partial_remaining_cod,
    attrs["Remaining COD"],
    attrs["Due on delivery"],
    lineSummary.payCod,
  );
  const surcharge = firstPositive(lineSummary.surcharge, productLineSurcharge);
  if (payCod <= 0 && fullPrice > payNow) {
    payCod = roundMoney(fullPrice - payNow);
  }
  if (unpaidCod) {
    payNow = 0;
    const extraFromProps = roundMoney(lineSummary.surcharge);
    const remaining = firstPositive(
      attrs.partial_remaining_cod,
      attrs["Remaining COD"],
      attrs["Due on delivery"],
      lineSummary.payCod,
    );
    if (extraFromProps > 0) {
      fullPrice = firstPositive(lineSummary.fullPrice, remaining, catalogFromLines, fullPrice);
      payCod = firstPositive(remaining, lineSummary.fullPrice, fullPrice);
    } else {
      const catalog = firstPositive(catalogFromLines, lineSummary.fullPrice, fullPrice);
      if (catalog > 0) fullPrice = catalog;
      payCod = roundMoney(fullPrice + surcharge);
    }
  } else if (surcharge > 0 && payNow > 0) {
    const fromLines = Number(lineSummary.fullPrice || 0);
    const looksInflated =
      fromLines > 0 &&
      (Math.abs(fromLines - (payNow + payCod)) <= 0.05 || Math.abs(fromLines - (payCod + surcharge)) <= 0.05);
    const catalog = firstPositive(
      catalogFromLines,
      payCod,
      looksInflated ? roundMoney(fromLines - surcharge) : fromLines,
    );
    if (catalog > 0) fullPrice = catalog;
  }

  return {
    payNow,
    payCod,
    fullPrice,
    surcharge,
  };
}

function paymentNoteBlock(statusLabel, checkoutCharged, summary) {
  return [
    `Status: ${statusLabel}.`,
    `Checkout charged ${checkoutCharged}.`,
    `Pay now ${summary.payNow}. Remaining COD ${summary.payCod}. Full ${summary.fullPrice}.`,
  ].join("\n");
}

function stripPaymentNoteLines(note) {
  return String(note || "")
    .split(/\r?\n/)
    .filter((line) => {
      const text = line.trim();
      if (!text) return false;
      if (/^Status:\s*(Partial paid|Paid|Unpaid \(COD\)|Fully paid)\./i.test(text)) return false;
      if (/^Checkout charged /i.test(text)) return false;
      if (/^At checkout:/i.test(text)) return false;
      if (/^Remaining collected:/i.test(text)) return false;
      if (/^Collected via:/i.test(text)) return false;
      if (/^Marked fully paid:/i.test(text)) return false;
      if (/^Pay now /i.test(text) && /Remaining COD/i.test(text)) return false;
      return true;
    })
    .join("\n")
    .trim();
}

function replacePaymentNote(existingNote, block) {
  const kept = stripPaymentNoteLines(existingNote);
  return [kept, block].filter(Boolean).join("\n");
}

function attributesUnchanged(existing, next) {
  if (existing.length !== next.length) return false;
  const current = Object.fromEntries(existing.map((attr) => [attr.key, attr.value]));
  return next.every((attr) => current[attr.key] === attr.value);
}

function tagsForStatus(status) {
  return status === "fully_paid"
    ? [TAGS.fullyPaid]
    : [status === "unpaid_cod" ? TAGS.unpaidCod : TAGS.partialPaid];
}

function pulsePayTagsOnPayload(payload) {
  const tags = payloadTags(payload);
  return (
    tags.includes(TAGS.fullyPaid) ||
    tags.includes(TAGS.unpaidCod) ||
    tags.includes(TAGS.partialPaid)
  );
}

function checkoutChargedFor(status, summary) {
  const extraInTotals = extraAlreadyInTotals(summary);
  if (status === "unpaid_cod") return 0;
  if (status === "fully_paid" && !(Number(summary.payNow) > 0)) {
    return roundMoney(Number(summary.fullPrice || 0) + (extraInTotals ? 0 : Number(summary.surcharge || 0)));
  }
  return roundMoney(summary.payNow > 0 ? summary.payNow : summary.surcharge);
}

function buildClassification(payload, options = {}) {
  const lineItems = payloadLineItems(payload);
  const lines = parseLinePayments(lineItems);
  let summary = resolveOrderPaymentSummary(payload);

  if (!lines.length && summary.payNow <= 0 && summary.payCod <= 0 && summary.fullPrice <= 0) {
    if (!hasPartialPaymentMarkers(payload)) {
      const keys = lineItems.flatMap((item) =>
        (item.properties || item.customAttributes || []).map((prop) => prop.key || prop.name),
      );
      console.warn("Partial payment webhook: no payment properties on line items", {
        orderId: payload.id,
        lineCount: lineItems.length,
        propertyKeys: keys,
        financialStatus: payload.financial_status || null,
      });
      return { skipped: true, reason: "no_partial_lines", lines, summary };
    }
  }

  const resolved = resolvePartialOrderStatus(summary, payload, options);
  summary = resolved.summary;
  const status = resolved.status;
  const checkoutCharged = checkoutChargedFor(status, summary);
  return {
    skipped: false,
    lines,
    summary,
    status,
    checkoutCharged,
    tags: tagsForStatus(status),
  };
}

async function writePartialPaymentTags(admin, orderId, tags) {
  const json = await graphqlJson(
    admin,
    `#graphql
      mutation TagPartialPaymentOrder($id: ID!, $add: [String!]!, $remove: [String!]!) {
        tagsRemove(id: $id, tags: $remove) {
          userErrors { message }
        }
        tagsAdd(id: $id, tags: $add) {
          userErrors { message }
        }
      }
    `,
    {
      id: orderId,
      add: tags,
      remove: [TAGS.partialPaid, TAGS.unpaidCod, TAGS.fullyPaid, TAGS.refunded].filter(
        (tag) => !tags.includes(tag),
      ),
    },
  );
  const addErrors = mutationErrors(json, "tagsAdd");
  const topErrors = (json?.errors || [])
    .map((error) => error.message || JSON.stringify(error))
    .filter(Boolean);
  if (addErrors.length || topErrors.length) {
    console.warn("[partial-payment] tag write errors", {
      orderId,
      tags,
      errors: [...topErrors, ...addErrors],
      removeErrors: mutationErrors(json, "tagsRemove"),
    });
    return false;
  }
  return true;
}

async function writePartialPaymentClassification(admin, payload, classification, options = {}) {
  const orderId = gidFromRestId(payload.id || options.orderId);
  const { summary, status, checkoutCharged, lines, tags } = classification;
  const existingMeta = options.existingMeta || {};

  if (options.preserveFullyPaidNote) {
    const existingTags = payloadTags(payload);
    if (!existingTags.includes(TAGS.fullyPaid)) {
      await writePartialPaymentTags(admin, orderId, [TAGS.fullyPaid]);
    }
    return { wroteNotes: false };
  }

  if (!options.skipTags) {
    const existingTags = payloadTags(payload);
    const alreadyTagged = tags.every((tag) => existingTags.includes(tag));
    if (!alreadyTagged) {
      await writePartialPaymentTags(admin, orderId, tags);
    }
  }

  await graphqlJson(
    admin,
    `#graphql
      mutation SetOrderPartialPayment($metafields: [MetafieldsSetInput!]!) {
        metafieldsSet(metafields: $metafields) {
          userErrors { field message }
        }
      }
    `,
    {
      metafields: [
        {
          ownerId: orderId,
          namespace: SETTINGS_METAFIELD.namespace,
          key: SETTINGS_METAFIELD.key,
          type: "json",
          value: JSON.stringify({
            ...existingMeta,
            ...summary,
            payNow: summary.payNow,
            checkoutCharged,
            productDeposit: summary.payNow,
            status,
            lines,
            orderId,
            orderEdited: Boolean(existingMeta.orderEdited),
            restoreAttempted: existingMeta.restoreAttempted === true,
            restoreLockAt: existingMeta.restoreLockAt || null,
          }),
        },
      ],
    },
  );

  const statusLabel =
    status === "unpaid_cod" ? "Unpaid (COD)" : status === "fully_paid" ? "Paid" : "Partial paid";
  const block = paymentNoteBlock(statusLabel, checkoutCharged, summary);
  const note = replacePaymentNote(payload.note, block);

  const existingAttrs = upsertCustomAttributes(payloadNoteAttributes(payload));
  const nextAttrs = upsertCustomAttributes(existingAttrs, [
    { key: "partial_payment_status", value: status },
    { key: "Status", value: statusLabel },
    { key: "Pay now", value: String(summary.payNow) },
    { key: "Due on delivery", value: String(summary.payCod) },
    { key: "Full price", value: String(summary.fullPrice) },
    { key: "Checkout charged", value: String(checkoutCharged) },
  ]);

  if (String(payload.note || "").trim() === note && attributesUnchanged(existingAttrs, nextAttrs)) {
    return { wroteNotes: false };
  }

  await graphqlJson(
    admin,
    `#graphql
      mutation AppendPartialPaymentNote($input: OrderInput!) {
        orderUpdate(input: $input) {
          userErrors { field message }
        }
      }
    `,
    {
      input: {
        id: orderId,
        note,
        customAttributes: nextAttrs,
      },
    },
  );

  return { wroteNotes: true };
}

async function processPartialPaymentOrder(admin, payload, options = {}) {
  const classification = buildClassification(payload, options);
  if (classification.skipped) {
    return classification;
  }

  const { summary, status, lines } = classification;
  if (status === "partial_paid" && isShopifyCodGateway(payload)) {
    console.warn("PulsePay: Shopify COD used on a partial-payment cart; remaining/full price may be lost. Hide COD at checkout for Partial payment.", {
      orderId: payload.id,
      gateway: payload.gateway,
      payment_gateway_names: payload.payment_gateway_names,
      payNow: summary.payNow,
      payCod: summary.payCod,
      fullPrice: summary.fullPrice,
      totalPrice: payload.total_price,
    });
  }

  const orderId = gidFromRestId(payload.id || options.orderId);
  const preserveFullyPaidNote =
    options.preserveFullyPaidNote ||
    hasFullyPaidOrderNote(payload.note) ||
    orderAttributesAlreadyFullyPaid(payloadNoteAttributes(payload)) ||
    (isLaterOrderTopic(options.topic) && payloadTags(payload).includes(TAGS.fullyPaid));

  if (!options.skipClassify) {
    await writePartialPaymentClassification(admin, payload, classification, {
      preserveFullyPaidNote,
      existingMeta: options.existingMeta || {},
      skipTags: Boolean(options.skipTags),
      orderId,
    });
  }

  if (options.skipRestore) {
    return { skipped: false, orderEdited: false, status, classified: true };
  }

  let orderEdited = false;
  let editResult = null;
  try {
    editResult = await restoreCatalogPriceOnAdminOrder(admin, {
      orderId,
      currencyCode: payload.currency,
      currencySymbol: "₹",
      restLineItems: [...payloadLineItems(payload), ...(options.webhookLineItems || [])],
      topic: options.topic,
      retrying: Boolean(options.retrying),
      seedMeta: {
        ...(options.existingMeta || {}),
        ...summary,
        status,
        checkoutCharged: classification.checkoutCharged,
        productDeposit: summary.payNow,
        lines,
        orderId,
      },
    });
    orderEdited = Boolean(editResult?.committed) || editResult?.reason === "already_edited";
    console.log("Partial payment admin order edit:", editResult);
    if (editResult?.errors?.length) {
      console.warn("Partial payment admin order edit errors:", editResult.errors);
    }
    if (editResult?.reason === "restore_in_progress") {
      return { skipped: false, classified: true, status, reason: "restore_in_progress", orderEdited: false };
    }
  } catch (error) {
    console.warn("Partial payment admin order edit:", error.message);
  }

  return { skipped: false, orderEdited, status, classified: true };
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isOrdersUpdatedTopic(topic) {
  return (
    String(topic || "")
      .toUpperCase()
      .replace(/\//g, "_") === "ORDERS_UPDATED"
  );
}

function isOrdersCreateTopic(topic) {
  return (
    String(topic || "")
      .toUpperCase()
      .replace(/\//g, "_") === "ORDERS_CREATE"
  );
}

function orderAlreadyRestored(order, restLineItems = []) {
  if (catalogRestoreStillNeeded(order, restLineItems)) return false;
  const meta = parsePartialPaymentMeta(order);
  if (orderHasDuplicateCatalogLines(order, restLineItems)) return false;
  return meta.orderEdited === true;
}

function orderHasRestoreMaterial(order) {
  const lines = order?.lineItems?.nodes || [];
  if (!lines.length) return false;
  const lineHasPay = lines.some((item) =>
    [...(item.customAttributes || []), ...(item.lineItemGroup?.customAttributes || [])].some(
      (prop) =>
        prop.key === "Pay now" ||
        prop.key === "_partial_pay_now" ||
        prop.key === "Remaining COD" ||
        prop.key === "_partial_pay_cod",
    ),
  );
  if (lineHasPay) return true;
  const orderMap = attributeMap(order.customAttributes || []);
  return Boolean(
    firstPositive(orderMap.partial_deposit, orderMap["Pay now"], orderMap.partial_full_price, orderMap["Full price"]),
  );
}

function productTitleKey(title) {
  return String(title || "")
    .replace(/^Part of:\s*/i, "")
    .trim()
    .toLowerCase();
}

function variantGidFromRestItem(item) {
  const raw = String(item?.variant_id || item?.variantId || item?.variant?.id || "");
  if (!raw) return null;
  if (raw.startsWith("gid://")) return raw;
  return `gid://shopify/ProductVariant/${raw}`;
}

function restLineMatchesGroup(item, group) {
  const variantId = variantGidFromRestItem(item);
  if (variantId && group.variantId && variantId === group.variantId) return true;
  const titleKey = productTitleKey(item.title || item.name);
  return Boolean(titleKey && productTitleKey(group.title) === titleKey);
}

function attachWebhookLineProperties(groups, restLineItems = []) {
  for (const item of restLineItems || []) {
    const group = groups.find((entry) => restLineMatchesGroup(item, entry));
    if (!group) continue;
    const restProps = item.properties || item.customAttributes || [];
    if (!restProps.length) continue;
    const existingPay = paymentFromProperties(group.properties || []);
    const restPay = paymentFromProperties(restProps);
    const existingWeak =
      !existingPay ||
      (!(existingPay.payNow > 0) && !(existingPay.payCod > 0)) ||
      (Number(existingPay.fullPrice) || 0) <= (Number(existingPay.payNow) || 0) + 0.009;
    const restRicher =
      restPay &&
      ((Number(restPay.fullPrice) || 0) > (Number(existingPay?.fullPrice) || 0) + 0.009 ||
        (Number(restPay.payCod) || 0) > (Number(existingPay?.payCod) || 0) + 0.009 ||
        existingWeak);
    if (restRicher) {
      const keys = new Set((group.properties || []).map((prop) => prop.key || prop.name));
      group.properties = [
        ...(group.properties || []),
        ...restProps.filter((prop) => !keys.has(prop.key || prop.name)),
      ];
    }
    const restPrice = parseMoney(item.variant_price || item.variantPrice);
    if (restPrice > (Number(group.variantPrice) || 0)) group.variantPrice = restPrice;
  }
}

function graphQlOrderToRestorePayload(order, restLineItems = []) {
  const orderMap = attributeMap(order.customAttributes || []);
  const groups = [];

  for (const item of order.lineItems?.nodes || []) {
    if (isPartialPaymentCustomTitle(item.title)) continue;
    if (!(Number(item.quantity) > 0)) continue;
    const variantId = item.variant?.id || item.lineItemGroup?.variantId || null;
    const titleKey = productTitleKey(item.title);
    const existing = groups.find((group) => {
      if (variantId && group.variantId === variantId) return true;
      return titleKey && productTitleKey(group.title) === titleKey;
    });
    const qty = Number(item.quantity) || 0;
    const props = [
      ...(item.customAttributes || []),
      ...((item.lineItemGroup?.customAttributes || []).filter(
        (attr) => !(item.customAttributes || []).some((existing) => existing.key === attr.key),
      )),
    ];
    const nextPay = paymentFromProperties(props);
    if (existing) {
      if (!existing.variantId && variantId) existing.variantId = variantId;
      if (!(existing.variantPrice > 0) && parseMoney(item.variant?.price) > 0) {
        existing.variantPrice = parseMoney(item.variant?.price);
      }
      const existingPay = paymentFromProperties(existing.properties);
      if ((!existingPay || !(existingPay.payNow > 0 || existingPay.payCod > 0)) && nextPay) {
        existing.properties = props;
      }
      if (qty > existing.quantity) existing.quantity = qty;
      continue;
    }
    groups.push({
      title: String(item.title || "").replace(/^Part of:\s*/i, ""),
      quantity: qty || 1,
      variantId,
      properties: props,
      discounted: Number(item.discountedUnitPriceSet?.shopMoney?.amount || 0),
      original: Number(item.originalUnitPriceSet?.shopMoney?.amount || 0),
      variantPrice: parseMoney(item.variant?.price),
    });
  }

  attachWebhookLineProperties(groups, restLineItems);

  for (const item of order.lineItems?.nodes || []) {
    if (isPartialPaymentCustomTitle(item.title)) continue;
    if (Number(item.quantity) > 0) continue;
    const variantId = item.variant?.id || item.lineItemGroup?.variantId || null;
    const group = groups.find((entry) => {
      if (variantId && entry.variantId && variantId === entry.variantId) return true;
      const titleKey = productTitleKey(item.title);
      return Boolean(titleKey && productTitleKey(entry.title) === titleKey);
    });
    if (!group) continue;
    const props = [
      ...(item.customAttributes || []),
      ...((item.lineItemGroup?.customAttributes || []).filter(
        (attr) => !(item.customAttributes || []).some((existing) => existing.key === attr.key),
      )),
    ];
    if (!props.length) continue;
    const existingPay = paymentFromProperties(group.properties || []);
    const removedPay = paymentFromProperties(props);
    const existingWeak =
      !existingPay ||
      (!(existingPay.payNow > 0) && !(existingPay.payCod > 0)) ||
      (Number(existingPay.fullPrice) || 0) <= (Number(existingPay.payNow) || 0) + 0.009;
    const removedRicher =
      removedPay &&
      ((Number(removedPay.fullPrice) || 0) > (Number(existingPay?.fullPrice) || 0) + 0.009 ||
        (Number(removedPay.payCod) || 0) > (Number(existingPay?.payCod) || 0) + 0.009 ||
        existingWeak);
    if (!removedRicher) continue;
    const keys = new Set((group.properties || []).map((prop) => prop.key || prop.name));
    group.properties = [
      ...(group.properties || []),
      ...props.filter((prop) => !keys.has(prop.key || prop.name)),
    ];
  }

  const line_items = groups.map((group) => {
    const properties = [...group.properties];
    const fromProps = paymentFromProperties(properties);
    const hasUsablePay =
      fromProps && (fromProps.payNow > 0 || fromProps.payCod > 0);
    const settings = parseSettings();
    if (!hasUsablePay) {
      const charged = Number(group.discounted || group.original || 0);
      const qty = Number(group.quantity) || 1;
      const full = firstPositive(group.variantPrice * qty, fromProps?.fullPrice);
      const payNow = firstPositive(fromProps?.payNow, charged);
      const payCod = firstPositive(fromProps?.payCod, Math.max(0, full - payNow));
      if (payNow || full || payCod) {
        const payment = {
          payNow,
          payCod,
          fullPrice: full,
          surcharge: 0,
          status: payNow > 0 ? "partial_paid" : "unpaid_cod",
        };
        properties.push(...propertiesFromPayment(payment, settings));
      }
    } else if (fromProps && !(fromProps.payCod > 0)) {
      const qty = Number(group.quantity) || 1;
      const full = firstPositive(fromProps.fullPrice, group.variantPrice * qty);
      const payNow = Number(fromProps.payNow) || 0;
      const payCod = roundMoney(Math.max(0, full - payNow));
      if (payCod > 0) {
        properties.push(
          ...propertiesFromPayment(
            { ...fromProps, payCod, fullPrice: full, status: payNow > 0 ? "partial_paid" : "unpaid_cod" },
            settings,
          ),
        );
      }
    }
    return {
      title: group.title,
      quantity: group.quantity,
      variant_id: group.variantId ? String(group.variantId).split("/").pop() : null,
      variant_price: group.variantPrice,
      variantPrice: group.variantPrice,
      discounted: group.discounted,
      original: group.original,
      properties,
    };
  });

  return {
    id: order.id,
    note: order.note,
    tags: order.tags || [],
    currency: order.lineItems?.nodes?.[0]?.originalUnitPriceSet?.shopMoney?.currencyCode,
    note_attributes: [
      ...(order.customAttributes || []),
    ],
    line_items,
  };
}

function mergeWebhookRestorePayload(order, webhookPayload = {}, webhookLines = []) {
  const fromGraphql = graphQlOrderToRestorePayload(order, webhookLines);
  const webhookTags = payloadTags(webhookPayload);
  const orderTags = Array.isArray(order?.tags) ? order.tags : payloadTags({ tags: order?.tags });
  return {
    ...webhookPayload,
    ...fromGraphql,
    id: fromGraphql.id || webhookPayload.id,
    note: order?.note || webhookPayload.note,
    tags: [...new Set([...orderTags, ...webhookTags])],
    currency: fromGraphql.currency || webhookPayload.currency,
    financial_status: webhookPayload.financial_status,
    current_total_price: webhookPayload.current_total_price ?? webhookPayload.total_price,
    total_price: webhookPayload.total_price,
    total_outstanding: webhookPayload.total_outstanding,
    gateway: webhookPayload.gateway,
    processing_method: webhookPayload.processing_method,
    payment_gateway_names: webhookPayload.payment_gateway_names,
    note_attributes: [
      ...(order?.customAttributes || []),
      ...(webhookPayload.note_attributes || webhookPayload.customAttributes || webhookPayload.attributes || []),
    ],
  };
}

async function fetchOrderById(admin, orderId) {
  const found = await graphqlJson(
    admin,
    `#graphql
      query PartialPaymentOrderById($id: ID!) {
        order(id: $id) {
          ${ORDER_RESTORE_FIELDS}
        }
      }
    `,
    { id: orderId },
  );
  if (!found?.errors?.length) return found?.data?.order || null;

  console.warn("Partial payment order lookup errors:", found.errors);
  const fallback = await graphqlJson(
    admin,
    `#graphql
      query PartialPaymentOrderByIdNoGroup($id: ID!) {
        order(id: $id) {
          ${ORDER_RESTORE_FIELDS_NO_GROUP}
        }
      }
    `,
    { id: orderId },
  );
  if (fallback?.errors?.length) {
    console.warn("Partial payment order lookup errors:", fallback.errors);
  }
  return fallback?.data?.order || found?.data?.order || null;
}

async function tagOrderFromPayload(admin, payload, orderId, topic, label) {
  const classification = buildClassification(payload, { topic });
  if (classification.skipped) {
    console.log("[partial-payment] classify skipped", {
      id: orderId,
      reason: classification.reason,
      label,
      topic,
      financialStatus: payload.financial_status || null,
      lineCount: payloadLineItems(payload).length,
    });
    return { tagged: false, classification };
  }
  const ok = await writePartialPaymentTags(admin, orderId, classification.tags);
  console.log("[partial-payment] tagged immediately", {
    id: orderId,
    status: classification.status,
    tags: classification.tags,
    topic,
    label,
    ok,
  });
  return { tagged: ok, classification };
}

export async function restorePartialPaymentOrderById(admin, orderId, options = {}) {
  const id = orderId ? gidFromRestId(orderId) : "";
  if (!id || id === "gid://shopify/Order/undefined" || id === "gid://shopify/Order/null") {
    return { error: "Missing order id" };
  }

  const webhookPayload = options.webhookPayload || {};
  const webhookLines = payloadLineItems(webhookPayload).length
    ? payloadLineItems(webhookPayload)
    : options.webhookLineItems || [];
  let taggedImmediately = false;

  if (!options.preserveFullyPaidNote) {
    try {
      const fromWebhook = { ...webhookPayload, id: webhookPayload.id || id };
      const immediate = await tagOrderFromPayload(admin, fromWebhook, id, options.topic, "webhook");
      taggedImmediately = immediate.tagged;
    } catch (error) {
      console.warn("[partial-payment] immediate tag failed", error.message);
    }
  }

  let order = null;
  let skipRestore = false;
  let skipClassify = false;
  let existingMeta = {};
  for (let attempt = 1; attempt <= RESTORE_ATTEMPTS; attempt++) {
    order = await fetchOrderById(admin, id);
    if (!order) {
      if (attempt < RESTORE_ATTEMPTS) {
        console.log("Partial payment restore: order not ready, retrying", { id, attempt });
        await sleep(RESTORE_RETRY_MS);
        continue;
      }
      return { error: `Order ${id} not found`, taggedImmediately };
    }

    if (!options.preserveFullyPaidNote) {
      try {
        const merged = mergeWebhookRestorePayload(order, webhookPayload, webhookLines);
        const fromGraphql = await tagOrderFromPayload(admin, merged, id, options.topic, "graphql");
        if (fromGraphql.tagged) taggedImmediately = true;
      } catch (error) {
        console.warn("[partial-payment] graphql tag failed", error.message);
      }
    }

    const meta = parsePartialPaymentMeta(order);
    existingMeta = meta;
    const needsRestore = catalogRestoreStillNeeded(order, webhookLines);
    const alreadyTagged = pulsePayTagsOnPayload({ tags: order.tags }) || taggedImmediately;
    const fullyPaidPreserved =
      hasFullyPaidOrderNote(order.note) ||
      Boolean(meta.fullyPaidNoteAt) ||
      orderAttributesAlreadyFullyPaid(order.customAttributes) ||
      Boolean(options.preserveFullyPaidNote);

    if (
      isLaterOrderTopic(options.topic) &&
      !options.retrying &&
      !needsRestore &&
      fullyPaidPreserved &&
      alreadyTagged
    ) {
      return {
        ok: true,
        name: order.name,
        skipped: true,
        reason: "fully_paid_note",
        result: { skipped: true, reason: "fully_paid_note", classified: true },
      };
    }
    if (!needsRestore && (orderAlreadyRestored(order, webhookLines) || meta.orderEdited === true)) {
      skipRestore = true;
      if (alreadyTagged && (meta.status || fullyPaidPreserved)) skipClassify = true;
    } else if (
      isLaterOrderTopic(options.topic) &&
      !options.retrying &&
      !needsRestore &&
      meta.restoreAttempted === true
    ) {
      skipRestore = true;
      if (alreadyTagged && meta.status) skipClassify = true;
    } else if (
      isLaterOrderTopic(options.topic) &&
      !options.retrying &&
      restoreLockIsActive(meta)
    ) {
      skipRestore = true;
    }
    if (orderHasRestoreMaterial(order) || webhookLines.length || attempt === RESTORE_ATTEMPTS) {
      break;
    }
    console.log("Partial payment restore: line items/properties empty, retrying", {
      id,
      name: order.name,
      attempt,
      lineCount: order.lineItems?.nodes?.length || 0,
    });
    await sleep(RESTORE_RETRY_MS);
  }

  if (skipRestore && skipClassify) {
    return {
      ok: true,
      name: order.name,
      skipped: true,
      reason: existingMeta.orderEdited ? "already_edited" : "already_attempted",
      result: { skipped: true, classified: true, orderEdited: Boolean(existingMeta.orderEdited) },
    };
  }

  const mergedPayload = mergeWebhookRestorePayload(order, webhookPayload, webhookLines);
  let result = await processPartialPaymentOrder(admin, mergedPayload, {
    topic: options.topic,
    retrying: Boolean(options.retrying),
    webhookLineItems: webhookLines,
    preserveFullyPaidNote: Boolean(options.preserveFullyPaidNote),
    existingMeta,
    skipRestore,
    skipTags: taggedImmediately,
    skipClassify,
    orderId: id,
  });

  if (result?.reason === "restore_in_progress" && (isOrdersCreateTopic(options.topic) || options.retrying)) {
    console.log("Partial payment restore: CREATE lost race, retrying once", {
      id,
      name: order.name,
    });
    await sleep(CREATE_LOCK_RETRY_MS);
    order = (await fetchOrderById(admin, id)) || order;
    existingMeta = parsePartialPaymentMeta(order);
    result = await processPartialPaymentOrder(
      admin,
      mergeWebhookRestorePayload(order, webhookPayload, webhookLines),
      {
        topic: options.topic,
        retrying: true,
        webhookLineItems: webhookLines,
        preserveFullyPaidNote: Boolean(options.preserveFullyPaidNote),
        existingMeta,
        skipClassify: true,
        skipTags: true,
        orderId: id,
      },
    );
  }

  return { ok: true, name: order.name, result, taggedImmediately };
}

export async function restorePartialPaymentOrderByName(admin, orderName) {
  const query = String(orderName || "")
    .trim()
    .replace(/^#/, "");
  if (!query) return { error: "Enter an order number, for example 1011" };

  const found = await graphqlJson(
    admin,
    `#graphql
      query FindPartialPaymentOrder($query: String!) {
        orders(first: 1, query: $query) {
          nodes { id name }
        }
      }
    `,
    { query: `name:${query}` },
  );
  const foundOrder = found?.data?.orders?.nodes?.[0];
  if (!foundOrder) return { error: `Order #${query} not found` };

  return restorePartialPaymentOrderById(admin, foundOrder.id);
}

function refundedAmountFromPayload(payload) {
  const refunds = payload.refunds || [];
  let total = 0;
  for (const refund of refunds) {
    const txs = refund.transactions || [];
    if (txs.length) {
      for (const tx of txs) {
        const kind = String(tx.kind || "").toLowerCase();
        const ok = String(tx.status || "success").toLowerCase() === "success";
        if (!ok) continue;
        if (kind && kind !== "refund" && kind !== "sale") continue;
        total += Number(tx.amount || 0);
      }
    } else if (refund.amount != null) {
      total += Number(refund.amount || 0);
    }
  }
  return roundMoney(total);
}

export async function applyPartialPaymentRefundStatus(admin, payload) {
  const financial = String(payload.financial_status || "").toLowerCase();
  if (financial !== "refunded" && financial !== "partially_refunded") {
    return { skipped: true, reason: "not_refunded" };
  }

  const orderId = gidFromRestId(payload.admin_graphql_api_id || payload.id);
  const order = await fetchOrderById(admin, orderId);
  if (!order) return { skipped: true, reason: "order_not_found" };

  const meta = parsePartialPaymentMeta(order);
  if (!meta.restoreAttempted && meta.payNow == null && meta.status == null) {
    return { skipped: true, reason: "no_partial_meta" };
  }

  const refundedAmount = refundedAmountFromPayload(payload);
  const remainingCod = Number(meta.payCod || 0);
  const captured = Number(meta.payNow || meta.checkoutCharged || 0);
  const fullRefundOfCaptured =
    financial === "refunded" || (captured > 0 && refundedAmount + 0.009 >= captured);
  let status = meta.status || "partial_paid";
  if (fullRefundOfCaptured && remainingCod > 0) {
    status = "refunded";
  }

  if (meta.refundedAmount === refundedAmount && meta.status === status) {
    return { skipped: true, reason: "unchanged" };
  }

  await admin.graphql(
    `#graphql
      mutation SetPartialPaymentRefund($metafields: [MetafieldsSetInput!]!) {
        metafieldsSet(metafields: $metafields) {
          userErrors { field message }
        }
      }
    `,
    {
      variables: {
        metafields: [
          {
            ownerId: orderId,
            namespace: SETTINGS_METAFIELD.namespace,
            key: SETTINGS_METAFIELD.key,
            type: "json",
            value: JSON.stringify({
              ...meta,
              refundedAmount,
              status,
              financialStatus: financial,
              orderId: meta.orderId || orderId,
            }),
          },
        ],
      },
    },
  );

  if (status === "refunded") {
    await admin.graphql(
      `#graphql
        mutation TagRefundedPartialPayment($id: ID!, $add: [String!]!, $remove: [String!]!) {
          tagsRemove(id: $id, tags: $remove) {
            userErrors { message }
          }
          tagsAdd(id: $id, tags: $add) {
            userErrors { message }
          }
        }
      `,
      {
        variables: {
          id: orderId,
          add: [TAGS.refunded],
          remove: [TAGS.partialPaid, TAGS.unpaidCod],
        },
      },
    );
  }

  return { ok: true, status, refundedAmount };
}

export async function detectInvoiceFullyPaid(admin, payload, options = {}) {
  const orderId = gidFromRestId(payload.admin_graphql_api_id || payload.id);
  const live = await fetchOrderPaidState(admin, orderId);
  const financial = String(
    live?.displayFinancialStatus || payload.financial_status || "",
  ).toLowerCase();
  if (financial !== "paid") {
    return { skipped: true, reason: "not_shopify_paid" };
  }

  const tags = payloadTags({ tags: live?.tags || payload.tags });
  if (tags.includes(TAGS.fullyPaid)) {
    return { skipped: true, reason: "already_tagged" };
  }
  if (orderAttributesAlreadyFullyPaid(live?.customAttributes || payload.note_attributes || [])) {
    return { skipped: true, reason: "already_fully_paid_attrs" };
  }
  if (hasFullyPaidOrderNote(live?.note || payload.note)) {
    return { skipped: true, reason: "fully_paid_note" };
  }

  const meta = live ? parsePartialPaymentMeta(live) : {};
  const amounts = live
    ? checkoutAmountsFromOrder(meta, live)
    : {
        payNow: Number(resolveOrderPaymentSummary(payload).payNow) || 0,
        fullPrice: Number(resolveOrderPaymentSummary(payload).fullPrice) || 0,
        remaining: Number(resolveOrderPaymentSummary(payload).payCod) || 0,
      };
  const remaining = Number(amounts.remaining) || 0;
  const outstanding = parseMoney(live?.totalOutstandingSet?.shopMoney?.amount ?? payload.total_outstanding);
  const currentTotal = parseMoney(
    live?.currentTotalPriceSet?.shopMoney?.amount ?? payload.current_total_price ?? payload.total_price,
  );
  const captured = parseMoney(
    live?.totalReceivedSet?.shopMoney?.amount ?? payload.total_received ?? payload.net_payments,
  );
  const expectedFull = roundMoney(
    Math.max(Number(amounts.fullPrice || 0), Number(amounts.payNow || 0) + remaining),
  );

  if (!(remaining > 0.009)) {
    return { skipped: true, reason: "no_remaining_to_collect" };
  }
  if (outstanding > 0.009) {
    return { skipped: true, reason: "outstanding" };
  }
  const looksDepositOnly =
    expectedFull > 0 &&
    currentTotal + 1 < expectedFull &&
    (captured <= 0.009 || captured + 1 < expectedFull);
  if (looksDepositOnly) {
    return { skipped: true, reason: "deposit_only_paid" };
  }

  return markPartialPaymentFullyPaid(admin, live?.id || orderId, { collectedVia: COLLECTED_VIA.invoice });
}

async function fetchOrderPaidState(admin, orderId) {
  const query = (includeOutstanding, includeReceived) => `#graphql
    query PartialPaymentOrderPaidState($id: ID!) {
      order(id: $id) {
        id
        name
        note
        tags
        displayFinancialStatus
        currentTotalPriceSet { shopMoney { amount } }
        ${includeOutstanding ? "totalOutstandingSet { shopMoney { amount } }" : ""}
        ${includeReceived ? "totalReceivedSet { shopMoney { amount } }" : ""}
        customAttributes { key value }
        metafield(namespace: "$app", key: "partial_payment") { value }
      }
    }
  `;
  try {
    let includeOutstanding = true;
    let includeReceived = true;
    let json = await graphqlJson(admin, query(true, true), { id: orderId });
    const problems = JSON.stringify(json?.errors || "");
    if (/totaloutstandingset/i.test(problems)) includeOutstanding = false;
    if (/totalreceivedset/i.test(problems)) includeReceived = false;
    if (!includeOutstanding || !includeReceived) {
      json = await graphqlJson(admin, query(includeOutstanding, includeReceived), { id: orderId });
    }
    return json?.data?.order || null;
  } catch (error) {
    console.warn("[partial-payment] paid-state lookup failed", error.message);
    return null;
  }
}

function remainingFromOrder(meta, order) {
  const fromMeta = Number(meta.payCod);
  if (fromMeta > 0) return roundMoney(fromMeta);
  const attrs = attributeMap(order.customAttributes || []);
  return firstPositive(
    attrs.partial_remaining_cod,
    attrs["Remaining COD"],
    attrs["Due on delivery"],
    roundMoney(Math.max(0, Number(meta.fullPrice || 0) - Number(meta.payNow || 0))),
  );
}

function checkoutAmountsFromOrder(meta, order) {
  const attrs = attributeMap(order.customAttributes || []);
  const payNow = firstPositive(meta.payNow, meta.productDeposit, attrs.partial_deposit, attrs["Pay now"]);
  const fullPrice = firstPositive(meta.fullPrice, attrs.partial_full_price, attrs["Full price"]);
  const checkoutCharged = firstPositive(
    meta.checkoutCharged,
    meta.productDeposit,
    attrs["Checkout charged"],
    meta.payNow,
    payNow,
  );
  return { payNow, fullPrice, checkoutCharged, remaining: remainingFromOrder(meta, order) };
}

export async function markPartialPaymentFullyPaid(admin, orderRef, options = {}) {
  const raw = String(orderRef || "").trim();
  if (!raw) return { error: "Enter an order number, for example 1011" };

  let id = "";
  if (raw.startsWith("gid://")) {
    id = raw;
  } else if (/^\d{8,}$/.test(raw.replace(/^#/, ""))) {
    id = gidFromRestId(raw.replace(/^#/, ""));
  } else {
    const query = raw.replace(/^#/, "");
    const found = await admin.graphql(
      `#graphql
        query FindPartialPaymentOrderForStatus($query: String!) {
          orders(first: 1, query: $query) {
            nodes { id name }
          }
        }
      `,
      { variables: { query: `name:${query}` } },
    );
    const json = await found.json();
    const foundOrder = json.data?.orders?.nodes?.[0];
    if (!foundOrder) return { error: `Order #${query} not found` };
    id = foundOrder.id;
  }

  const order = await fetchOrderById(admin, id);
  if (!order) return { error: "Order not found" };

  const meta = parsePartialPaymentMeta(order);
  const { payNow, fullPrice, checkoutCharged, remaining } = checkoutAmountsFromOrder(meta, order);
  const collectedVia =
    options.collectedVia === COLLECTED_VIA.invoice ? COLLECTED_VIA.invoice : COLLECTED_VIA.cod;
  const alreadyNoted = hasFullyPaidOrderNote(order.note) || Boolean(meta.fullyPaidNoteAt);
  const attrsAlreadyFullyPaid = orderAttributesAlreadyFullyPaid(order.customAttributes);
  const fullyPaidNoteAt = meta.fullyPaidNoteAt || new Date().toISOString();

  await admin.graphql(
    `#graphql
      mutation MarkPartialPaymentCollected($id: ID!, $add: [String!]!, $remove: [String!]!, $metafields: [MetafieldsSetInput!]!) {
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
    `,
    {
      variables: {
        id: order.id,
        add: [TAGS.fullyPaid],
        remove: [TAGS.partialPaid, TAGS.unpaidCod, TAGS.refunded],
        metafields: [
          {
            ownerId: order.id,
            namespace: SETTINGS_METAFIELD.namespace,
            key: SETTINGS_METAFIELD.key,
            type: "json",
            value: JSON.stringify({
              ...meta,
              status: "fully_paid",
              payCod: 0,
              orderId: meta.orderId || order.id,
              fullyPaidNoteAt,
              collectedVia,
            }),
          },
        ],
      },
    },
  );

  if (!alreadyNoted || !attrsAlreadyFullyPaid) {
    const input = { id: order.id };
    if (!alreadyNoted) {
      input.note = buildFullyPaidOrderNote({
        payNow,
        payCod: remaining,
        fullPrice,
        checkoutCharged,
        collectedVia,
        markedAt: fullyPaidNoteAt,
      });
    }
    if (!attrsAlreadyFullyPaid) {
      input.customAttributes = upsertCustomAttributes(
        order.customAttributes || [],
        buildFullyPaidCustomAttributeUpdates({ remaining, markedAt: fullyPaidNoteAt }),
      );
    }
    await admin.graphql(
      `#graphql
        mutation ReplaceFullyPaidOrderNote($input: OrderInput!) {
          orderUpdate(input: $input) {
            userErrors { field message }
          }
        }
      `,
      {
        variables: { input },
      },
    );
  }

  void syncOrderSnapshotFromAdmin(admin, order.id);
  return { ok: true, name: order.name, status: "fully_paid" };
}
