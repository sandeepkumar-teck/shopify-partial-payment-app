import { scheduledActionForProduct, activeScheduledEnableRule, isScheduleFullyCod } from "./scheduled-rules";

export const FIXED_DEPOSIT_AMOUNT = 500;

export const DEFAULT_SETTINGS = {
  enabled: true,
  productScope: "all",
  allProductsEnabled: true,
  ruleCollectionIds: [],
  ruleTags: [],
  depositOptions: [FIXED_DEPOSIT_AMOUNT],
  payRuleType: "fixed",
  fixedAmount: FIXED_DEPOSIT_AMOUNT,
  percent: 25,
  customAmount: 0,
  surcharge: 500,
  fullyCodEnabled: true,
  currencySymbol: "₹",
  note: "No EMI available for COD orders. Remaining payment must be paid to the delivery partner.",
  productOverrides: {},
};

export const DISCOUNT_TITLE = "Partial payment remaining on COD";

/** Detect leftover Admin custom lines from older restores. New orders do not add this line. */
export const ADMIN_PARTIAL_PAYMENT_LINE_TITLE = "Partial payment";

export const ATTR = {
  description: "description",
  visible: "Partial payment",
  payNow: "_partial_pay_now",
  payCod: "_partial_pay_cod",
  full: "_partial_full",
  status: "_partial_status",
  surcharge: "_cod_surcharge",
  info: "_partial_info",
  surchargeAmount: "_partial_surcharge",
  unit: "_partial_unit",
  depositUnit: "_partial_deposit_unit",
};

export const VISIBLE = {
  payNow: "Pay now",
  payCod: "Remaining COD",
  full: "Full price",
  status: "Status",
  surcharge: "COD extra",
};

export const PRODUCT_METAFIELD = {
  namespace: "$app",
  key: "partial_payment",
};

export const TAGS = {
  partialPaid: "partial_paid",
  unpaidCod: "unpaid_cod",
  fullyPaid: "fully_paid",
  refunded: "refunded",
};

export const SETTINGS_METAFIELD = {
  namespace: "$app",
  key: "partial_payment",
};

