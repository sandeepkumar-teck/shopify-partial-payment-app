import {
  ADMIN_PARTIAL_PAYMENT_LINE_TITLE,
  ATTR,
  SETTINGS_METAFIELD,
  paymentFromProperties,
  parseMoney,
  roundMoney,
} from "./partial-payment";

const RESTORE_LOCK_MS = 120000;
const LINE_PAGE = 250;

const ORIGINAL_LINE_FIELDS = `
  id
  title
  name
  quantity
  variant { id price }
  lineItemGroup { id title variantId quantity customAttributes { key value } }
  customAttributes { key value }
  originalUnitPriceSet { shopMoney { amount currencyCode } }
  discountedUnitPriceSet { shopMoney { amount } }
`;

const CALCULATED_LINE_FIELDS = `
  id
  title
  quantity
  variant { id price }
  customAttributes { key value }
  originalUnitPriceSet { shopMoney { amount currencyCode } }
`;

async function graphqlJson(admin, query, variables) {
  try {
    const response = await admin.graphql(query, { variables });
    return await response.json();
  } catch (error) {
    if (error?.body && typeof error.body === "object") {
      console.warn("Partial payment GraphQL error:", error.message);
      return error.body;
    }
    throw error;
  }
}

function userErrorsFrom(json, mutationName) {
  const payload = json?.data?.[mutationName];
  const errors = [
    ...(json?.errors || []),
    ...(payload?.userErrors || []),
  ].map((error) => error.message || JSON.stringify(error));
  return errors.filter(Boolean);
}

export function isPartialPaymentCustomTitle(title) {
  return String(title || "")
    .trim()
    .toLowerCase()
    .startsWith(ADMIN_PARTIAL_PAYMENT_LINE_TITLE.toLowerCase());
}

function moneyInput(amount, currencyCode) {
  return {
    amount: roundMoney(amount).toFixed(2),
    currencyCode,
  };
}

