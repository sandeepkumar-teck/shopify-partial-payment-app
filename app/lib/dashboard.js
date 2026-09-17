import {
  ATTR,
  TAGS,
  VISIBLE,
  formatMoney,
  orderStatusLabel,
  parseMoney,
  paymentFromProperties,
  productAllowsPartial,
  roundMoney,
  statusFromLabel,
} from "./partial-payment";
import { parseInvoiceSchedule } from "./invoice-schedule";

const APP_STATUSES = new Set([
  TAGS.partialPaid,
  TAGS.unpaidCod,
  TAGS.fullyPaid,
  TAGS.refunded,
]);

const IST = "Asia/Kolkata";

export const ORDERS_PAGE_SIZE = 15;

export function pageWindow(current, total) {
  if (!(total > 1)) return [Math.max(1, current || 1)];
  const pages = new Set([1, total, current, current - 1, current + 1]);
  return [...pages].filter((n) => n >= 1 && n <= total).sort((a, b) => a - b);
}

export const COLLECTION_PERIODS = [
  { id: "7d", days: 7, bucket: "day", label: "7 days", title: "7-day collections" },
  { id: "1m", days: 30, bucket: "day", label: "1 month", title: "1-month collections" },
  { id: "2m", days: 60, bucket: "week", label: "2 months", title: "2-month collections" },
  { id: "6m", days: 183, bucket: "month", label: "6 months", title: "6-month collections" },
];

function zonedDateParts(date, timeZone = IST) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(date);
  const map = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return { year: map.year, month: map.month, day: map.day };
}

function dayKey(date) {
  if (!(date instanceof Date) || Number.isNaN(date.getTime())) return "";
  const { year, month, day } = zonedDateParts(date);
  return `${year}-${month}-${day}`;
}

function shiftIsoDate(iso, days) {
  const [year, month, day] = String(iso)
    .split("-")
    .map((part) => Number(part));
  if (!year || !month || !day) return iso;
  const utc = new Date(Date.UTC(year, month - 1, day));
  utc.setUTCDate(utc.getUTCDate() + days);
  return utc.toISOString().slice(0, 10);
}

function mondayOf(iso) {
  const [year, month, day] = String(iso)
    .split("-")
    .map((part) => Number(part));
  const utc = new Date(Date.UTC(year, month - 1, day));
  const dow = utc.getUTCDay();
  const offset = dow === 0 ? -6 : 1 - dow;
  utc.setUTCDate(utc.getUTCDate() + offset);
  return utc.toISOString().slice(0, 10);
}

function utcNoon(isoDay) {
  const [year, month, day] = String(isoDay)
    .split("-")
    .map((part) => Number(part));
  return new Date(Date.UTC(year, month - 1, day || 1, 12));
}

function labelForIso(iso, kind) {
  const date = utcNoon(iso);
  if (kind === "weekday") {
    return date.toLocaleDateString("en-IN", { weekday: "short", timeZone: "UTC" });
  }
  if (kind === "month") {
    return date.toLocaleDateString("en-IN", { month: "short", timeZone: "UTC" });
  }
  return date.toLocaleDateString("en-IN", { day: "numeric", month: "short", timeZone: "UTC" });
}

function periodById(periodId) {
  return COLLECTION_PERIODS.find((item) => item.id === periodId) || COLLECTION_PERIODS[0];
}

function emptyBuckets(period) {
  const today = dayKey(new Date());
  const startIso = shiftIsoDate(today, -(period.days - 1));
  const buckets = [];

  if (period.bucket === "week") {
    let cursor = mondayOf(startIso);
    const endMonday = mondayOf(today);
    while (cursor <= endMonday) {
      buckets.push({
        date: cursor,
        label: labelForIso(cursor, "day"),
        payNow: 0,
        payCod: 0,
        orders: 0,
      });
      cursor = shiftIsoDate(cursor, 7);
    }
    return { buckets, startIso, today };
  }

  if (period.bucket === "month") {
    let year = Number(startIso.slice(0, 4));
    let month = Number(startIso.slice(5, 7));
    const endYear = Number(today.slice(0, 4));
    const endMonth = Number(today.slice(5, 7));
    while (year < endYear || (year === endYear && month <= endMonth)) {
      const key = `${year}-${String(month).padStart(2, "0")}`;
      buckets.push({
        date: key,
        label: labelForIso(`${key}-01`, "month"),
        payNow: 0,
        payCod: 0,
        orders: 0,
      });
      month += 1;
      if (month > 12) {
        month = 1;
        year += 1;
      }
    }
    return { buckets, startIso, today };
  }

  for (let i = period.days - 1; i >= 0; i -= 1) {
    const date = shiftIsoDate(today, -i);
    buckets.push({
      date,
      label: labelForIso(date, period.days <= 7 ? "weekday" : "day"),
      payNow: 0,
      payCod: 0,
      orders: 0,
    });
  }
  return { buckets, startIso, today };
}