function numberOr(value, fallback) {
  if (value == null || value === "") return fallback;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

export function variantNumericIdFromGid(gid) {
  if (!gid) return "";
  const match = String(gid).match(/ProductVariant\/(\d+)/i);
  if (match) return match[1];
  const digits = String(gid).replace(/\D/g, "");
  return digits || "";
}

export function defaultFullyCodEnabled(settings = DEFAULT_SETTINGS) {
  return Number(settings?.surcharge || 0) > 0;
}

export function parsePayRuleType(value) {
  const raw = String(value || "fixed").toLowerCase();
  if (raw === "percent" || raw === "percentage") return "percent";
  if (raw === "custom") return "custom";
  return "fixed";
}

export function isShopDefaultRule(value) {
  const raw = String(value || "").toLowerCase();
  return !raw || raw === "shop" || raw === "default" || raw === "use_shop" || raw === "use shop default";
}

export function collectionNumericId(id) {
  if (id == null || id === "") return "";
  const match = String(id).match(/Collection\/(\d+)/i);
  if (match) return match[1];
  const digits = String(id).replace(/\D/g, "");
  return digits || "";
}

export function normalizeRuleCollectionIds(value) {
  const list = Array.isArray(value) ? value : value == null || value === "" ? [] : [value];
  const seen = new Set();
  const out = [];
  for (const item of list) {
    const numeric = collectionNumericId(item);
    if (!numeric || seen.has(numeric)) continue;
    seen.add(numeric);
    const raw = String(item).trim();
    out.push(raw.includes("gid://") ? raw : `gid://shopify/Collection/${numeric}`);
  }
  return out;
}

export function normalizeRuleTags(value) {
  const list = Array.isArray(value)
    ? value
    : String(value || "")
        .split(",")
        .map((item) => item.trim());
  const seen = new Set();
  const out = [];
  for (const item of list) {
    const tag = String(item || "").trim().toLowerCase();
    if (!tag || seen.has(tag)) continue;
    seen.add(tag);
    out.push(tag);
  }
  return out;
}

export function resolveProductScope(parsed = {}) {
  const raw = String(parsed.productScope || "").toLowerCase();
  if (raw === "selected" || raw === "collection" || raw === "tag") return raw;
  const allOn = parseLooseBoolean(parsed.allProductsEnabled, true);
  const collections = normalizeRuleCollectionIds(parsed.ruleCollectionIds);
  const tags = normalizeRuleTags(parsed.ruleTags);
  if (raw === "all" && allOn) return "all";
  if (!allOn && collections.length) return "collection";
  if (!allOn && tags.length) return "tag";
  if (allOn) return "all";
  return "selected";
}

export function productMatchesShopTargeting(shopSettings = DEFAULT_SETTINGS, match = {}) {
  const shop = parseSettings(shopSettings);
  const scope = resolveProductScope(shop);
  const ruleIds = new Set((shop.ruleCollectionIds || []).map(collectionNumericId).filter(Boolean));
  const ruleTags = new Set(shop.ruleTags || []);
  const productIds = (match.collectionIds || match.collections || []).map(collectionNumericId);
  const productTags = (match.tags || [])
    .map((tag) => String(tag || "").trim().toLowerCase())
    .filter(Boolean);
  if (scope === "collection") {
    return ruleIds.size > 0 && productIds.some((id) => ruleIds.has(id));
  }
  if (scope === "tag") {
    return ruleTags.size > 0 && productTags.some((tag) => ruleTags.has(tag));
  }
  if (scope === "all") return true;
  return false;
}

function parseLooseBoolean(value, fallback = true) {
  if (value === false || value === "false" || value === 0 || value === "0") return false;
  if (value === true || value === "true" || value === 1 || value === "1") return true;
  if (value == null || value === "") return fallback;
  return fallback;
}

export function parseSettings(value) {
  try {
    const parsed = typeof value === "string" ? JSON.parse(value || "{}") : value || {};
    const payRuleType = parsePayRuleType(parsed.payRuleType || parsed.ruleType || parsed.rule);
    const percent = Math.min(100, Math.max(0, numberOr(parsed.percent, DEFAULT_SETTINGS.percent)));
    const surcharge = numberOr(parsed.surcharge, DEFAULT_SETTINGS.surcharge);
    return {
      enabled: parsed.enabled !== false,
      productScope: resolveProductScope(parsed),
      allProductsEnabled: resolveProductScope(parsed) === "all",
      ruleCollectionIds: normalizeRuleCollectionIds(parsed.ruleCollectionIds),
      ruleTags: normalizeRuleTags(parsed.ruleTags),
      depositOptions: [FIXED_DEPOSIT_AMOUNT],
      payRuleType,
      fixedAmount: FIXED_DEPOSIT_AMOUNT,
      percent: percent > 0 ? percent : DEFAULT_SETTINGS.percent,
      customAmount: numberOr(parsed.customAmount, DEFAULT_SETTINGS.customAmount),
      surcharge,
      fullyCodEnabled:
        parsed.fullyCodEnabled === false ? false : defaultFullyCodEnabled({ surcharge }),
      currencySymbol: parsed.currencySymbol || DEFAULT_SETTINGS.currencySymbol,
      note: parsed.note || DEFAULT_SETTINGS.note,
      surchargeVariantId: parsed.surchargeVariantId || "",
      surchargeVariantNumericId:
        parsed.surchargeVariantNumericId ||
        variantNumericIdFromGid(parsed.surchargeVariantId || ""),
      surchargeProductId: parsed.surchargeProductId || "",
      discountId: parsed.discountId || "",
      functionId: parsed.functionId || "",
      cartTransformId: parsed.cartTransformId || "",
      paymentCustomizationId: parsed.paymentCustomizationId || "",
      productOverrides: parseProductOverrides(parsed.productOverrides),
    };
  } catch {
    return {
      ...DEFAULT_SETTINGS,
      surchargeVariantId: "",
      surchargeVariantNumericId: "",
      surchargeProductId: "",
      discountId: "",
      functionId: "",
      cartTransformId: "",
      paymentCustomizationId: "",
      productOverrides: {},
    };
  }
}

export function parseProductOverrides(raw) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
  const out = {};
  Object.entries(raw).forEach(([key, value]) => {
    const id = String(key || "").replace(/\D/g, "");
    if (!id || !value || typeof value !== "object" || Array.isArray(value)) return;
    const payRuleType = isShopDefaultRule(value.payRuleType)
      ? "shop"
      : parsePayRuleType(value.payRuleType);
    out[id] = {
      enabled: value.enabled === true || value.partialEnabled === true,
      partialEnabled: value.enabled === true || value.partialEnabled === true,
      explicitOff: value.explicitOff === true,
      payRuleType,
      fixedAmount:
        payRuleType === "fixed"
          ? FIXED_DEPOSIT_AMOUNT
          : value.fixedAmount == null || value.fixedAmount === ""
          ? null
          : numberOr(value.fixedAmount, null),
      percent: value.percent == null || value.percent === "" ? null : numberOr(value.percent, null),
      customAmount:
        value.customAmount == null || value.customAmount === ""
          ? null
          : numberOr(value.customAmount, null),
    };
  });
  return out;
}