export function parsePartialPaymentMeta(order) {
  if (!order?.metafield?.value) return {};
  try {
    const parsed = JSON.parse(order.metafield.value);
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

export function restoreLockIsActive(meta) {
  const at = Date.parse(meta?.restoreLockAt || "");
  return Number.isFinite(at) && Date.now() - at < RESTORE_LOCK_MS;
}

function isLaterOrderTopic(topic) {
  const normalized = String(topic || "")
    .toUpperCase()
    .replace(/\//g, "_");
  return normalized === "ORDERS_UPDATED" || normalized === "ORDERS_PAID";
}

function productTitle(title) {
  return String(title || "")
    .replace(/^Part of:\s*/i, "")
    .trim()
    .toLowerCase();
}

function lineUnitPrice(line) {
  return roundMoney(Number(line?.originalUnitPriceSet?.shopMoney?.amount || 0));
}

function sameProductLine(line, target) {
  if (isPartialPaymentCustomTitle(line?.title)) return false;
  const wantTitle = productTitle(target.title);
  const sameVariant = Boolean(target.variantId && line.variant?.id === target.variantId);
  const sameTitle = Boolean(wantTitle && productTitle(line.title) === wantTitle);
  return sameVariant || sameTitle;
}

function isCatalogPricedLine(line, fullUnit) {
  const unit = lineUnitPrice(line);
  if (!(fullUnit > 0)) return false;
  return unit + 0.009 >= fullUnit;
}

function lineLooksLikeDeposit(line, target, fullUnit) {
  const unit = lineUnitPrice(line);
  if (!(unit > 0)) return false;
  if (fullUnit > 0 && unit + 0.009 < fullUnit) return true;
  const qty = Number(target?.quantity) || Number(line.quantity) || 1;
  const payNow = Number(target?.payment?.payNow || 0);
  const payCod = Number(target?.payment?.payCod || 0);
  const shareUnit = payNow > 0 && qty > 0 ? roundMoney(payNow / qty) : 0;
  if (shareUnit > 0 && Math.abs(unit - shareUnit) <= 0.05) {
    if (payCod > 0) return true;
    if (fullUnit > 0 && unit + 0.009 < fullUnit) return true;
  }
  return false;
}

function catalogKeeperLines(related, target, fullUnit) {
  return (related || []).filter(
    (line) => isCatalogPricedLine(line, fullUnit) && !lineLooksLikeDeposit(line, target, fullUnit),
  );
}

function pickCatalogKeeper(catalogLines, preferredId = null) {
  if (!catalogLines?.length) return null;
  if (preferredId) {
    const preferred = catalogLines.find((line) => line.id === preferredId);
    if (preferred) return preferred;
  }
  const withVariant = catalogLines.find((line) => line.variant?.id);
  return withVariant || catalogLines[0];
}

function extraLinesToZero(related, keeper, target, fullUnit) {
  return (related || []).filter((line) => {
    if (!keeper || line.id === keeper.id) return false;
    if (lineLooksLikeDeposit(line, target, fullUnit)) return true;
    return isCatalogPricedLine(line, fullUnit);
  });
}

function liveLineQuantity(line) {
  return Number(line?.quantity) || 0;
}

function lineCustomAttributes(line) {
  const fromLine = line?.customAttributes || [];
  const fromGroup = line?.lineItemGroup?.customAttributes || [];
  if (!fromGroup.length) return fromLine;
  const keys = new Set(fromLine.map((attr) => attr.key));
  return [...fromLine, ...fromGroup.filter((attr) => !keys.has(attr.key))];
}

function variantGidFromRest(item) {
  if (!item?.variant_id && !item?.variantId && !item?.variant?.id) return null;
  const raw = String(item.variant_id || item.variantId || item.variant?.id);
  if (raw.startsWith("gid://")) return raw;
  return `gid://shopify/ProductVariant/${raw}`;
}

function isExtraPaidNow(payment) {
  return Number(payment?.surcharge || 0) > 0 && Number(payment?.payNow || 0) > 0;
}

function paymentFromLineAttributes(attrs) {
  const parsed = paymentFromProperties(attrs);
  if (!parsed) return null;
  const map = {};
  for (const attr of attrs || []) {
    const key = attr.key || attr.name;
    if (key) map[key] = attr.value;
  }
  const unitPrice = parseMoney(map[ATTR.unit]);
  const depositUnit = parseMoney(map[ATTR.depositUnit]);
  const payNow = Number(parsed.payNow) || 0;
  let payCod = Number(parsed.payCod) || 0;
  let fullPrice = Number(parsed.fullPrice) || 0;
  const extraNow = isExtraPaidNow(parsed);
  const implied = roundMoney(payNow + payCod);
  if (!extraNow && implied > fullPrice + 0.009) fullPrice = implied;
  return {
    ...parsed,
    payNow,
    payCod,
    fullPrice,
    unitPrice,
    depositUnit,
    status: payCod > 0 || (fullPrice > payNow + 0.009) ? "partial_paid" : parsed.status,
  };
}

function enrichPayment(payment, variantPrice, quantity) {
  if (!payment || payment.isInfo) return payment;
  const qty = Number(quantity) || 1;
  const payNow = Number(payment.payNow) || 0;
  let payCod = Number(payment.payCod) || 0;
  const extraNow = isExtraPaidNow(payment);
  const fromPayPlusCod = qty > 0 ? roundMoney((payNow + payCod) / qty) : 0;
  const catalogUnit = Math.max(
    Number(variantPrice) || 0,
    Number(payment.unitPrice) || 0,
    extraNow ? (qty > 0 ? roundMoney(payCod / qty) : 0) : fromPayPlusCod,
  );
  const storedFull = Number(payment.fullPrice) || 0;
  const inflatedStored = extraNow && storedFull + 0.009 >= payNow + payCod;
  const fullPrice = extraNow
    ? roundMoney(Math.max(catalogUnit * qty, payCod, inflatedStored ? 0 : storedFull))
    : roundMoney(Math.max(storedFull, catalogUnit * qty));
  if (payCod <= 0 && fullPrice > payNow + 0.009) {
    payCod = roundMoney(fullPrice - payNow);
  }
  return {
    ...payment,
    fullPrice,
    payCod,
    payNow,
    status: payCod > 0 || fullPrice > payNow + 0.009 ? "partial_paid" : payment.status,
  };
}

function paymentFromLinePrices(line) {
  const qty = Number(line.quantity) || 1;
  if (qty <= 0) return null;
  const unit = lineUnitPrice(line);
  const fullUnit = parseMoney(line.variant?.price);
  if (!(fullUnit > 0) && !(unit > 0)) return null;
  const payNow = roundMoney(unit * qty);
  if (fullUnit > 0) {
    const fullPrice = roundMoney(fullUnit * qty);
    const payCod = roundMoney(Math.max(0, fullPrice - payNow));
    return {
      isInfo: false,
      payNow,
      payCod,
      fullPrice,
      surcharge: 0,
      status: "partial_paid",
    };
  }
  return {
    isInfo: false,
    payNow,
    payCod: 0,
    fullPrice: payNow,
    surcharge: 0,
    status: "partial_paid",
  };
}

function usableLinePayment(payment) {
  if (!payment || payment.isInfo) return null;
  if (payment.payNow > 0 || payment.payCod > 0 || payment.fullPrice > 0) return payment;
  return null;
}

function richerPayment(current, incoming) {
  const left = usableLinePayment(current);
  const right = usableLinePayment(incoming);
  if (right && !left) return incoming;
  if (left && !right) return current;
  if (!left && !right) return incoming || current;
  const leftFull = Number(left.fullPrice || 0);
  const rightFull = Number(right.fullPrice || 0);
  const leftCod = Number(left.payCod || 0);
  const rightCod = Number(right.payCod || 0);
  if (rightFull > leftFull + 0.009 || rightCod > leftCod + 0.009) return incoming;
  return current;
}

function collectPaymentTargets({ orderLines, restLineItems }) {
  const targets = [];

  const findExisting = (title, variantId) => {
    const wantTitle = productTitle(title);
    return targets.find((target) => {
      if (variantId && target.variantId === variantId) return true;
      return wantTitle && productTitle(target.title) === wantTitle;
    });
  };

  const push = (title, variantId, payment, quantity, variantPrice) => {
    const usable = enrichPayment(usableLinePayment(payment) || payment, variantPrice, quantity);
    if (!usable || usable.isInfo) return;
    const existing = findExisting(title, variantId);
    if (existing) {
      if (!existing.variantId && variantId) existing.variantId = variantId;
      if ((Number(variantPrice) || 0) > (Number(existing.variantPrice) || 0)) {
        existing.variantPrice = Number(variantPrice) || 0;
      }
      existing.payment = enrichPayment(
        richerPayment(existing.payment, usable),
        existing.variantPrice,
        Number(quantity) || existing.quantity,
      );
      if ((Number(quantity) || 0) > (Number(existing.quantity) || 0)) {
        existing.quantity = Number(quantity) || existing.quantity;
      }
      return;
    }
    targets.push({
      title: String(title || "Catalog price").replace(/^Part of:\s*/i, ""),
      variantId: variantId || null,
      variantPrice: Number(variantPrice || 0),
      payment: usable,
      quantity: Number(quantity) || 1,
    });
  };

  const pending = [];

  const consider = (title, variantId, payment, quantity, variantPrice, live) => {
    pending.push({ title, variantId, payment, quantity, variantPrice, live });
  };

  for (const line of orderLines || []) {
    if (isPartialPaymentCustomTitle(line.title)) continue;
    const liveQty = liveLineQuantity(line);
    const qty = liveQty > 0 ? liveQty : Number(line.lineItemGroup?.quantity) || 1;
    const payment =
      usableLinePayment(paymentFromLineAttributes(lineCustomAttributes(line))) ||
      (liveQty > 0 ? paymentFromLinePrices(line) : null);
    consider(
      line.title || line.name,
      line.variant?.id || line.lineItemGroup?.variantId,
      payment,
      qty,
      parseMoney(line.variant?.price),
      liveQty > 0,
    );
  }

  for (const item of restLineItems || []) {
    if (isPartialPaymentCustomTitle(item.title)) continue;
    const liveQty = Number(item.quantity) || 0;
    const payment =
      usableLinePayment(paymentFromLineAttributes(item.properties || [])) ||
      (liveQty > 0
        ? paymentFromLinePrices({
            quantity: item.quantity,
            variant: { price: item.variant_price || item.variantPrice },
            originalUnitPriceSet: {
              shopMoney: { amount: item.discounted || item.original || item.price || 0 },
            },
          })
        : null);
    consider(
      item.title || item.name,
      variantGidFromRest(item),
      payment,
      liveQty > 0 ? liveQty : 1,
      parseMoney(item.variant_price || item.variantPrice),
      liveQty > 0,
    );
  }

  for (const row of pending.filter((entry) => entry.live)) {
    push(row.title, row.variantId, row.payment, row.quantity, row.variantPrice);
  }
  for (const row of pending.filter((entry) => !entry.live)) {
    const usable = enrichPayment(
      usableLinePayment(row.payment) || row.payment,
      row.variantPrice,
      row.quantity,
    );
    if (!usable || usable.isInfo) continue;
    const existing = findExisting(row.title, row.variantId);
    if (!existing) continue;
    if (!existing.variantId && row.variantId) existing.variantId = row.variantId;
    if ((Number(row.variantPrice) || 0) > (Number(existing.variantPrice) || 0)) {
      existing.variantPrice = Number(row.variantPrice) || 0;
    }
    existing.payment = enrichPayment(
      richerPayment(existing.payment, usable),
      existing.variantPrice,
      Number(existing.quantity) || row.quantity || 1,
    );
  }

  return targets.filter((target) => target.payment);
}

function relatedProductLines(calculatedLines, target) {
  return (calculatedLines || []).filter((line) => {
    if (!sameProductLine(line, target)) return false;
    return liveLineQuantity(line) > 0;
  });
}

function targetFullUnit(target, relatedLines = []) {
  const qty = Number(target.quantity) || 1;
  const payNow = Number(target.payment?.payNow || 0);
  const payCod = Number(target.payment?.payCod || 0);
  const extraNow = isExtraPaidNow(target.payment);
  const fromPayment = roundMoney((Number(target.payment?.fullPrice) || 0) / qty);
  const fromPayPlusCod = qty > 0 ? roundMoney((payNow + payCod) / qty) : 0;
  const fromHiddenUnit = Number(target.payment?.unitPrice || 0);
  const fromTargetVariant = Number(target.variantPrice || 0);
  const fromRelated = Number(
    relatedLines.find((line) => parseMoney(line.variant?.price) > 0)?.variant?.price || 0,
  );
  const fromRemaining = qty > 0 ? roundMoney(payCod / qty) : 0;
  if (extraNow) {
    const inflated = fromPayment > 0 && fromPayPlusCod > 0 && Math.abs(fromPayment - fromPayPlusCod) <= 0.05;
    return roundMoney(
      Math.max(fromTargetVariant, fromRelated, fromHiddenUnit, fromRemaining, inflated ? 0 : fromPayment, 0),
    );
  }
  return roundMoney(
    Math.max(fromTargetVariant, fromRelated, fromHiddenUnit, fromPayPlusCod, fromPayment, 0),
  );
}

export function orderHasDuplicateCatalogLines(order, restLineItems = []) {
  const lines = order?.lineItems?.nodes || [];
  const targets = collectPaymentTargets({ orderLines: lines, restLineItems });
  if (!targets.length) {
    const groups = new Map();
    for (const line of lines) {
      if (isPartialPaymentCustomTitle(line.title)) continue;
      if (Number(line.quantity) <= 0) continue;
      const key = line.variant?.id || `title:${productTitle(line.title)}`;
      groups.set(key, (groups.get(key) || 0) + 1);
    }
    return [...groups.values()].some((count) => count > 1);
  }
  return targets.some((target) => {
    const related = relatedProductLines(lines, target);
    const catalog = catalogKeeperLines(related, target, targetFullUnit(target, related));
    return catalog.length > 1 || (catalog.length >= 1 && related.length > catalog.length);
  });
}

export function catalogRestoreStillNeeded(order, restLineItems = []) {
  const lines = order?.lineItems?.nodes || [];
  if (orderHasDuplicateCatalogLines(order, restLineItems)) return true;
  const targets = collectPaymentTargets({ orderLines: lines, restLineItems });
  if (!targets.length) {
    return lines.some((line) => {
      if (isPartialPaymentCustomTitle(line.title)) return false;
      if (Number(line.quantity) <= 0) return false;
      const catalog = parseMoney(line.variant?.price);
      const unit = lineUnitPrice(line);
      return catalog > 0 && unit + 0.009 < catalog;
    });
  }
  return targets.some((target) => {
    const related = relatedProductLines(lines, target);
    const fullUnit = targetFullUnit(target, related);
    if (!related.length) return fullUnit > 0;
    const catalog = catalogKeeperLines(related, target, fullUnit);
    if (related.some((line) => lineLooksLikeDeposit(line, target, fullUnit))) return true;
    return catalog.length !== 1 || related.length !== 1;
  });
}

function calculatedLinesFrom(payload, mutationName) {
  const order = payload?.data?.[mutationName]?.calculatedOrder;
  return order?.lineItems?.nodes || null;
}

async function fetchCalculatedLines(admin, calculatedOrderId) {
  const result = await graphqlJson(
    admin,
    `#graphql
      query PartialPaymentCalculatedOrderLines($id: ID!) {
        node(id: $id) {
          ... on CalculatedOrder {
            id
            lineItems(first: ${LINE_PAGE}) { nodes { ${CALCULATED_LINE_FIELDS} } }
          }
        }
      }
    `,
    { id: calculatedOrderId },
  );
  return result.data?.node?.lineItems?.nodes || [];
}

async function setLineQuantity(admin, calculatedOrderId, lineItemId, quantity, restock) {
  const result = await graphqlJson(
    admin,
    `#graphql
      mutation SetPartialPaymentLineQuantity($id: ID!, $lineItemId: ID!, $quantity: Int!, $restock: Boolean!) {
        orderEditSetQuantity(id: $id, lineItemId: $lineItemId, quantity: $quantity, restock: $restock) {
          calculatedLineItem { id quantity }
          calculatedOrder {
            lineItems(first: ${LINE_PAGE}) { nodes { ${CALCULATED_LINE_FIELDS} } }
          }
          userErrors { field message }
        }
      }
    `,
    { id: calculatedOrderId, lineItemId, quantity, restock },
  );
  return {
    errors: userErrorsFrom(result, "orderEditSetQuantity"),
    lines: calculatedLinesFrom(result, "orderEditSetQuantity"),
  };
}

async function zeroDepositLines(admin, calculatedOrderId, lines) {
  const errors = [];
  let nextLines = null;
  let mutated = false;
  for (const line of lines) {
    let result = await setLineQuantity(admin, calculatedOrderId, line.id, 0, false);
    if (result.errors.length) {
      result = await setLineQuantity(admin, calculatedOrderId, line.id, 0, true);
    }
    if (result.errors.length) {
      errors.push(...result.errors);
      console.warn("Partial payment orderEditSetQuantity:", result.errors, line.id, line.title);
    } else {
      mutated = true;
      if (result.lines) nextLines = result.lines;
    }
  }
  return { errors, lines: nextLines, mutated };
}

async function writePartialPaymentMeta(admin, orderId, meta) {
  const result = await graphqlJson(
    admin,
    `#graphql
      mutation SetPartialPaymentRestoreMeta($metafields: [MetafieldsSetInput!]!) {
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
          value: JSON.stringify(meta),
        },
      ],
    },
  );
  const errors = userErrorsFrom(result, "metafieldsSet");
  if (errors.length) {
    console.warn("Partial payment restore metafield:", errors);
  }
  return errors;
}

async function queryOrderForEdit(admin, orderId) {
  const withGroup = await graphqlJson(
    admin,
    `#graphql
      query PartialPaymentOrderEditCheck($id: ID!) {
        order(id: $id) {
          id
          metafield(namespace: "$app", key: "partial_payment") { value }
          lineItems(first: ${LINE_PAGE}) {
            nodes { ${ORIGINAL_LINE_FIELDS} }
          }
        }
      }
    `,
    { id: orderId },
  );
  if (!withGroup.errors?.length) return withGroup;

  console.warn("Partial payment order edit query (lineItemGroup):", withGroup.errors);
  return graphqlJson(
    admin,
    `#graphql
      query PartialPaymentOrderEditCheckNoGroup($id: ID!) {
        order(id: $id) {
          id
          metafield(namespace: "$app", key: "partial_payment") { value }
          lineItems(first: ${LINE_PAGE}) {
            nodes {
              id
              title
              name
              quantity
              variant { id price }
              customAttributes { key value }
              originalUnitPriceSet { shopMoney { amount currencyCode } }
              discountedUnitPriceSet { shopMoney { amount } }
            }
          }
        }
      }
    `,
    { id: orderId },
  );
}

async function fillMissingVariantPrices(admin, targets) {
  const ids = [
    ...new Set(
      (targets || [])
        .filter((target) => target.variantId && !(Number(target.variantPrice) > 0))
        .map((target) => target.variantId),
    ),
  ];
  if (!ids.length) return targets;
  const result = await graphqlJson(
    admin,
    `#graphql
      query PartialPaymentVariantPrices($ids: [ID!]!) {
        nodes(ids: $ids) {
          ... on ProductVariant { id price }
        }
      }
    `,
    { ids },
  );
  const prices = new Map();
  for (const node of result?.data?.nodes || []) {
    if (node?.id) prices.set(node.id, parseMoney(node.price));
  }
  for (const target of targets || []) {
    const found = prices.get(target.variantId);
    if (!(found > 0)) continue;
    target.variantPrice = found;
    target.payment = enrichPayment(target.payment, found, target.quantity);
  }
  return targets;
}

function mergeRestoreMeta(stored = {}, seedMeta = {}) {
  return {
    ...seedMeta,
    ...stored,
    status: stored.status || seedMeta.status,
    payNow: stored.payNow ?? seedMeta.payNow,
    payCod: stored.payCod ?? seedMeta.payCod,
    fullPrice: stored.fullPrice ?? seedMeta.fullPrice,
    checkoutCharged: stored.checkoutCharged ?? seedMeta.checkoutCharged,
    productDeposit: stored.productDeposit ?? seedMeta.productDeposit,
    lines: stored.lines || seedMeta.lines,
    orderId: stored.orderId || seedMeta.orderId,
  };
}

export async function restoreCatalogPriceOnAdminOrder(
  admin,
  { orderId, currencyCode, currencySymbol, restLineItems = [], topic = null, retrying = false, seedMeta = {} },
) {
  const existing = await queryOrderForEdit(admin, orderId);
  const queryErrors = existing?.errors || [];
  if (queryErrors.length) {
    console.warn("Partial payment order edit query:", queryErrors);
    return { skipped: true, reason: "order_query_failed", errors: queryErrors.map((e) => e.message) };
  }

  const order = existing.data?.order;
  const meta = mergeRestoreMeta(parsePartialPaymentMeta(order), seedMeta);
  const needsRestore = catalogRestoreStillNeeded(order, restLineItems);

  if (!retrying && restoreLockIsActive(meta)) {
    return { skipped: true, reason: "restore_in_progress" };
  }
  if (!needsRestore) {
    return { skipped: true, reason: "already_edited" };
  }

  const targets = collectPaymentTargets({
    orderLines: order?.lineItems?.nodes || [],
    restLineItems,
  });
  await fillMissingVariantPrices(admin, targets);
  if (!targets.length) {
    console.warn("Partial payment order edit: no partial-payment properties on order lines");
    return { skipped: true, reason: "no_partial_lines" };
  }

  const writeLock = !(isLaterOrderTopic(topic) && meta.restoreAttempted === true);
  if (writeLock) {
    await writePartialPaymentMeta(admin, orderId, {
      ...meta,
      restoreLockAt: new Date().toISOString(),
    });
  }

  const begin = await graphqlJson(
    admin,
    `#graphql
      mutation BeginPartialPaymentOrderEdit($id: ID!) {
        orderEditBegin(id: $id) {
          calculatedOrder {
            id
            lineItems(first: ${LINE_PAGE}) { nodes { ${CALCULATED_LINE_FIELDS} } }
          }
          userErrors { field message }
        }
      }
    `,
    { id: orderId },
  );
  const beginErrors = userErrorsFrom(begin, "orderEditBegin");
  const calculatedOrderId = begin.data?.orderEditBegin?.calculatedOrder?.id;
  if (beginErrors.length || !calculatedOrderId) {
    console.warn("Partial payment orderEditBegin:", beginErrors);
    await writePartialPaymentMeta(admin, orderId, { ...meta, restoreLockAt: null });
    return { skipped: true, reason: "begin_failed", errors: beginErrors };
  }

  let lines = begin.data.orderEditBegin.calculatedOrder.lineItems?.nodes || [];
  if (lines.length < (order?.lineItems?.nodes || []).length) {
    const fetched = await fetchCalculatedLines(admin, calculatedOrderId);
    if (fetched.length) lines = fetched;
  }
  const shopCurrency =
    currencyCode ||
    lines[0]?.originalUnitPriceSet?.shopMoney?.currencyCode ||
    order?.lineItems?.nodes?.[0]?.originalUnitPriceSet?.shopMoney?.currencyCode ||
    "INR";

  const errors = [];
  let didMutate = false;

  const applyLines = (nextLines) => {
    if (Array.isArray(nextLines) && nextLines.length) lines = nextLines;
  };

  const applyZero = async (toZero) => {
    if (!toZero.length) return;
    const zeroResult = await zeroDepositLines(admin, calculatedOrderId, toZero);
    errors.push(...zeroResult.errors);
    if (zeroResult.mutated) didMutate = true;
    applyLines(zeroResult.lines);
    if (!zeroResult.lines) {
      const zeroed = new Set(toZero.map((line) => line.id));
      lines = lines.map((line) => (zeroed.has(line.id) ? { ...line, quantity: 0 } : line));
    }
    const fetched = await fetchCalculatedLines(admin, calculatedOrderId);
    if (fetched.length) lines = fetched;
  };

  const setLiveQuantity = async (lineItemId, quantity) => {
    let result = await setLineQuantity(admin, calculatedOrderId, lineItemId, quantity, false);
    if (result.errors.length) {
      result = await setLineQuantity(admin, calculatedOrderId, lineItemId, quantity, true);
    }
    if (result.errors.length) {
      errors.push(...result.errors);
      console.warn("Partial payment set line quantity:", result.errors, lineItemId, quantity);
      return false;
    }
    didMutate = true;
    applyLines(result.lines);
    const fetched = await fetchCalculatedLines(admin, calculatedOrderId);
    if (fetched.length) lines = fetched;
    return true;
  };

  try {
    for (const target of targets) {
      const qty = Math.max(1, Number(target.quantity) || 1);
      let related = relatedProductLines(lines, target);
      let fullUnit = targetFullUnit(target, related);

      // Remove deposit-priced expand/checkout lines first. Adding a catalog variant
      // while a lineExpand group is still live can unbundle a second ₹catalog line.
      await applyZero(related.filter((line) => lineLooksLikeDeposit(line, target, fullUnit)));

      related = relatedProductLines(lines, target);
      fullUnit = targetFullUnit(target, related);
      let catalogLines = catalogKeeperLines(related, target, fullUnit);
      let keeper = pickCatalogKeeper(catalogLines);

      const shouldAddCatalog = !keeper && (fullUnit > 0 || Boolean(target.variantId));

      if (shouldAddCatalog) {
        let restored = false;
        if (target.variantId) {
          const addVariant = await graphqlJson(
            admin,
            `#graphql
              mutation AddCatalogVariant($id: ID!, $variantId: ID!, $quantity: Int!) {
                orderEditAddVariant(id: $id, variantId: $variantId, quantity: $quantity, allowDuplicates: false) {
                  calculatedLineItem {
                    id
                    title
                    quantity
                    variant { id price }
                    originalUnitPriceSet { shopMoney { amount } }
                  }
                  calculatedOrder {
                    lineItems(first: ${LINE_PAGE}) { nodes { ${CALCULATED_LINE_FIELDS} } }
                  }
                  userErrors { field message }
                }
              }
            `,
            {
              id: calculatedOrderId,
              variantId: target.variantId,
              quantity: qty,
            },
          );
          const addErrors = userErrorsFrom(addVariant, "orderEditAddVariant");
          applyLines(calculatedLinesFrom(addVariant, "orderEditAddVariant"));
          const fetchedAfterAdd = await fetchCalculatedLines(admin, calculatedOrderId);
          if (fetchedAfterAdd.length) lines = fetchedAfterAdd;
          const added = addVariant.data?.orderEditAddVariant?.calculatedLineItem;
          related = relatedProductLines(lines, target);
          fullUnit = targetFullUnit(target, related);
          catalogLines = catalogKeeperLines(related, target, fullUnit);
          keeper = pickCatalogKeeper(catalogLines, added?.id);
          if (addErrors.length) {
            errors.push(...addErrors);
            console.warn("Partial payment orderEditAddVariant:", addErrors);
          } else if (keeper && !lineLooksLikeDeposit(keeper, target, fullUnit)) {
            restored = true;
            didMutate = true;
          } else {
            console.warn("Partial payment orderEditAddVariant: no catalog-priced line", {
              title: target.title,
              addedId: added?.id || null,
              addedPrice: added ? lineUnitPrice(added) : null,
              fullUnit,
            });
          }
        }

        if (!restored && !keeper) {
          const addCatalog = await graphqlJson(
            admin,
            `#graphql
              mutation AddCatalogCustomItem($id: ID!, $title: String!, $quantity: Int!, $price: MoneyInput!) {
                orderEditAddCustomItem(
                  id: $id
                  title: $title
                  quantity: $quantity
                  price: $price
                  taxable: true
                  requiresShipping: true
                ) {
                  calculatedLineItem {
                    id
                    title
                    quantity
                    variant { id price }
                    originalUnitPriceSet { shopMoney { amount } }
                  }
                  calculatedOrder {
                    lineItems(first: ${LINE_PAGE}) { nodes { ${CALCULATED_LINE_FIELDS} } }
                  }
                  userErrors { field message }
                }
              }
            `,
            {
              id: calculatedOrderId,
              title: target.title || "Catalog price",
              quantity: qty,
              price: moneyInput(fullUnit, shopCurrency),
            },
          );
          const catalogErrors = userErrorsFrom(addCatalog, "orderEditAddCustomItem");
          applyLines(calculatedLinesFrom(addCatalog, "orderEditAddCustomItem"));
          const fetchedCustom = await fetchCalculatedLines(admin, calculatedOrderId);
          if (fetchedCustom.length) lines = fetchedCustom;
          if (catalogErrors.length) {
            errors.push(...catalogErrors);
            console.warn("Partial payment catalog custom item:", catalogErrors);
          } else {
            keeper = addCatalog.data?.orderEditAddCustomItem?.calculatedLineItem || keeper;
            if (keeper) didMutate = true;
          }
        }
      }

      related = relatedProductLines(lines, target);
      fullUnit = targetFullUnit(target, related);
      catalogLines = catalogKeeperLines(related, target, fullUnit);
      keeper = pickCatalogKeeper(catalogLines, keeper?.id);

      await applyZero(extraLinesToZero(related, keeper, target, fullUnit));

      related = relatedProductLines(lines, target);
      catalogLines = catalogKeeperLines(related, target, fullUnit);
      keeper = pickCatalogKeeper(catalogLines, keeper?.id);
      if (keeper && Number(keeper.quantity) !== qty) {
        await setLiveQuantity(keeper.id, qty);
      }
    }

    if (!didMutate) {
      console.warn("Partial payment order edit: no mutations, discarding calculated order", {
        orderId,
        targetCount: targets.length,
      });
      if (meta.restoreAttempted !== true || meta.restoreLockAt) {
        await writePartialPaymentMeta(admin, orderId, {
          ...meta,
          restoreAttempted: true,
          restoreLockAt: null,
        });
      }
      return { skipped: false, committed: false, attempted: true, reason: "no_changes", errors };
    }

    const commit = await graphqlJson(
      admin,
      `#graphql
        mutation CommitPartialPaymentOrderEdit($id: ID!, $staffNote: String) {
          orderEditCommit(id: $id, notifyCustomer: false, staffNote: $staffNote) {
            order { id }
            userErrors { field message }
          }
        }
      `,
      {
        id: calculatedOrderId,
        staffNote:
          "Admin only: catalog price restored on the product line. Checkout deposit was not changed.",
      },
    );
    const commitErrors = userErrorsFrom(commit, "orderEditCommit");
    if (commitErrors.length) {
      errors.push(...commitErrors);
      console.warn("Partial payment orderEditCommit:", commitErrors);
      await writePartialPaymentMeta(admin, orderId, {
        ...meta,
        restoreAttempted: true,
        restoreLockAt: null,
      });
      return { skipped: false, committed: false, attempted: true, errors };
    }

    await writePartialPaymentMeta(admin, orderId, {
      ...meta,
      orderEdited: true,
      restoreAttempted: true,
      restoreLockAt: null,
    });
    return { skipped: false, committed: true, errors };
  } catch (error) {
    await writePartialPaymentMeta(admin, orderId, {
      ...meta,
      restoreAttempted: true,
      restoreLockAt: null,
    });
    throw error;
  }
}
