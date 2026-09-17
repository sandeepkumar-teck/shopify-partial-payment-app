import {
  collectionNumericId,
  compactProductOverride,
  normalizeRuleCollectionIds,
  normalizeRuleTags,
  parseProductConfig,
  parseSettings,
  PRODUCT_METAFIELD,
} from "./partial-payment";
import { loadSettings, saveSettings } from "./partial-payment.server";
import { PRODUCTS_PAGE_SIZE } from "./products";
import { syncProductRuleSnapshot } from "./reporting-snapshot.server";

export { PRODUCTS_PAGE_SIZE };
export const COLLECTIONS_PAGE_SIZE = 50;

const PRODUCT_NODE_FIELDS = `
  id
  title
  handle
  tags
  featuredImage { url altText }
  metafield(namespace: "${PRODUCT_METAFIELD.namespace}", key: "${PRODUCT_METAFIELD.key}") {
    value
  }
  collections(first: 25) {
    nodes { id title }
  }
  variants(first: 40) {
    nodes {
      id
      title
      sku
      price
    }
  }
`;

export function buildProductSearchQuery({ query = "", collectionIds = [], tags = [] } = {}) {
  const collectionQ = normalizeRuleCollectionIds(collectionIds)
    .map(collectionNumericId)
    .filter(Boolean)
    .map((id) => `collection_id:${id}`);
  const tagQ = normalizeRuleTags(tags).map((tag) => `tag:${JSON.stringify(tag)}`);
  const targeting = [...collectionQ, ...tagQ];
  const parts = [];
  if (targeting.length === 1) parts.push(targeting[0]);
  else if (targeting.length > 1) parts.push(`(${targeting.join(" OR ")})`);
  const text = String(query || "").trim();
  if (text) parts.push(text);
  return parts.length ? parts.join(" AND ") : null;
}

export async function listCollections(admin, { max = 250 } = {}) {
  const nodes = [];
  let cursor = null;
  let hasNext = true;
  while (hasNext && nodes.length < max) {
    const response = await admin.graphql(
      `#graphql
        query PartialPaymentCollections($cursor: String) {
          collections(first: ${COLLECTIONS_PAGE_SIZE}, after: $cursor) {
            pageInfo { hasNextPage endCursor }
            nodes { id title handle image { url } }
          }
        }
      `,
      { variables: { cursor } },
    );
    const json = await response.json();
    if (json.errors?.length) {
      throw new Error(json.errors.map((error) => error.message).join(", "));
    }
    const page = json.data?.collections;
    for (const node of page?.nodes || []) {
      if (node?.id) nodes.push(node);
    }
    hasNext = Boolean(page?.pageInfo?.hasNextPage);
    cursor = page?.pageInfo?.endCursor || null;
    if (!cursor) break;
  }
  return nodes.map((node) => ({
    id: node.id,
    title: node.title || node.handle || "Collection",
    handle: node.handle || "",
    image: node.image?.url || "",
  }));
}

export async function countProducts(admin, options = {}) {
  const search = buildProductSearchQuery(options);
  try {
    const response = await admin.graphql(
      `#graphql
        query PartialPaymentProductsCount($query: String) {
          productsCount(query: $query) {
            count
          }
        }
      `,
      { variables: { query: search } },
    );
    const json = await response.json();
    if (json.errors?.length) return 0;
    return Number(json.data?.productsCount?.count) || 0;
  } catch {
    return 0;
  }
}

export async function searchProducts(
  admin,
  {
    query = "",
    cursor = null,
    before = null,
    collectionIds = [],
    tags = [],
    pageSize = PRODUCTS_PAGE_SIZE,
  } = {},
) {
  const search = buildProductSearchQuery({ query, collectionIds, tags });
  const goingBack = Boolean(before);
  const response = await admin.graphql(
    goingBack
      ? `#graphql
          query PartialPaymentProductsPrev($query: String, $before: String, $last: Int) {
            products(last: $last, query: $query, before: $before) {
              pageInfo { hasNextPage hasPreviousPage startCursor endCursor }
              nodes {
                ${PRODUCT_NODE_FIELDS}
              }
            }
          }
        `
      : `#graphql
          query PartialPaymentProductsNext($query: String, $cursor: String, $first: Int) {
            products(first: $first, query: $query, after: $cursor) {
              pageInfo { hasNextPage hasPreviousPage startCursor endCursor }
              nodes {
                ${PRODUCT_NODE_FIELDS}
              }
            }
          }
        `,
    {
      variables: goingBack
        ? { query: search, before, last: pageSize }
        : { query: search, cursor: cursor || null, first: pageSize },
    },
  );
  const json = await response.json();
  if (json.errors?.length) {
    throw new Error(json.errors.map((error) => error.message).join(", "));
  }
  return json.data?.products || { nodes: [], pageInfo: {} };
}

export async function searchProductsPage(admin, options = {}) {
  const page = Math.max(1, Math.min(50, Number(options.page) || 1));
  const after = options.after || options.cursor || null;
  const before = options.before || null;
  if (before || after || page <= 1) {
    return searchProducts(admin, { ...options, cursor: after, before });
  }
  let cursor = null;
  let result = { nodes: [], pageInfo: {} };
  for (let i = 1; i <= page; i += 1) {
    result = await searchProducts(admin, { ...options, cursor, before: null });
    if (i === page || !result.pageInfo?.hasNextPage) break;
    cursor = result.pageInfo.endCursor;
  }
  return result;
}