export function compactProductOverride(config = {}) {
  const payRuleType = isShopDefaultRule(config.payRuleType)
    ? "shop"
    : parsePayRuleType(config.payRuleType);
  return {
    enabled: Boolean(config.enabled || config.partialEnabled),
    partialEnabled: Boolean(config.enabled || config.partialEnabled),
    explicitOff: Boolean(config.explicitOff),
    payRuleType,
    fixedAmount:
      payRuleType === "fixed"
        ? FIXED_DEPOSIT_AMOUNT
        : config.fixedAmount == null || config.fixedAmount === ""
          ? null
          : Number(config.fixedAmount),
    percent: config.percent == null || config.percent === "" ? null : Number(config.percent),
    customAmount:
      config.customAmount == null || config.customAmount === "" ? null : Number(config.customAmount),
  };
}

export function parseProductConfig(value, shopSettings = DEFAULT_SETTINGS) {
  const fallback = {
    enabled: false,
    partialEnabled: false,
    explicitOff: false,
    configured: false,
    payRuleType: "shop",
    useShopRule: true,
    fixedAmount: null,
    percent: null,
    customAmount: null,
    depositOptions: shopSettings.depositOptions,
    useShopDeposits: true,
    surcharge: shopSettings.surcharge,
    useShopSurcharge: true,
    fullyCodEnabled: null,
    skus: [],
  };
  try {
    const parsed = typeof value === "string" ? JSON.parse(value || "{}") : value || {};
    const hasValue = Boolean(value) && value !== "{}" && value !== "null";
    const customOptions = (parsed.depositOptions || [])
      .map((n) => Number(n))
      .filter((n) => n > 0);
    const enabled = parsed.enabled === true || parsed.partialEnabled === true;
    const explicitOff =
      !enabled && (parsed.enabled === false || parsed.partialEnabled === false);
    const useShopRule = isShopDefaultRule(parsed.payRuleType);
    return {
      enabled,
      partialEnabled: enabled,
      explicitOff,
      configured: hasValue,
      payRuleType: useShopRule ? "shop" : parsePayRuleType(parsed.payRuleType),
      useShopRule,
      fixedAmount:
        !useShopRule && parsePayRuleType(parsed.payRuleType) === "fixed"
          ? FIXED_DEPOSIT_AMOUNT
          : parsed.fixedAmount == null || parsed.fixedAmount === ""
          ? null
          : numberOr(parsed.fixedAmount, null),
      percent: parsed.percent == null || parsed.percent === "" ? null : numberOr(parsed.percent, null),
      customAmount:
        parsed.customAmount == null || parsed.customAmount === ""
          ? null
          : numberOr(parsed.customAmount, null),
      depositOptions: customOptions.length ? customOptions : shopSettings.depositOptions,
      useShopDeposits: !customOptions.length,
      surcharge:
        parsed.surcharge == null || parsed.surcharge === ""
          ? shopSettings.surcharge
          : Number(parsed.surcharge),
      useShopSurcharge: parsed.surcharge == null || parsed.surcharge === "",
      fullyCodEnabled:
        parsed.fullyCodEnabled == null || parsed.fullyCodEnabled === ""
          ? null
          : parsed.fullyCodEnabled !== false,
      skus: Array.isArray(parsed.skus)
        ? parsed.skus.map((sku) => String(sku).trim()).filter(Boolean)
        : [],
    };
  } catch {
    return fallback;
  }
}