function bucketKeyFor(iso, period) {
  if (period.bucket === "week") return mondayOf(iso);
  if (period.bucket === "month") return iso.slice(0, 7);
  return iso;
}

export function buildPeriodTrend(mappedOrders = [], periodId = "7d") {
  const period = periodById(periodId);
  const { buckets, startIso, today } = emptyBuckets(period);
  const trendMap = Object.fromEntries(buckets.map((row) => [row.date, row]));
  let payNow = 0;
  let payCod = 0;
  let orders = 0;

  for (const mapped of mappedOrders) {
    const created = new Date(mapped.createdAt);
    const iso = dayKey(created);
    if (!iso || iso < startIso || iso > today) continue;
    payNow = addMoney(payNow, mapped.payNow);
    payCod = addMoney(payCod, mapped.payCod);
    orders += 1;
    const key = bucketKeyFor(iso, period);
    const bucket = trendMap[key];
    if (!bucket) continue;
    bucket.payNow = addMoney(bucket.payNow, mapped.payNow);
    bucket.payCod = addMoney(bucket.payCod, mapped.payCod);
    bucket.orders += 1;
  }

  return {
    period,
    trend: buckets,
    window: { payNow, payCod, orders },
  };
}

export function formatDashboardDate(value, { withYear = false } = {}) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "—";
  const datePart = date.toLocaleDateString("en-IN", {
    timeZone: IST,
    day: "2-digit",
    month: "short",
    ...(withYear ? { year: "numeric" } : {}),
  });
  const timePart = date.toLocaleTimeString("en-IN", {
    timeZone: IST,
    hour: "2-digit",
    minute: "2-digit",
    hour12: true,
  });
  return `${datePart}\n${timePart}`;
}

export function shopifyOrderAdminUrl(shop, order) {
  const storeHandle = String(shop?.myshopifyDomain || "").replace(".myshopify.com", "");
  if (storeHandle && order?.numericId) {
    return `https://admin.shopify.com/store/${storeHandle}/orders/${order.numericId}`;
  }
  return `shopify://admin/orders/${order?.numericId || ""}`;
}

function firstNonEmpty(...values) {
  for (const value of values) {
    const text = String(value || "").trim();
    if (text) return text;
  }
  return "";
}

function personName(person) {
  if (!person || typeof person !== "object" || Array.isArray(person)) return "";
  return firstNonEmpty(
    person.displayName,
    person.formattedName,
    person.name,
    [person.firstName, person.lastName].filter(Boolean).join(" "),
    [person.first_name, person.last_name].filter(Boolean).join(" "),
  );
}

function emailLocalPart(email) {
  const text = String(email || "").trim();
  if (!text) return "";
  const at = text.indexOf("@");
  if (at <= 0) return text.includes("@") ? "" : text;
  return text.slice(0, at).trim();
}

function customerNameFromOrder(order) {
  if (!order || typeof order !== "object") return "";
  const customer = order.customer && typeof order.customer === "object" ? order.customer : {};
  const email =
    order.email ||
    order.contactEmail ||
    order.contact_email ||
    customer.email ||
    customer.defaultEmailAddress?.emailAddress ||
    customer.defaultEmailAddress?.email_address;
  return firstNonEmpty(
    personName(customer),
    [customer.firstName, customer.lastName].filter(Boolean).join(" "),
    order.customerName,
    order.customer_name,
    personName(order.shippingAddress),
    personName(order.shipping_address),
    personName(order.billingAddress),
    personName(order.billing_address),
    personName(order.displayAddress),
    [order.firstName, order.lastName].filter(Boolean).join(" "),
    emailLocalPart(email),
  );
}

const CORRUPT_ORDER_MONEY = 1e9;