export async function saveProductConfig(admin, productId, config) {
  const payRuleType =
    !config.payRuleType || config.payRuleType === "shop" ? "shop" : String(config.payRuleType);
  const value = {
    enabled: Boolean(config.enabled),
    partialEnabled: Boolean(config.enabled),
    explicitOff: !Boolean(config.enabled),
    payRuleType,
    fixedAmount:
      payRuleType === "fixed"
        ? 500
        : config.fixedAmount == null || config.fixedAmount === ""
          ? null
          : Number(config.fixedAmount),
    percent: config.percent == null || config.percent === "" ? null : Number(config.percent),
    customAmount:
      config.customAmount == null || config.customAmount === "" ? null : Number(config.customAmount),
    depositOptions: (config.depositOptions || []).map(Number).filter((n) => n > 0),
    surcharge: config.surcharge == null || config.surcharge === "" ? null : Number(config.surcharge),
    fullyCodEnabled:
      config.fullyCodEnabled == null || config.fullyCodEnabled === ""
        ? null
        : config.fullyCodEnabled !== false && config.fullyCodEnabled !== "false",
    skus: Array.isArray(config.skus) ? config.skus.map(String).filter(Boolean) : [],
  };

  const response = await admin.graphql(
    `#graphql
      mutation SetProductPartialPayment($metafields: [MetafieldsSetInput!]!) {
        metafieldsSet(metafields: $metafields) {
          metafields { id value }
          userErrors { field message }
        }
      }
    `,
    {
      variables: {
        metafields: [
          {
            ownerId: productId,
            namespace: PRODUCT_METAFIELD.namespace,
            key: PRODUCT_METAFIELD.key,
            type: "json",
            value: JSON.stringify(value),
          },
        ],
      },
    },
  );
  const json = await response.json();
  const errors = json.data?.metafieldsSet?.userErrors || [];
  if (errors.length) {
    throw new Error(errors.map((error) => error.message).join(", "));
  }
  let shopSettings = null;
  try {
    shopSettings = await mergeProductOverrides(admin, [{ id: productId, config: value }]);
  } catch {
    // Shop overlay is a storefront fallback. Product metafield is the source of truth.
  }
  if (!shopSettings) {
    try {
      shopSettings = (await loadSettings(admin)).settings;
    } catch {
      shopSettings = {};
    }
  }
  void syncProductRuleSnapshot(admin, productId, value, shopSettings);
  return value;
}

export function productNumericId(id) {
  return String(id || "").replace(/\D/g, "");
}

function shouldStoreProductOverride(config) {
  if (!config) return false;
  if (config.explicitOff) return true;
  if (config.enabled || config.partialEnabled) return true;
  if (config.payRuleType && config.payRuleType !== "shop") return true;
  return false;
}

function overrideIsUseful(override) {
  if (!override || typeof override !== "object") return false;
  if (override.explicitOff === true) return true;
  if (override.enabled === true || override.partialEnabled === true) return true;
  const type = String(override.payRuleType || "shop").toLowerCase();
  return type !== "shop" && type !== "default" && type !== "";
}

export async function mergeProductOverrides(admin, products = []) {
  const entries = (Array.isArray(products) ? products : []).filter(Boolean);
  if (!entries.length) return null;
  const { shopId, settings } = await loadSettings(admin);
  const overrides = { ...(settings.productOverrides || {}) };
  let changed = false;
  Object.keys(overrides).forEach((id) => {
    if (overrideIsUseful(overrides[id])) return;
    delete overrides[id];
    changed = true;
  });
  entries.forEach((entry) => {
    const id = productNumericId(entry.id || entry.productId);
    const config = entry.config || entry;
    if (!id) return;
    if (!shouldStoreProductOverride(config)) {
      if (overrides[id]) {
        delete overrides[id];
        changed = true;
      }
      return;
    }
    const next = compactProductOverride(config);
    if (JSON.stringify(overrides[id] || null) !== JSON.stringify(next)) {
      overrides[id] = next;
      changed = true;
    }
  });
  if (!changed) return settings;
  const nextSettings = parseSettings({ ...settings, productOverrides: overrides });
  await saveSettings(admin, shopId, nextSettings);
  return nextSettings;
}

export function serializeProduct(node, shopSettings) {
  const config = parseProductConfig(node.metafield?.value, shopSettings);
  return {
    id: node.id,
    title: node.title,
    handle: node.handle,
    image: node.featuredImage?.url || "",
    tags: Array.isArray(node.tags) ? node.tags.map(String) : [],
    collectionIds: (node.collections?.nodes || []).map((collection) => collection.id).filter(Boolean),
    collections: (node.collections?.nodes || []).map((collection) => ({
      id: collection.id,
      title: collection.title || "",
    })),
    variants: (node.variants?.nodes || []).map((variant) => ({
      id: variant.id,
      title: variant.title,
      sku: variant.sku || "",
      price: variant.price,
    })),
    config,
  };
}