export function productAllowsPartial(
  config,
  shopSettings = DEFAULT_SETTINGS,
  match = {},
  scheduleContext = null,
) {
  const rules = scheduleContext?.rules || null;
  const now = scheduleContext?.now;
  const productMatch = {
    productId: match.productId || match.id,
    handle: match.handle,
    tags: match.tags,
    collectionIds: match.collectionIds || match.collections,
  };
  const scheduleAction =
    scheduleContext?.action ?? (rules ? scheduledActionForProduct(rules, productMatch, now) : null);

  if (scheduleAction === "disable_partial") return false;

  const shop = parseSettings(shopSettings);
  const enabled = Boolean(config?.enabled || config?.partialEnabled);
  if (config?.explicitOff) return false;
  // Raw metafields (no explicitOff field): only skip when enabled/partialEnabled is literally false.
  if (config && config.explicitOff !== true && config.explicitOff !== false) {
    if (config.enabled === false || config.partialEnabled === false) return false;
  }
  if (shop.productScope === "selected") return enabled;

  // Enable schedules add eligibility for matched targets even when All products is OFF.
  // They never override a product the merchant turned Off.
  if (scheduleAction === "enable_partial") {
    if (shop.enabled === false) return false;
    return true;
  }

  if (enabled) return true;
  const scope = resolveProductScope(shop);
  if (scope === "all") return true;
  return productMatchesShopTargeting(shop, match);
}

export function productAllowsFullyCod(config, shopSettings = DEFAULT_SETTINGS, match = {}, scheduleContext = null) {
  if (!productAllowsPartial(config, shopSettings, match, scheduleContext)) return false;
  const rules = scheduleContext?.rules || null;
  const productMatch = {
    productId: match.productId || match.id,
    handle: match.handle,
    tags: match.tags,
    collectionIds: match.collectionIds || match.collections,
  };
  const scheduled = rules ? activeScheduledEnableRule(rules, productMatch, scheduleContext?.now) : null;
  if (scheduled && isScheduleFullyCod(scheduled)) {
    return Number(scheduled.fullyCodExtra ?? scheduled.surcharge ?? 0) > 0;
  }
  const shop = parseSettings(shopSettings);
  if (!shop.fullyCodEnabled || !(Number(shop.surcharge) > 0)) return false;
  if (config?.fullyCodEnabled === false) return false;
  return true;
}

/**
 * Pay-now for a catalog total. Never exceeds total.
 * Result ≤ 0 means treat as full payment / hide partial.
 */