/** Parse Shopify money / metafield amounts as numbers. Never return a string. */
function toMoney(value) {
  if (value == null || value === "") return 0;
  if (typeof value === "object") {
    if (Array.isArray(value)) return 0;
    // MoneyBag: use shop currency only — do not add presentmentMoney.
    if (value.shopMoney != null) return toMoney(value.shopMoney);
    if (value.amount != null) return toMoney(value.amount);
    return 0;
  }
  let parsed;
  if (typeof value === "number") {
    parsed = value;
  } else {
    const stripped = String(value).replace(/,/g, "").trim();
    parsed = parseFloat(stripped);
    if (!Number.isFinite(parsed)) parsed = Number(parseMoney(value));
  }
  return Number.isFinite(parsed) ? parsed : 0;
}

function isCorruptOrderMoney(value) {
  const amount = toMoney(value);
  return !Number.isFinite(amount) || Math.abs(amount) > CORRUPT_ORDER_MONEY;
}

function saneOrderMoney(value) {
  const amount = toMoney(value);
  if (!Number.isFinite(amount) || amount <= 0 || Math.abs(amount) > CORRUPT_ORDER_MONEY) return 0;
  return roundMoney(amount);
}

function addMoney(left, right) {
  const a = toMoney(left);
  const b = toMoney(right);
  return roundMoney((Number.isFinite(a) ? a : 0) + (Number.isFinite(b) ? b : 0));
}

function orderCatalogPrice(order, metafield, attrs = {}, payNow = 0, payCod = 0) {
  const shopAmount = toMoney(order?.currentTotalPriceSet?.shopMoney?.amount);
  const shopFallback = Number.isFinite(shopAmount) && Math.abs(shopAmount) <= CORRUPT_ORDER_MONEY ? roundMoney(shopAmount) : 0;
  const expected = addMoney(payNow, payCod);

  const candidates = [
    metafield && metafield.fullPrice != null && metafield.fullPrice !== "" ? metafield.fullPrice : null,
    attrs[VISIBLE.full],
    attrs.partial_full_price,
    attrs["Full price"],
  ];

  for (const candidate of candidates) {
    if (candidate == null || candidate === "") continue;
    if (isCorruptOrderMoney(candidate)) continue;
    const amount = saneOrderMoney(candidate);
    if (amount <= 0) continue;
    // Old concat bug stored "600"+"1899.90" as 6001899.90 — still below 1e9.
    if (expected > 0 && amount > expected * 100 && amount > 1e5) continue;
    return amount;
  }

  if (expected > 0 && !isCorruptOrderMoney(expected)) return roundMoney(expected);
  return shopFallback;
}

