import prisma from "../db.server";
import { mapDashboardOrder } from "./dashboard";
import { FIXED_DEPOSIT_AMOUNT, productAllowsPartial } from "./partial-payment";

function text(value, max = 500) {
  const result = String(value ?? "").trim();
  return result ? result.slice(0, max) : null;
}

function number(value) {
  if (value == null || value === "") return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function integer(value) {
  const parsed = number(value);
  return parsed == null ? null : Math.trunc(parsed);
}

function date(value) {
  if (!value) return null;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

function json(value, fallback) {
  try {
    return JSON.stringify(value ?? fallback);
  } catch {
    return JSON.stringify(fallback);
  }
}

function parsedOrderMeta(order) {
  const raw = order?.metafield?.value;
  if (raw && typeof raw === "object") return raw;
  try {
    const parsed = JSON.parse(raw || "{}");
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function personName(person) {
  if (!person || typeof person !== "object") return "";
  return String(
    person.name ||
      person.displayName ||
      [person.firstName || person.first_name, person.lastName || person.last_name]
        .filter(Boolean)
        .join(" ") ||
      "",
  ).trim();
}

function customerFromOrder(order, fallback = {}) {
  const name =
    personName(order?.shippingAddress || order?.shipping_address) ||
    personName(order?.billingAddress || order?.billing_address) ||
    personName(order?.customer) ||
    text(fallback.customerName, 200);
  const email =
    text(order?.email || order?.contactEmail || order?.customer?.email, 200) ||
    text(fallback.customerEmail, 200);
  return { customerName: name || null, customerEmail: email || null };
}

async function graphqlJson(admin, query, variables) {
  try {
    const response = await admin.graphql(query, variables ? { variables } : undefined);
    return await response.json();
  } catch (error) {
    if (error?.body && typeof error.body === "object") return error.body;
    throw error;
  }
}

export async function getReportingShop(admin, fallbackShop = "") {
  try {
    const result = await graphqlJson(
      admin,
      `#graphql
        query PartialPayReportingShop {
          shop { id name myshopifyDomain currencyCode }
        }
      `,
    );
    const shop = result?.data?.shop || {};
    return {
      shop: text(shop.myshopifyDomain || fallbackShop, 255) || "",
      shopId: text(shop.id, 255),
      shopName: text(shop.name, 255),
      currencyCode: text(shop.currencyCode, 12),
    };
  } catch (error) {
    console.warn("[partial-payment] reporting shop lookup failed", error.message);
    return { shop: text(fallbackShop, 255) || "", shopId: null, shopName: null, currencyCode: null };
  }
}

async function reportingCollections(admin, ids = []) {
  const gids = (ids || [])
    .map((id) => {
      const raw = String(id || "").trim();
      if (raw.startsWith("gid://")) return raw;
      const numeric = raw.replace(/\D/g, "");
      return numeric ? `gid://shopify/Collection/${numeric}` : "";
    })
    .filter(Boolean);
  if (!gids.length) return [];
  try {
    const result = await graphqlJson(
      admin,
      `#graphql
        query PartialPayReportingCollections($ids: [ID!]!) {
          nodes(ids: $ids) {
            ... on Collection { id title handle }
          }
        }
      `,
      { ids: gids },
    );
    return (result?.data?.nodes || [])
      .filter((node) => node?.id)
      .map((node) => ({ id: node.id, title: node.title || "", handle: node.handle || "" }));
  } catch {
    return gids.map((id) => ({ id, title: "", handle: "" }));
  }
}

export async function syncShopSettingsSnapshot(admin, settings, fallbackShop = "") {
  try {
    const identity = await getReportingShop(admin, fallbackShop);
    if (!identity.shop) return;
    const collectionIds = json(settings?.ruleCollectionIds, []);
    const collections = json(
      await reportingCollections(admin, settings?.ruleCollectionIds || []),
      [],
    );
    const tags = json(settings?.ruleTags, []);
    const overrides = json(settings?.productOverrides, {});
    const rawSettings = json(settings, {});
    await prisma.$executeRaw`
      INSERT INTO "ShopSettingsSnapshot" (
        shop, "shopId", "shopName", "currencyCode", enabled, "productScope",
        "allProductsEnabled", "payRuleType", "fixedAmount", percent, "customAmount",
        surcharge, "fullyCodEnabled", "ruleCollectionIds", "ruleTags",
        "ruleCollections", "productOverrides", settings
      )
      VALUES (
        ${identity.shop}, ${identity.shopId}, ${identity.shopName}, ${identity.currencyCode},
        ${settings?.enabled !== false}, ${text(settings?.productScope, 50)},
        ${settings?.allProductsEnabled === true}, ${text(settings?.payRuleType, 50)},
        ${number(settings?.fixedAmount)}, ${number(settings?.percent)},
        ${number(settings?.customAmount)}, ${number(settings?.surcharge)},
        ${settings?.fullyCodEnabled !== false}, ${collectionIds}::jsonb, ${tags}::jsonb,
        ${collections}::jsonb, ${overrides}::jsonb, ${rawSettings}::jsonb
      )
      ON CONFLICT (shop) DO UPDATE SET
        "shopId" = EXCLUDED."shopId",
        "shopName" = EXCLUDED."shopName",
        "currencyCode" = EXCLUDED."currencyCode",
        enabled = EXCLUDED.enabled,
        "productScope" = EXCLUDED."productScope",
        "allProductsEnabled" = EXCLUDED."allProductsEnabled",
        "payRuleType" = EXCLUDED."payRuleType",
        "fixedAmount" = EXCLUDED."fixedAmount",
        percent = EXCLUDED.percent,
        "customAmount" = EXCLUDED."customAmount",
        surcharge = EXCLUDED.surcharge,
        "fullyCodEnabled" = EXCLUDED."fullyCodEnabled",
        "ruleCollectionIds" = EXCLUDED."ruleCollectionIds",
        "ruleCollections" = EXCLUDED."ruleCollections",
        "ruleTags" = EXCLUDED."ruleTags",
        "productOverrides" = EXCLUDED."productOverrides",
        settings = EXCLUDED.settings,
        "updatedAt" = NOW()
    `;
  } catch (error) {
    console.warn("[partial-payment] settings reporting snapshot failed", error.message);
  }
}

async function writeProductSnapshot(db, identity, product, shopSettings = {}) {
  const config = product?.config || {};
  const productId = text(product?.id || product?.productId, 255);
  if (!identity.shop || !productId) return;
  const key = `${identity.shop}:${productId}`;
  const effectiveEnabled = productAllowsPartial(config, shopSettings, {
    collectionIds: product?.collectionIds || [],
    tags: product?.tags || [],
  });
  const hasProductRule =
    config.useShopRule === false ||
    (config.payRuleType && !["shop", "default"].includes(String(config.payRuleType).toLowerCase()));
  const ruleSource = config.explicitOff
    ? "Product Off"
    : !effectiveEnabled
      ? "Not targeted"
      : hasProductRule
        ? "Product"
        : "Shop";
  const effectiveType = effectiveEnabled
    ? String(hasProductRule ? config.payRuleType : shopSettings.payRuleType || "fixed").toLowerCase()
    : "off";
  const effectiveSurcharge =
    config.useShopSurcharge === false || config.surcharge != null
      ? config.surcharge
      : shopSettings.surcharge;
  const effectiveFullyCod =
    config.fullyCodEnabled == null ? shopSettings.fullyCodEnabled : config.fullyCodEnabled;
  const skus = json(
    config.skus?.length ? config.skus : (product?.variants || []).map((variant) => variant.sku).filter(Boolean),
    [],
  );
  const tags = json(product?.tags, []);
  const collectionIds = json(product?.collectionIds, []);
  const collections = json(product?.collections, []);
  const rawConfig = json(config, {});
  await db.$executeRaw`
    INSERT INTO "ProductRuleSnapshot" (
      "shopProductKey", shop, "productId", "productTitle", handle, enabled,
      "explicitOff", "ruleSource", "payRuleType", "fixedAmount", percent, "customAmount",
      surcharge, "fullyCodEnabled", skus, tags, "collectionIds", collections, config
    )
    VALUES (
      ${key}, ${identity.shop}, ${productId}, ${text(product?.title, 500)},
      ${text(product?.handle, 255)}, ${effectiveEnabled},
      ${config.explicitOff === true}, ${ruleSource}, ${effectiveType},
      ${effectiveType === "fixed" ? 500 : null},
      ${effectiveType === "percent"
        ? number(hasProductRule ? config.percent : shopSettings.percent)
        : null},
      ${effectiveType === "custom"
        ? number(hasProductRule ? config.customAmount : shopSettings.customAmount)
        : null},
      ${number(effectiveSurcharge)},
      ${effectiveFullyCod == null ? null : effectiveFullyCod !== false},
      ${skus}::jsonb, ${tags}::jsonb, ${collectionIds}::jsonb, ${collections}::jsonb,
      ${rawConfig}::jsonb
    )
    ON CONFLICT ("shopProductKey") DO UPDATE SET
      "productTitle" = COALESCE(EXCLUDED."productTitle", "ProductRuleSnapshot"."productTitle"),
      handle = COALESCE(EXCLUDED.handle, "ProductRuleSnapshot".handle),
      enabled = EXCLUDED.enabled,
      "explicitOff" = EXCLUDED."explicitOff",
      "ruleSource" = EXCLUDED."ruleSource",
      "payRuleType" = EXCLUDED."payRuleType",
      "fixedAmount" = EXCLUDED."fixedAmount",
      percent = EXCLUDED.percent,
      "customAmount" = EXCLUDED."customAmount",
      surcharge = EXCLUDED.surcharge,
      "fullyCodEnabled" = EXCLUDED."fullyCodEnabled",
      skus = EXCLUDED.skus,
      tags = EXCLUDED.tags,
      "collectionIds" = EXCLUDED."collectionIds",
      collections = EXCLUDED.collections,
      config = EXCLUDED.config,
      "updatedAt" = NOW()
  `;
}

export async function syncProductRuleSnapshots(
  admin,
  products = [],
  shopSettings = {},
  fallbackShop = "",
) {
  try {
    const identity = await getReportingShop(admin, fallbackShop);
    await Promise.all(
      (products || []).map((product) =>
        writeProductSnapshot(prisma, identity, product, shopSettings),
      ),
    );
  } catch (error) {
    console.warn("[partial-payment] product reporting snapshot failed", error.message);
  }
}

export async function syncProductRuleSnapshot(
  admin,
  productId,
  config,
  shopSettings = {},
  fallbackShop = "",
) {
  try {
    const identity = await getReportingShop(admin, fallbackShop);
    let product = { id: productId, config };
    const result = await graphqlJson(
      admin,
      `#graphql
        query PartialPayReportingProduct($id: ID!) {
          product(id: $id) {
            id title handle tags
            collections(first: 50) { nodes { id title handle } }
            variants(first: 100) { nodes { sku } }
          }
        }
      `,
      { id: productId },
    );
    const node = result?.data?.product;
    if (node) {
      product = {
        id: node.id,
        title: node.title,
        handle: node.handle,
        tags: node.tags || [],
        collectionIds: (node.collections?.nodes || []).map((item) => item.id),
        collections: node.collections?.nodes || [],
        variants: node.variants?.nodes || [],
        config,
      };
    }
    await writeProductSnapshot(prisma, identity, product, shopSettings);
  } catch (error) {
    console.warn("[partial-payment] product reporting snapshot failed", error.message);
  }
}

async function writeScheduledRuleSnapshot(db, shop, rule) {
  const ruleId = text(rule?.id, 255);
  if (!shop || !ruleId) return;
  const key = `${shop}:${ruleId}`;
  const targetIds = json(rule.targetIds, []);
  const targetTags = json(rule.targetTags, []);
  const previews = json(rule.targetPreviews, []);
  const rawRule = json(rule, {});
  await db.$executeRaw`
    INSERT INTO "ScheduledRuleSnapshot" (
      "shopRuleKey", shop, "ruleId", name, action, status, "targetType",
      "targetIds", "targetTags", "targetPreviews", "startAt", "endAt",
      "payRuleType", "fixedAmount", percent, "customAmount", surcharge,
      "fullyCodEnabled", rule
    )
    VALUES (
      ${key}, ${shop}, ${ruleId}, ${text(rule.name, 500)}, ${text(rule.action, 50)},
      ${text(rule.status, 50)}, ${text(rule.targetType, 50)}, ${targetIds}::jsonb,
      ${targetTags}::jsonb, ${previews}::jsonb, ${date(rule.startAt)}, ${date(rule.endAt)},
      ${text(rule.payRuleType, 50)}, ${number(rule.fixedAmount)}, ${number(rule.percent)},
      ${number(rule.customAmount)}, ${number(rule.fullyCodExtra ?? rule.surcharge)},
      ${rule.fullyCodEnabled == null ? null : rule.fullyCodEnabled !== false},
      ${rawRule}::jsonb
    )
    ON CONFLICT ("shopRuleKey") DO UPDATE SET
      name = EXCLUDED.name,
      action = EXCLUDED.action,
      status = EXCLUDED.status,
      "targetType" = EXCLUDED."targetType",
      "targetIds" = EXCLUDED."targetIds",
      "targetTags" = EXCLUDED."targetTags",
      "targetPreviews" = EXCLUDED."targetPreviews",
      "startAt" = EXCLUDED."startAt",
      "endAt" = EXCLUDED."endAt",
      "payRuleType" = EXCLUDED."payRuleType",
      "fixedAmount" = EXCLUDED."fixedAmount",
      percent = EXCLUDED.percent,
      "customAmount" = EXCLUDED."customAmount",
      surcharge = EXCLUDED.surcharge,
      "fullyCodEnabled" = EXCLUDED."fullyCodEnabled",
      rule = EXCLUDED.rule,
      "updatedAt" = NOW()
  `;
}

export async function syncScheduledRuleSnapshots(admin, payload = {}, fallbackShop = "") {
  try {
    const identity = await getReportingShop(admin, fallbackShop);
    if (!identity.shop) return;
    const rules = Array.isArray(payload?.rules) ? payload.rules : [];
    await prisma.$transaction(async (db) => {
      await db.$executeRaw`DELETE FROM "ScheduledRuleSnapshot" WHERE shop = ${identity.shop}`;
      for (const rule of rules) {
        await writeScheduledRuleSnapshot(db, identity.shop, rule);
      }
    });
  } catch (error) {
    console.warn("[partial-payment] schedule reporting snapshot failed", error.message);
  }
}

function asNumber(value) {
  if (value == null || value === "") return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function amountClose(left, right, epsilon = 0.05) {
  return Math.abs(Number(left || 0) - Number(right || 0)) <= epsilon;
}

function formatRuleValue(value) {
  const parsed = asNumber(value);
  if (parsed == null) return "";
  return String(parsed);
}

function inferAppliedRuleFromAmounts(mapped) {
  const payNow = Number(mapped?.payNow || 0);
  const fullPrice = Number(mapped?.fullPrice || 0);
  const remaining = Number(mapped?.remainingCod || 0);
  const surcharge = (mapped?.lines || []).reduce(
    (sum, line) => sum + Number(line?.surcharge || 0),
    0,
  );
  const status = String(mapped?.status || "");

  if (status === "unpaid_cod" || (payNow <= 0 && remaining > 0)) {
    return { payRuleType: "fully_cod", ruleValue: surcharge > 0 ? surcharge : remaining };
  }
  if (surcharge > 0 && amountClose(payNow, surcharge)) {
    return { payRuleType: "fully_cod", ruleValue: surcharge };
  }
  if (amountClose(payNow, FIXED_DEPOSIT_AMOUNT) && fullPrice >= FIXED_DEPOSIT_AMOUNT) {
    return { payRuleType: "fixed", ruleValue: FIXED_DEPOSIT_AMOUNT };
  }
  if (fullPrice > 0 && payNow > 0) {
    const percent = (payNow / fullPrice) * 100;
    const nearest = Math.round(percent);
    if (Math.abs(percent - nearest) < 0.2 && nearest >= 1 && nearest <= 99) {
      return { payRuleType: "percent", ruleValue: nearest };
    }
  }
  return { payRuleType: "custom", ruleValue: payNow };
}

function amountsMatchHint(hint, inferred, mapped) {
  const type = String(hint?.payRuleType || "").toLowerCase();
  if (!type || type === "shop") return false;
  const payNow = Number(mapped?.payNow || 0);
  const fullPrice = Number(mapped?.fullPrice || 0);
  if (type === "percent") {
    const percent = asNumber(hint.percent);
    return percent != null && fullPrice > 0 && amountClose(payNow, (fullPrice * percent) / 100);
  }
  if (type === "fixed") return amountClose(payNow, FIXED_DEPOSIT_AMOUNT);
  if (type === "custom") return amountClose(payNow, hint.customAmount);
  if (type === "fully_cod") return inferred.payRuleType === "fully_cod";
  return type === inferred.payRuleType;
}

function buildRuleLabel(source, type, value) {
  const src = source || "Inferred";
  if (type === "percent") return `${src} · Percent ${formatRuleValue(value)}%`;
  if (type === "fixed") return `${src} · Fixed ₹${formatRuleValue(value || FIXED_DEPOSIT_AMOUNT)}`;
  if (type === "custom") return `${src} · Custom ₹${formatRuleValue(value)}`;
  if (type === "fully_cod") return `${src} · Fully COD`;
  return src;
}

async function appliedRuleForOrder(db, shop, mapped, meta = {}) {
  const inferred = inferAppliedRuleFromAmounts(mapped);
  let payRuleType = text(meta.payRuleType, 50) || inferred.payRuleType;
  let ruleValue = asNumber(meta.ruleValue) ?? inferred.ruleValue;
  let ruleSource = text(meta.ruleSource, 50) || "Inferred";

  try {
    const settingsRows = await db.$queryRaw`
      SELECT "payRuleType", percent, "fixedAmount", "customAmount"
      FROM "ShopSettingsSnapshot" WHERE shop = ${shop} LIMIT 1
    `;
    const productRows = await db.$queryRaw`
      SELECT "productId", "productTitle", "ruleSource", "payRuleType", percent, "fixedAmount", "customAmount"
      FROM "ProductRuleSnapshot" WHERE shop = ${shop}
    `;
    const settings = settingsRows?.[0] || null;
    const lines = Array.isArray(mapped?.lines) ? mapped.lines : [];
    const matchedProducts = (productRows || []).filter((row) =>
      lines.some(
        (line) =>
          (line.productId && row.productId === line.productId) ||
          (line.title && row.productTitle && String(line.title) === String(row.productTitle)),
      ),
    );
    const productHint = matchedProducts.find((row) => amountsMatchHint(row, inferred, mapped));
    if (productHint && String(productHint.ruleSource || "") === "Product") {
      ruleSource = "Product";
      payRuleType = String(productHint.payRuleType || payRuleType).toLowerCase();
      ruleValue =
        payRuleType === "percent"
          ? asNumber(productHint.percent)
          : payRuleType === "custom"
            ? asNumber(productHint.customAmount)
            : asNumber(productHint.fixedAmount) ?? ruleValue;
    } else if (settings && amountsMatchHint(settings, inferred, mapped)) {
      ruleSource = "Shop";
      payRuleType = String(settings.payRuleType || payRuleType).toLowerCase();
      ruleValue =
        payRuleType === "percent"
          ? asNumber(settings.percent)
          : payRuleType === "custom"
            ? asNumber(settings.customAmount)
            : asNumber(settings.fixedAmount) ?? ruleValue;
    } else {
      payRuleType = inferred.payRuleType;
      ruleValue = inferred.ruleValue;
      ruleSource = "Inferred";
    }
  } catch {
    payRuleType = inferred.payRuleType;
    ruleValue = inferred.ruleValue;
    ruleSource = "Inferred";
  }

  return {
    ruleSource,
    payRuleType,
    ruleValue,
    ruleLabel: buildRuleLabel(ruleSource, payRuleType, ruleValue),
  };
}

async function writeOrderSnapshot(db, identity, order, fallbackCustomer = {}) {
  const mapped = mapDashboardOrder(order);
  if (!mapped || !identity.shop || !order?.id) return;
  const meta = parsedOrderMeta(order);
  const customer = customerFromOrder(order, fallbackCustomer);
  const key = `${identity.shop}:${order.id}`;
  const tags = json(order.tags, []);
  const applied = await appliedRuleForOrder(db, identity.shop, mapped, meta);
  const lines = json(
    (mapped.lines || []).map((line) => ({
      ...line,
      ruleSource: applied.ruleSource,
      payRuleType: applied.payRuleType,
      ruleLabel: applied.ruleLabel,
    })),
    [],
  );
  await db.$executeRaw`
    INSERT INTO "OrderSnapshot" (
      "shopOrderKey", shop, "orderId", "orderName", "customerName", "customerEmail",
      "shopifyFinancialStatus", "partialPaymentStatus", "payNow", "remainingCod",
      "collectedCod", "fullPrice", "ruleSource", "payRuleType", "ruleValue", "ruleLabel",
      "invoiceScheduled", "invoiceMode", "invoiceDays",
      "invoiceSent", "invoiceDueAt", "invoiceSentAt", "collectedVia", tags, "lineDetails",
      "orderCreatedAt"
    )
    VALUES (
      ${key}, ${identity.shop}, ${String(order.id)}, ${text(mapped.name, 100)},
      ${customer.customerName}, ${customer.customerEmail},
      ${text(order.displayFinancialStatus || order.financial_status, 50)},
      ${text(mapped.status, 50)}, ${number(mapped.payNow)}, ${number(mapped.remainingCod)},
      ${number(mapped.collectedCod)}, ${number(mapped.fullPrice)},
      ${applied.ruleSource}, ${applied.payRuleType}, ${number(applied.ruleValue)}, ${applied.ruleLabel},
      ${mapped.invoiceScheduled === true}, ${text(mapped.invoiceMode, 50)},
      ${integer(mapped.invoiceDays)}, ${Boolean(mapped.invoiceSentAt)},
      ${date(mapped.invoiceDueAt)}, ${date(mapped.invoiceSentAt)},
      ${text(meta.collectedVia, 100)}, ${tags}::jsonb, ${lines}::jsonb, ${date(mapped.createdAt)}
    )
    ON CONFLICT ("shopOrderKey") DO UPDATE SET
      "orderName" = EXCLUDED."orderName",
      "customerName" = COALESCE(EXCLUDED."customerName", "OrderSnapshot"."customerName"),
      "customerEmail" = COALESCE(EXCLUDED."customerEmail", "OrderSnapshot"."customerEmail"),
      "shopifyFinancialStatus" = EXCLUDED."shopifyFinancialStatus",
      "partialPaymentStatus" = EXCLUDED."partialPaymentStatus",
      "payNow" = EXCLUDED."payNow",
      "remainingCod" = EXCLUDED."remainingCod",
      "collectedCod" = EXCLUDED."collectedCod",
      "fullPrice" = EXCLUDED."fullPrice",
      "ruleSource" = EXCLUDED."ruleSource",
      "payRuleType" = EXCLUDED."payRuleType",
      "ruleValue" = EXCLUDED."ruleValue",
      "ruleLabel" = EXCLUDED."ruleLabel",
      "invoiceScheduled" = EXCLUDED."invoiceScheduled",
      "invoiceSent" = EXCLUDED."invoiceSent",
      "invoiceMode" = EXCLUDED."invoiceMode",
      "invoiceDays" = EXCLUDED."invoiceDays",
      "invoiceDueAt" = EXCLUDED."invoiceDueAt",
      "invoiceSentAt" = EXCLUDED."invoiceSentAt",
      "collectedVia" = EXCLUDED."collectedVia",
      tags = EXCLUDED.tags,
      "lineDetails" = EXCLUDED."lineDetails",
      "orderCreatedAt" = EXCLUDED."orderCreatedAt",
      "updatedAt" = NOW()
  `;
}

export async function syncOrderSnapshots(admin, shop, orders = []) {
  try {
    const identity = {
      shop: text(shop?.myshopifyDomain, 255) || "",
      shopId: null,
      shopName: text(shop?.name, 255),
      currencyCode: text(shop?.currencyCode, 12),
    };
    if (!identity.shop) Object.assign(identity, await getReportingShop(admin));
    const list = Array.isArray(orders) ? orders : [];
    for (let index = 0; index < list.length; index += 20) {
      await Promise.all(
        list
          .slice(index, index + 20)
          .map((order) => writeOrderSnapshot(prisma, identity, order)),
      );
    }
  } catch (error) {
    console.warn("[partial-payment] order reporting snapshot failed", error.message);
  }
}

export async function syncOrderSnapshotFromAdmin(
  admin,
  orderId,
  { shop = "", customerName = null, customerEmail = null } = {},
) {
  try {
    const identity = await getReportingShop(admin, shop);
    const result = await graphqlJson(
      admin,
      `#graphql
        query PartialPayReportingOrder($id: ID!) {
          order(id: $id) {
            id name createdAt tags displayFinancialStatus
            currentTotalPriceSet { shopMoney { amount currencyCode } }
            totalOutstandingSet { shopMoney { amount currencyCode } }
            totalReceivedSet { shopMoney { amount currencyCode } }
            customAttributes { key value }
            metafield(namespace: "$app", key: "partial_payment") { value }
            lineItems(first: 100) {
              nodes {
                title quantity
                image { url }
                product { id }
                originalUnitPriceSet { shopMoney { amount } }
                discountedUnitPriceSet { shopMoney { amount } }
                customAttributes { key value }
              }
            }
          }
        }
      `,
      { id: orderId },
    );
    const order = result?.data?.order;
    if (order) {
      await writeOrderSnapshot(prisma, identity, order, { customerName, customerEmail });
    }
  } catch (error) {
    console.warn("[partial-payment] order reporting snapshot failed", error.message);
  }
}