export function depositForCartTotal(catalogTotal, settings = DEFAULT_SETTINGS) {
  const total = roundMoney(Math.max(0, Number(catalogTotal) || 0));
  if (!(total > 0)) return 0;
  const rule = parseSettings(settings);
  const type = parsePayRuleType(rule.payRuleType);
  let amount = 0;
  if (type === "percent") {
    const percent = Number(rule.percent) > 0 ? Number(rule.percent) : 25;
    amount = roundMoney(total * (percent / 100));
  } else if (type === "custom") {
    amount = roundMoney(Number(rule.customAmount) || 0);
  } else {
    amount = FIXED_DEPOSIT_AMOUNT;
  }
  if (!(amount > 0) || amount >= total) return 0;
  return amount;
}

export function formatPayRule(settings = DEFAULT_SETTINGS, symbol = "₹") {
  const rule = parseSettings(settings);
  const type = parsePayRuleType(rule.payRuleType);
  if (type === "percent") {
    return `${Number(rule.percent) > 0 ? rule.percent : 25}% of eligible cart total`;
  }
  if (type === "custom") {
    return `Custom ${formatMoney(rule.customAmount || 0, symbol)} now`;
  }
  return `Fixed ${formatMoney(FIXED_DEPOSIT_AMOUNT, symbol)} now`;
}

/** Banner copy used on Settings / Products / Dashboard. Do not change eligibility math. */
export function formatShopActiveRule(settings = DEFAULT_SETTINGS, symbol = "₹", extras = {}) {
  const shop = parseSettings(settings);
  const scope = resolveProductScope(shop);
  let scopeLabel = "All products";
  let scopeDetail = "Whole catalog, except products you turn Off.";
  if (scope === "selected") {
    scopeLabel = "Enabled SKUs only";
    scopeDetail = "Only products you turn Partial on.";
  } else if (scope === "collection") {
    const title = String(extras.collectionTitle || "").trim();
    const count = (shop.ruleCollectionIds || []).length;
    scopeLabel = title ? `Collection only: ${title}` : count === 1 ? "One collection only" : `${count || 0} collections only`;
    scopeDetail = "Only products in this collection.";
  } else if (scope === "tag") {
    const tags = shop.ruleTags || [];
    scopeLabel = tags.length ? `Tags only: ${tags.join(", ")}` : "Tags only";
    scopeDetail = "Only products with these tags.";
  }
  return {
    headline: formatPayRule(shop, symbol),
    scope: scopeLabel,
    mode: scope,
    detail: scopeDetail,
    meta: `${scopeLabel} · COD extra ${formatMoney(shop.surcharge, symbol)}${
      shop.fullyCodEnabled ? " · FULLY COD on" : " · FULLY COD off"
    }`,
  };
}

export function needsPartialPaymentSetup(settings) {
  return !settings?.cartTransformId;
}

/**
 * Amount model:
 * - One product line. Cart transform `lineExpand` sets unit price to the selected deposit (or FULLY COD extra).
 * - Do not use `lineUpdate` as the live charge path — it does not change checkout unit price.
 * - Do not use product discounts (they strike through catalog price).
 * - FULLY COD: checkout charges extra only; Admin restore and Full price stay at catalog.
 * - Visible properties: Pay now, Remaining COD, Full price, Status, and COD extra when a share applies.
 */
export function roundMoney(value) {
  return Math.round(Number(value) * 100) / 100;
}

export function formatMoney(amount, symbol = "₹") {
  return `${symbol}${Number(amount).toLocaleString("en-IN", {
    maximumFractionDigits: 2,
    minimumFractionDigits: Number(amount) % 1 === 0 ? 0 : 2,
  })}`;
}

export const FULLY_PAID_NOTE_MARKER = "Status: Fully paid.";
export const COLLECTED_VIA = {
  cod: "COD collected",
  invoice: "Invoice paid",
};

export function hasFullyPaidOrderNote(note) {
  return String(note || "").includes(FULLY_PAID_NOTE_MARKER);
}