function parseMetafield(order) {
  const raw = order.metafield?.value;
  if (raw && typeof raw === "object") return raw;
  try {
    const parsed = JSON.parse(raw || "{}");
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function orderTags(order) {
  return (order.tags || []).map((tag) => String(tag).trim());
}

function attributeMap(order) {
  const map = {};
  for (const attr of order.customAttributes || []) {
    const key = attr.key || attr.name;
    if (key && map[key] == null) map[key] = attr.value;
  }
  for (const item of order.lineItems?.nodes || []) {
    for (const attr of item.customAttributes || []) {
      const key = attr.key || attr.name;
      if (key && map[key] == null) map[key] = attr.value;
    }
  }
  return map;
}

function metaAmount(metafield, keys) {
  for (const key of keys) {
    if (metafield[key] == null || metafield[key] === "") continue;
    const amount = toMoney(metafield[key]);
    if (Number.isFinite(amount) && Math.abs(amount) <= CORRUPT_ORDER_MONEY) return roundMoney(amount);
  }
  return null;
}

function firstPositive(...values) {
  for (const value of values) {
    if (value == null || value === "") continue;
    const amount = toMoney(value);
    if (amount > 0 && Math.abs(amount) <= CORRUPT_ORDER_MONEY) return roundMoney(amount);
  }
  return 0;
}

function hasPartialMarkers(attrs, linePayments) {
  if (linePayments.length) return true;
  const keys = [
    VISIBLE.payNow,
    VISIBLE.payCod,
    VISIBLE.full,
    VISIBLE.status,
    ATTR.payNow,
    ATTR.payCod,
    ATTR.full,
    ATTR.status,
    "Pay now",
    "Checkout charged",
    "Due on delivery",
    "partial_deposit",
    "partial_remaining_cod",
    "partial_full_price",
    "partial_payment_status",
    "pay_now",
  ];
  return keys.some((key) => attrs[key] != null && attrs[key] !== "");
}

function surchargeFromDashboardLines(order) {
  let total = 0;
  for (const item of order.lineItems?.nodes || []) {
    const attrs = item.customAttributes || [];
    const isSurcharge = attrs.some(
      (attr) =>
        (attr.key === ATTR.surcharge || attr.key === "_cod_surcharge") && String(attr.value) === "1",
    );
    if (!isSurcharge) continue;
    const qty = Number(item.quantity) || 1;
    const unit = toMoney(
      item.originalUnitPriceSet?.shopMoney?.amount ?? item.discountedUnitPriceSet?.shopMoney?.amount,
    );
    if (unit > 0) total = addMoney(total, unit * qty);
  }
  return total;
}

function unpaidCodDueAmount(payCod, fullPrice, surcharge) {
  const stored = roundMoney(toMoney(payCod));
  const catalog = roundMoney(toMoney(fullPrice));
  const extra = roundMoney(toMoney(surcharge));
  const fromCatalog = addMoney(catalog > 0 ? catalog : stored, extra);
  if (stored + 0.009 >= fromCatalog && fromCatalog > 0) return stored;
  if (fromCatalog > stored) return fromCatalog;
  return addMoney(stored, extra);
}

function classifyDashboardStatus({
  tags,
  metafield,
  financial,
  payNow,
  payCod,
  fullPrice,
  surcharge = 0,
  looksUnpaid = false,
  currentTotal = 0,
  outstanding = 0,
  captured = 0,
}) {
  const metaStatus = metafield.status ? statusFromLabel(metafield.status) : "";
  const extraPaidAsPayNow = Number(payNow) > 0 && Number(surcharge) > 0;
  const codDue = extraPaidAsPayNow
    ? roundMoney(Number(payCod || 0))
    : roundMoney(Number(payCod || 0) + Number(surcharge || 0));
  const remaining =
    codDue > 0 ? codDue : roundMoney(Math.max(0, Number(fullPrice || 0) - Number(payNow || 0)));
  const expectedFull = roundMoney(
    Math.max(Number(fullPrice || 0), Number(payNow || 0) + remaining),
  );
  const looksDepositOnly =
    expectedFull > 0 &&
    Number(currentTotal || 0) + 1 < expectedFull &&
    (Number(captured || 0) <= 0.009 || Number(captured || 0) + 1 < expectedFull);
  const invoiceCollectedRemaining =
    financial === "PAID" &&
    outstanding <= 0.009 &&
    remaining > 0.009 &&
    expectedFull > 0 &&
    !looksDepositOnly;

  if (tags.includes(TAGS.refunded) || metaStatus === TAGS.refunded || financial === "REFUNDED") {
    return "refunded";
  }
  if (tags.includes(TAGS.fullyPaid) || metaStatus === TAGS.fullyPaid || invoiceCollectedRemaining) {
    return "fully_paid";
  }
  if (tags.includes(TAGS.unpaidCod) || metaStatus === TAGS.unpaidCod || looksUnpaid) {
    if (!(Number(payNow) > 0)) return "unpaid_cod";
  }
  if (Number(payNow) <= 0 && remaining > 0 && (tags.includes(TAGS.unpaidCod) || metaStatus === TAGS.unpaidCod)) {
    return "unpaid_cod";
  }
  if (Number(payNow) <= 0 && remaining > 0 && Number(surcharge) > 0) {
    return "unpaid_cod";
  }
  if (
    remaining <= 0 &&
    financial !== "PARTIALLY_PAID" &&
    metaStatus !== TAGS.unpaidCod &&
    metaStatus !== TAGS.refunded
  ) {
    const collected =
      metafield.payCod != null ||
      metaStatus === TAGS.fullyPaid ||
      tags.includes(TAGS.fullyPaid) ||
      Number(payNow) > 0;
    if (collected) return "fully_paid";
  }
  if (
    tags.includes(TAGS.partialPaid) ||
    metaStatus === TAGS.partialPaid ||
    financial === "PARTIALLY_PAID" ||
    remaining > 0
  ) {
    return "partial_paid";
  }
  return "partial_paid";
}

function isAppDashboardOrder({ tags, metafield, financial, payCod, attrs, linePayments }) {
  if (tags.some((tag) => APP_STATUSES.has(tag))) return true;
  if (APP_STATUSES.has(String(metafield.status || ""))) return true;
  if (
    metafield.payNow != null ||
    metafield.payCod != null ||
    metafield.fullPrice != null ||
    metafield.productDeposit != null ||
    metafield.checkoutCharged != null
  ) {
    return true;
  }
  if (financial === "PARTIALLY_PAID") return true;
  if (Number(payCod) > 0) return true;
  return hasPartialMarkers(attrs, linePayments);
}

export function mapDashboardOrder(order) {
  const metafield = parseMetafield(order);
  const attrs = attributeMap(order);
  const tags = orderTags(order);
  const financial = String(order.displayFinancialStatus || order.financialStatus || "").toUpperCase();
  const currentTotal = roundMoney(toMoney(order.currentTotalPriceSet?.shopMoney?.amount));
  const outstanding = roundMoney(toMoney(order.totalOutstandingSet?.shopMoney?.amount));
  const captured = roundMoney(
    toMoney(order.totalReceivedSet?.shopMoney?.amount ?? order.netPaymentSet?.shopMoney?.amount),
  );

  const linePayments = (order.lineItems?.nodes || [])
    .map((item) => {
      const payment = paymentFromProperties(item.customAttributes || []);
      if (!payment) return null;
      return {
        ...payment,
        title: item.title,
        image: item.image?.url || "",
      };
    })
    .filter(Boolean);
  const amountLines = linePayments.filter((line) => !line.isInfo);
  const linePayNow = amountLines.reduce((sum, line) => {
    const extra = Number(line.payNow) > 0 ? 0 : Number(line.surcharge || 0);
    return addMoney(sum, addMoney(line.payNow, extra));
  }, 0);
  const linePayCod = amountLines.reduce((sum, line) => addMoney(sum, line.payCod), 0);

  let payNow = metaAmount(metafield, ["productDeposit", "payNow", "checkoutCharged"]);
  if (payNow == null) {
    payNow = firstPositive(attrs[VISIBLE.payNow], attrs["Checkout charged"], attrs.partial_deposit, attrs[ATTR.payNow], linePayNow);
  }

  let payCod = metaAmount(metafield, ["payCod", "remainingCod", "remaining"]);
  if (payCod == null) {
    payCod = firstPositive(
      attrs[VISIBLE.payCod],
      attrs["Due on delivery"],
      attrs.partial_remaining_cod,
      attrs[ATTR.payCod],
      linePayCod,
    );
  }

  payNow = roundMoney(toMoney(payNow));
  payCod = roundMoney(toMoney(payCod));
  const lineSurcharge = amountLines.reduce((sum, line) => addMoney(sum, line.surcharge), 0);
  const productSurcharge = surchargeFromDashboardLines(order);
  const surcharge = roundMoney(
    toMoney(
      metaAmount(metafield, ["surcharge"]) ??
        metafield.surcharge ??
        (lineSurcharge > 0 ? lineSurcharge : productSurcharge),
    ),
  );

  // Filter BEFORE inferring remaining COD from catalog − payNow.
  // That inference would treat every regular paid order as unpaid COD and
  // inflate Order Value with the whole store catalog.
  if (!isAppDashboardOrder({ tags, metafield, financial, payCod, attrs, linePayments })) {
    return null;
  }

  const fullPrice = orderCatalogPrice(order, metafield, attrs, payNow, payCod);

  if ((payCod == null || payCod === 0) && metafield.payCod == null && fullPrice > payNow) {
    payCod = roundMoney(toMoney(fullPrice) - toMoney(payNow));
  }

  payNow = roundMoney(toMoney(payNow));
  payCod = roundMoney(toMoney(payCod));

  const looksUnpaid =
    Number(payNow) <= 0 &&
    (String(attrs.partial_payment_status || attrs.Status || "").toLowerCase().includes("unpaid") ||
      amountLines.some((line) => {
        const text = String(line.status || "").toLowerCase();
        return Number(line.payNow || 0) <= 0 && (text === "unpaid_cod" || text.includes("unpaid"));
      }));
  if (looksUnpaid && financial !== "PAID" && financial !== "REFUNDED") {
    payNow = 0;
  }

  const status = classifyDashboardStatus({
    tags,
    metafield,
    financial,
    payNow,
    payCod,
    fullPrice,
    surcharge,
    looksUnpaid: looksUnpaid && financial !== "PAID" && financial !== "REFUNDED",
    currentTotal,
    outstanding,
    captured,
  });
  const isUnpaidCod = status === "unpaid_cod";
  if (isUnpaidCod) {
    payNow = 0;
  }
  const lineFull = amountLines.reduce((sum, line) => addMoney(sum, line.fullPrice), 0);
  const catalogForDue = lineFull > 0 ? lineFull : fullPrice;
  const extraOnProductLines = lineSurcharge > 0;
  const codBalance = isUnpaidCod
    ? extraOnProductLines
      ? roundMoney(payCod > 0 ? payCod : catalogForDue)
      : unpaidCodDueAmount(payCod, catalogForDue, surcharge)
    : payCod;
  const dueCod = status === "fully_paid" || status === "refunded" ? 0 : codBalance;
  const collectedCod =
    status === "fully_paid"
      ? roundMoney(payCod > 0 ? payCod : Math.max(0, fullPrice - payNow))
      : 0;
  const customer = customerNameFromOrder(order);
  const invoice = parseInvoiceSchedule(metafield);

  return {
    id: order.id,
    numericId: String(order.id || "").split("/").pop(),
    name: order.name,
    createdAt: order.createdAt,
    cancelledAt: order.cancelledAt || null,
    customer,
    status,
    statusLabel: orderStatusLabel(status),
    payNow,
    payCod: dueCod,
    collectedCod,
    fullPrice,
    remainingCod: dueCod,
    lines: amountLines.length ? amountLines : linePayments,
    ...invoice,
  };
}

export function buildDashboardStats(orders = [], settings) {
  const counts = { partial_paid: 0, unpaid_cod: 0, fully_paid: 0, refunded: 0, codCollected: 0 };
  let collected = 0;
  let remaining = 0;
  let fullPrice = 0;
  let codCollectedAmount = 0;
  const recent = [];
  const list = Array.isArray(orders) ? orders : [];

  for (const order of list) {
    const mapped = mapDashboardOrder(order);
    if (!mapped) continue;

    if (!counts[mapped.status]) counts[mapped.status] = 0;
    counts[mapped.status] += 1;
    if (mapped.status === "fully_paid") {
      counts.codCollected += 1;
      codCollectedAmount = addMoney(codCollectedAmount, mapped.collectedCod);
    }
    collected = addMoney(collected, mapped.payNow);
    remaining = addMoney(remaining, mapped.payCod);
    fullPrice = addMoney(fullPrice, mapped.fullPrice);
    recent.push(mapped);
  }

  const { trend } = buildPeriodTrend(recent, "7d");
  const totalOrders = recent.length;
  const paidOnline = toMoney(collected);
  const orderValue = toMoney(fullPrice);
  const collectionRate = orderValue > 0 ? Math.round((paidOnline / orderValue) * 100) : 0;
  const symbol = settings?.currencySymbol || "₹";

  return {
    totals: {
      orders: totalOrders,
      collected,
      remaining,
      fullPrice,
      collectionRate,
      currency: symbol,
    },
    analytics: {
      totalPartialOrders: totalOrders,
      totalPaid: collected,
      totalCodOutstanding: remaining,
      fullyPaid: counts.fully_paid || 0,
      partiallyPaid: counts.partial_paid || 0,
      codCollected: counts.codCollected || 0,
      codCollectedAmount,
      collectionRate,
    },
    counts,
    trend,
    recent,
    formatted: {
      collected: formatMoney(collected, symbol),
      remaining: formatMoney(remaining, symbol),
      fullPrice: formatMoney(fullPrice, symbol),
      orderValue: formatMoney(fullPrice, symbol),
      totalPaid: formatMoney(collected, symbol),
      totalCodOutstanding: formatMoney(remaining, symbol),
      codCollected: formatMoney(codCollectedAmount, symbol),
    },
  };
}

export function countProductRules(products = [], settings = {}) {
  const counts = { fixed: 0, percent25: 0, percent50: 0, custom: 0, disabled: 0 };
  let configured = 0;
  for (const product of products) {
    const config = product?.config || {};
    if (config.configured) configured += 1;
    const off = !productAllowsPartial(config, settings, {
      collectionIds: product?.collectionIds,
      tags: product?.tags,
    });
    if (off) {
      counts.disabled += 1;
      continue;
    }
    const type = config.useShopRule ? settings.payRuleType : config.payRuleType;
    const percent = Number(config.useShopRule ? settings.percent : config.percent);
    if (type === "custom") counts.custom += 1;
    else if (type === "percent" && percent === 50) counts.percent50 += 1;
    else if (type === "percent") counts.percent25 += 1;
    else counts.fixed += 1;
  }
  return configured ? counts : null;
}