export function upsertCustomAttributes(existing = [], updates = []) {
  const next = [];
  const seen = new Set();
  const updateMap = new Map();
  for (const attr of updates || []) {
    const key = attr?.key || attr?.name;
    if (!key || updateMap.has(key)) continue;
    updateMap.set(key, String(attr.value ?? ""));
  }
  for (const attr of existing || []) {
    const key = attr?.key || attr?.name;
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

export function orderAttributesAlreadyFullyPaid(listOrMap = []) {
  const attrs = Array.isArray(listOrMap)
    ? Object.fromEntries(
        (listOrMap || [])
          .filter((attr) => attr && (attr.name || attr.key))
          .map((attr) => [attr.name || attr.key, attr.value]),
      )
    : listOrMap && typeof listOrMap === "object"
      ? listOrMap
      : {};
  const status = String(attrs.partial_payment_status || "")
    .trim()
    .toLowerCase();
  if (status === "fully_paid") return true;
  const label = String(attrs.Status || "")
    .trim()
    .toLowerCase();
  return label === "fully paid";
}

export function buildFullyPaidCustomAttributeUpdates({ remaining = 0, markedAt = new Date() } = {}) {
  return [
    { key: "partial_payment_status", value: "fully_paid" },
    { key: "Status", value: "Fully paid" },
    { key: "Due on delivery", value: "0" },
    { key: "partial_remaining_cod", value: "0" },
    { key: "Remaining collected", value: String(roundMoney(Number(remaining) || 0)) },
    { key: "Marked fully paid", value: formatFullyPaidNoteIst(markedAt) },
  ];
}

export function formatFullyPaidNoteIst(date = new Date()) {
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

export function buildFullyPaidOrderNote({
  payNow = 0,
  payCod = 0,
  fullPrice = 0,
  checkoutCharged = 0,
  collectedVia = COLLECTED_VIA.cod,
  markedAt = new Date(),
} = {}) {
  const now = roundMoney(Number(payNow) || 0);
  const remaining = roundMoney(Number(payCod) || 0);
  const full = roundMoney(Number(fullPrice) || 0);
  const charged = roundMoney(Number(checkoutCharged) || now);
  const via = collectedVia === COLLECTED_VIA.invoice ? COLLECTED_VIA.invoice : COLLECTED_VIA.cod;
  return [
    FULLY_PAID_NOTE_MARKER,
    `At checkout: Pay now ${formatMoney(now)}. Remaining COD ${formatMoney(remaining)}. Full ${formatMoney(full)}. Charged ${formatMoney(charged)}.`,
    `Remaining collected: ${formatMoney(remaining)}.`,
    `Collected via: ${via}`,
    `Marked fully paid: ${formatFullyPaidNoteIst(markedAt)}`,
  ].join("\n");
}

export function parseMoney(value) {
  if (value == null || value === "") return 0;
  if (typeof value === "number") return Number.isFinite(value) ? value : 0;
  if (typeof value === "object") {
    return parseMoney(
      value.amount ?? value.shop_money?.amount ?? value.shopMoney?.amount ?? "",
    );
  }
  const cleaned = String(value).replace(/[^0-9.-]/g, "");
  const parsed = Number(cleaned);
  return Number.isFinite(parsed) ? parsed : 0;
}

export function statusFromLabel(label) {
  const raw = String(label || "").trim();
  if (raw === "unpaid_cod" || raw === "partial_paid" || raw === "fully_paid" || raw === "refunded") {
    return raw;
  }
  const text = raw.toLowerCase();
  if (text.includes("refund")) return "refunded";
  if (text.includes("unpaid")) return "unpaid_cod";
  if (text === "paid" || text.includes("fully")) return "fully_paid";
  return "partial_paid";
}

export function orderStatusLabel(status) {
  if (status === "fully_paid") return "Paid";
  if (status === "unpaid_cod") return "Unpaid (COD)";
  if (status === "refunded") return "Refunded";
  return "Partial paid";
}

export function summarizeOrderPayments(lines) {
  return lines.reduce(
    (acc, line) => {
      acc.payNow = roundMoney(acc.payNow + Number(line.payNow || 0));
      acc.payCod = roundMoney(acc.payCod + Number(line.payCod || 0));
      acc.fullPrice = roundMoney(acc.fullPrice + Number(line.fullPrice || 0));
      acc.surcharge = roundMoney(acc.surcharge + Number(line.surcharge || 0));
      return acc;
    },
    { payNow: 0, payCod: 0, fullPrice: 0, surcharge: 0 },
  );
}

export function overallStatus(summary, markedPaid = false) {
  if (markedPaid) return "fully_paid";
  if (summary?.status === "refunded") return "refunded";
  const payNow = Number(summary.payNow || 0);
  const payCod = Number(summary.payCod || 0);
  const fullPrice = Number(summary.fullPrice || 0);
  const remaining = payCod > 0 ? payCod : roundMoney(Math.max(0, fullPrice - payNow));
  if (remaining > 0) return "partial_paid";
  if (payNow <= 0) return "unpaid_cod";
  return "fully_paid";
}

export function propertiesFromPayment(payment, settings = DEFAULT_SETTINGS) {
  const symbol = settings.currencySymbol || "₹";
  const rows = [
    { key: VISIBLE.payNow, value: formatMoney(payment.payNow, symbol) },
    { key: VISIBLE.payCod, value: formatMoney(payment.payCod, symbol) },
    { key: VISIBLE.full, value: formatMoney(payment.fullPrice, symbol) },
    { key: VISIBLE.status, value: orderStatusLabel(payment.status) },
  ];
  if (Number(payment.surcharge) > 0) {
    rows.push({ key: VISIBLE.surcharge, value: formatMoney(payment.surcharge, symbol) });
  }
  return rows;
}

export function paymentFromProperties(properties = []) {
  const map = {};
  for (const prop of properties) {
    const key = prop.key || prop.name;
    const value = prop.value;
    if (key) map[key] = value;
  }
  if (map[ATTR.surcharge] === "1") return null;
  const hasFriendly =
    (map[VISIBLE.payNow] != null && map[VISIBLE.payNow] !== "") ||
    (map[VISIBLE.payCod] != null && map[VISIBLE.payCod] !== "") ||
    (map[VISIBLE.full] != null && map[VISIBLE.full] !== "") ||
    (map[VISIBLE.status] != null && map[VISIBLE.status] !== "");
  if (!map[ATTR.payNow] && !map.pay_now && !map[ATTR.description] && map[ATTR.info] !== "1" && !hasFriendly) {
    return null;
  }
  const status = statusFromLabel(map[VISIBLE.status] || map[ATTR.status]);
  const payNow = parseMoney(map[VISIBLE.payNow] || map[ATTR.payNow] || map.pay_now);
  const payCod = parseMoney(map[VISIBLE.payCod] || map[ATTR.payCod]);
  const surcharge = parseMoney(map[VISIBLE.surcharge] || map[ATTR.surchargeAmount]);
  const visibleFull = parseMoney(map[VISIBLE.full]);
  const hiddenFull = parseMoney(map[ATTR.full]);
  const extraNow = surcharge > 0 && payNow > 0;
  let fullPrice = visibleFull > 0 ? visibleFull : hiddenFull;
  if (!extraNow && hiddenFull > visibleFull) fullPrice = hiddenFull;
  if (extraNow) {
    // Catalog only. Ignore older hidden restore-targets that baked extra into Full price.
    if (visibleFull > 0) fullPrice = visibleFull;
    else if (payCod > 0) fullPrice = payCod;
    else if (hiddenFull > surcharge) fullPrice = roundMoney(hiddenFull - surcharge);
  }
  return {
    isInfo: map[ATTR.info] === "1",
    description: map[ATTR.description] || map[ATTR.visible] || "",
    payNow,
    payCod,
    fullPrice,
    surcharge,
    status,
  };
}
