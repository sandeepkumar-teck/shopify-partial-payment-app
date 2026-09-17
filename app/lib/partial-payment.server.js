import {
  DISCOUNT_TITLE,
  parseSettings,
  SETTINGS_METAFIELD,
  needsPartialPaymentSetup,
} from "./partial-payment";
import { syncShopSettingsSnapshot } from "./reporting-snapshot.server";

export const CART_TRANSFORM_HANDLE = "partial-payment-transform";
export const PAYMENT_CUSTOMIZATION_HANDLE = "partial-payment-hide-cod";
export const PAYMENT_CUSTOMIZATION_TITLE = "PulsePay: hide COD on partial payment";
export const LINE_UPDATE_METAFIELD = {
  namespace: SETTINGS_METAFIELD.namespace,
  key: "use_line_update",
};

const SETTINGS_QUERY = `#graphql
  query PartialPaymentSettings {
    shop {
      id
      metafield(namespace: "${SETTINGS_METAFIELD.namespace}", key: "${SETTINGS_METAFIELD.key}") {
        value
      }
    }
  }
`;

const SETTINGS_MUTATION = `#graphql
  mutation SetPartialPaymentSettings($metafields: [MetafieldsSetInput!]!) {
    metafieldsSet(metafields: $metafields) {
      metafields { id value }
      userErrors { field message }
    }
  }
`;

export async function loadSettings(admin) {
  const response = await admin.graphql(SETTINGS_QUERY);
  const json = await response.json();
  const settings = parseSettings(json.data?.shop?.metafield?.value);
  void syncShopSettingsSnapshot(admin, settings);
  return {
    shopId: json.data?.shop?.id,
    settings,
  };
}

export async function saveSettings(admin, shopId, settings) {
  const normalizedSettings = {
    ...settings,
    fixedAmount: 500,
    depositOptions: [500],
  };
  const response = await admin.graphql(SETTINGS_MUTATION, {
    variables: {
      metafields: [
        {
          ownerId: shopId,
          namespace: SETTINGS_METAFIELD.namespace,
          key: SETTINGS_METAFIELD.key,
          type: "json",
          value: JSON.stringify(normalizedSettings),
        },
      ],
    },
  });
  const json = await response.json();
  const errors = json.data?.metafieldsSet?.userErrors || [];
  if (errors.length) {
    throw new Error(errors.map((error) => error.message).join(", "));
  }
  void syncShopSettingsSnapshot(admin, normalizedSettings);
  return normalizedSettings;
}

function graphqlAccessDenied(json, field) {
  return (json.errors || []).some(
    (error) =>
      error.extensions?.code === "ACCESS_DENIED" &&
      (!field || String(error.path?.[0] || "") === field),
  );
}

async function adminGraphqlJson(admin, query, variables) {
  try {
    const response = await admin.graphql(query, variables ? { variables } : undefined);
    return await response.json();
  } catch (error) {
    if (error?.body && typeof error.body === "object") return error.body;
    return {
      data: null,
      errors: [
        {
          message: error?.message || String(error),
          extensions: error?.extensions || {},
          path: error?.path,
        },
      ],
    };
  }
}

function publicationText(value) {
  return String(value || "");
}

function isOnlineStorePublication(node) {
  const handles = [
    ...(node.channels?.nodes || []).map((channel) => publicationText(channel.handle).toLowerCase()),
    ...(node.catalog?.apps?.nodes || []).map((app) => publicationText(app.handle).toLowerCase()),
  ];
  if (handles.includes("online_store")) return true;

  const labels = [
    node.name,
    node.catalog?.title,
    ...(node.channels?.nodes || []).map((channel) => channel.name),
    ...(node.catalog?.apps?.nodes || []).map((app) => app.title),
  ];
  return labels.some((label) => /online[\s_-]*store/i.test(publicationText(label)));
}

function pickOnlineStorePublicationId(nodes) {
  const online = nodes.find(isOnlineStorePublication);
  if (online?.id) return online.id;
  const future = nodes.find((node) => node.supportsFuturePublishing);
  return future?.id || "";
}

async function getOnlineStorePublicationId(admin) {
  const richFields = `
        nodes {
          id
          name
          autoPublish
          supportsFuturePublishing
          catalog {
            title
            ... on AppCatalog {
              apps(first: 5) {
                nodes { handle title }
              }
            }
          }
          channels(first: 5) {
            nodes { handle name }
          }
        }
  `;
  const simpleFields = `
        nodes {
          id
          name
          autoPublish
          supportsFuturePublishing
          catalog { title }
        }
  `;
  const queries = [
    `#graphql
      query PartialPaymentPublicationsApp {
        publications(first: 25, catalogType: APP) {
          ${richFields}
        }
      }
    `,
    `#graphql
      query PartialPaymentPublications {
        publications(first: 25) {
          ${richFields}
        }
      }
    `,
    `#graphql
      query PartialPaymentPublicationsAppSimple {
        publications(first: 25, catalogType: APP) {
          ${simpleFields}
        }
      }
    `,
    `#graphql
      query PartialPaymentPublicationsSimple {
        publications(first: 25) {
          ${simpleFields}
        }
      }
    `,
  ];

  for (const query of queries) {
    const json = await adminGraphqlJson(admin, query);
    if (graphqlAccessDenied(json, "publications")) {
      return { id: "", needsScope: true };
    }
    const nodes = json.data?.publications?.nodes || [];
    if (!nodes.length) {
      if (json.errors?.length) {
        console.warn(
          "COD publications lookup:",
          json.errors.map((error) => error.message).join(", "),
        );
      }
      continue;
    }
    const id = pickOnlineStorePublicationId(nodes);
    if (id) return { id, needsScope: false };
  }

  return { id: "", needsScope: false };
}

async function unpublishProductLegacyOnlineStore(admin, productId) {
  const json = await adminGraphqlJson(
    admin,
    `#graphql
      mutation UnpublishSurchargeLegacy($input: ProductInput!) {
        productUpdate(input: $input) {
          product { id }
          userErrors { field message }
        }
      }
    `,
    { input: { id: productId, published: false } },
  );
  const errors = [
    ...(json.errors || []),
    ...(json.data?.productUpdate?.userErrors || []),
  ];
  if (errors.length) {
    return { ok: false, warning: errors.map((error) => error.message).join(", ") };
  }
  return { ok: true };
}

async function unpublishProductFromOnlineStore(admin, productId) {
  if (!productId) {
    return { ok: false, warning: "Missing surcharge product ID." };
  }

  try {
    const publication = await getOnlineStorePublicationId(admin);
    if (publication.needsScope) {
      const legacy = await unpublishProductLegacyOnlineStore(admin, productId);
      if (legacy.ok) return legacy;
      return {
        ok: false,
        warning:
          "PulsePay needs read_publications and write_publications to hide the old COD extra product. Re-open the app and approve permissions, then Save settings again.",
      };
    }

    if (!publication.id) {
      return unpublishProductLegacyOnlineStore(admin, productId);
    }

    const json = await adminGraphqlJson(
      admin,
      `#graphql
        mutation UnpublishPartialPaymentProduct($id: ID!, $input: [PublicationInput!]!) {
          publishableUnpublish(id: $id, input: $input) {
            userErrors { field message }
          }
        }
      `,
      {
        id: productId,
        input: [{ publicationId: publication.id }],
      },
    );
    if (graphqlAccessDenied(json, "publishableUnpublish")) {
      const legacy = await unpublishProductLegacyOnlineStore(admin, productId);
      if (legacy.ok) return legacy;
      return {
        ok: false,
        warning:
          "PulsePay needs write_publications to hide the old COD extra product. Re-open the app and approve updated permissions, then Save settings again.",
      };
    }

    const errors = [
      ...(json.errors || []),
      ...(json.data?.publishableUnpublish?.userErrors || []),
    ];
    if (errors.length) {
      const legacy = await unpublishProductLegacyOnlineStore(admin, productId);
      if (legacy.ok) return legacy;
      return { ok: false, warning: errors.map((error) => error.message).join(", ") };
    }

    return { ok: true };
  } catch (error) {
    const legacy = await unpublishProductLegacyOnlineStore(admin, productId);
    if (legacy.ok) return legacy;
    return {
      ok: false,
      warning: error.message || "Could not unpublish the old COD extra product.",
    };
  }
}

async function lookupSurchargeVariant(admin, variantId) {
  if (!variantId) return null;
  const json = await adminGraphqlJson(
    admin,
    `#graphql
      query LookupSurchargeVariant($id: ID!) {
        productVariant(id: $id) {
          id
          product { id status title }
        }
      }
    `,
    { id: variantId },
  );
  return json.data?.productVariant || null;
}

async function ensureProductDraft(admin, productId) {
  if (!productId) return;
  try {
    await admin.graphql(
      `#graphql
        mutation DraftSurchargeProduct($product: ProductUpdateInput!) {
          productUpdate(product: $product) {
            userErrors { field message }
          }
        }
      `,
      {
        variables: {
          product: {
            id: productId,
            status: "DRAFT",
          },
        },
      },
    );
  } catch (error) {
    console.warn("Surcharge product draft:", error.message);
  }
}

async function findSurchargeProducts(admin, settings) {
  const byId = new Map();
  const add = (product) => {
    if (product?.id && !byId.has(product.id)) byId.set(product.id, product);
  };

  if (settings?.surchargeVariantId) {
    const existing = await lookupSurchargeVariant(admin, settings.surchargeVariantId);
    if (existing?.product?.id) add(existing.product);
  }
  if (settings?.surchargeProductId) add({ id: settings.surchargeProductId });

  const json = await adminGraphqlJson(
    admin,
    `#graphql
      query FindCodExtraChargeProducts {
        products(first: 20, query: "title:'COD extra charge' OR tag:partial-payment-surcharge") {
          nodes { id title status }
        }
      }
    `,
  );
  for (const node of json.data?.products?.nodes || []) add(node);
  return [...byId.values()];
}

/**
 * Stop creating a catalog product for COD extra. If an old “COD extra charge”
 * product exists, draft it and unpublish it from Online Store so it leaves Featured products.
 */
export async function ensureSurchargeProduct(admin, settings) {
  const warnings = [];
  const next = { ...settings };

  try {
    const products = await findSurchargeProducts(admin, next);
    for (const product of products) {
      if (!product?.id) continue;
      await ensureProductDraft(admin, product.id);
      const unpublished = await unpublishProductFromOnlineStore(admin, product.id);
      if (!unpublished.ok && unpublished.warning) warnings.push(unpublished.warning);
    }
  } catch (error) {
    warnings.push(error.message || "Could not hide the old COD extra product.");
  }

  return { settings: next, warnings };
}

async function findAutomaticDiscountNodeId(admin, title) {
  const queries = [
    `#graphql
      query FindPartialPaymentDiscount($query: String!) {
        automaticDiscountNodes(first: 25, query: $query) {
          nodes {
            id
            automaticDiscount {
              ... on DiscountAutomaticApp {
                discountId
                title
                status
              }
            }
          }
        }
      }
    `,
    `#graphql
      query FindPartialPaymentDiscountNodes($query: String!) {
        discountNodes(first: 25, query: $query) {
          nodes {
            id
            discount {
              ... on DiscountAutomaticApp {
                discountId
                title
              }
            }
          }
        }
      }
    `,
  ];

  for (const query of queries) {
    try {
      const response = await admin.graphql(query, {
        variables: { query: `title:${JSON.stringify(title)}` },
      });
      const json = await response.json();
      const nodes =
        json.data?.automaticDiscountNodes?.nodes || json.data?.discountNodes?.nodes || [];
      const match = nodes.find((node) => {
        const discount = node.automaticDiscount || node.discount || {};
        return String(discount.title || "") === title;
      });
      if (match?.id) return match.id;
      const discount = match?.automaticDiscount || match?.discount || {};
      if (discount.discountId) return discount.discountId;
    } catch (error) {
      console.warn("Partial payment discount lookup:", error.message);
    }
  }
  return "";
}

export async function deactivatePartialPaymentDiscount(admin, settings) {
  const ids = [settings.discountId, await findAutomaticDiscountNodeId(admin, DISCOUNT_TITLE)].filter(
    Boolean,
  );
  const unique = [...new Set(ids)];
  for (const id of unique) {
    try {
      const response = await admin.graphql(
        `#graphql
          mutation DeactivatePartialPaymentDiscount($id: ID!) {
            discountAutomaticDeactivate(id: $id) {
              userErrors { field message }
            }
          }
        `,
        { variables: { id } },
      );
      const json = await response.json();
      const errors = json.data?.discountAutomaticDeactivate?.userErrors || json.errors || [];
      if (errors.length) {
        console.warn("Partial payment discount deactivate:", errors);
      }
    } catch (error) {
      console.warn("Partial payment discount deactivate:", error.message);
    }
  }
  return { ...settings, discountId: unique[0] || settings.discountId || "" };
}

/**
 * Keep `use_line_update` false. lineUpdate does not change checkout unit price;
 * checkout must charge via lineExpand. Writing false also covers a still-deployed
 * function that still reads this metafield.
 */
async function syncLineUpdateCapability(admin) {
  const json = await adminGraphqlJson(
    admin,
    `#graphql
      query PartialPaymentShopIdForLineUpdate {
        shop {
          id
        }
      }
    `,
  );
  const shopId = json?.data?.shop?.id;
  if (!shopId) {
    if (json?.errors?.length) {
      console.warn("Partial payment shop id:", json.errors);
    }
    return false;
  }
  const result = await adminGraphqlJson(admin, SETTINGS_MUTATION, {
    metafields: [
      {
        ownerId: shopId,
        namespace: LINE_UPDATE_METAFIELD.namespace,
        key: LINE_UPDATE_METAFIELD.key,
        type: "boolean",
        value: "false",
      },
    ],
  });
  const errors = result?.data?.metafieldsSet?.userErrors || result?.errors || [];
  if (errors.length) {
    console.warn("Partial payment lineUpdate metafield:", errors);
  }
  return false;
}

export async function ensureCartTransform(admin, settings) {
  if (settings.cartTransformId) return settings;

  try {
    const existing = await admin.graphql(
      `#graphql
        query PartialPaymentCartTransforms {
          cartTransforms(first: 25) {
            nodes { id functionId }
          }
        }
      `,
    );
    const existingJson = await existing.json();
    const nodes = existingJson.data?.cartTransforms?.nodes || [];
    if (nodes.length) {
      return { ...settings, cartTransformId: nodes[0].id };
    }
  } catch (error) {
    console.warn("Cart transform lookup:", error.message);
  }

  const createResponse = await admin.graphql(
    `#graphql
      mutation CreatePartialPaymentCartTransform($functionHandle: String!) {
        cartTransformCreate(functionHandle: $functionHandle, blockOnFailure: false) {
          cartTransform { id functionId }
          userErrors { field message }
        }
      }
    `,
    { variables: { functionHandle: CART_TRANSFORM_HANDLE } },
  );
  const createJson = await createResponse.json();
  const errors = createJson.data?.cartTransformCreate?.userErrors || createJson.errors || [];
  const already =
    Array.isArray(errors) &&
    errors.some((error) => /already|taken|exists|one cart transform/i.test(error.message || ""));
  if (errors.length && !already) {
    console.warn("Cart transform create:", errors);
  }
  const createdId = createJson.data?.cartTransformCreate?.cartTransform?.id;
  if (createdId) {
    return { ...settings, cartTransformId: createdId };
  }

  if (already) {
    try {
      const retry = await admin.graphql(
        `#graphql
          query PartialPaymentCartTransformsRetry {
            cartTransforms(first: 25) {
              nodes { id }
            }
          }
        `,
      );
      const retryJson = await retry.json();
      const id = retryJson.data?.cartTransforms?.nodes?.[0]?.id;
      if (id) return { ...settings, cartTransformId: id };
    } catch (error) {
      console.warn("Cart transform retry lookup:", error.message);
    }
  }

  return settings;
}

function isPulsePayHideCodCustomization(node) {
  const title = String(node?.title || "");
  const handle = String(node?.shopifyFunction?.handle || node?.functionHandle || "");
  return (
    handle === PAYMENT_CUSTOMIZATION_HANDLE ||
    title === PAYMENT_CUSTOMIZATION_TITLE ||
    /hide COD on partial/i.test(title)
  );
}

async function findPaymentCustomization(admin) {
  const queries = [
    `#graphql
      query PartialPaymentCustomizations {
        paymentCustomizations(first: 25) {
          nodes {
            id
            title
            enabled
            shopifyFunction { handle }
          }
        }
      }
    `,
    `#graphql
      query PartialPaymentCustomizationsSimple {
        paymentCustomizations(first: 25) {
          nodes { id title enabled }
        }
      }
    `,
  ];

  for (const query of queries) {
    const json = await adminGraphqlJson(admin, query);
    if (graphqlAccessDenied(json, "paymentCustomizations")) {
      return { needsScope: true, node: null };
    }
    const nodes = json.data?.paymentCustomizations?.nodes || [];
    if (json.errors?.length && !nodes.length) continue;
    const match = nodes.find(isPulsePayHideCodCustomization);
    return { needsScope: false, node: match || null };
  }

  return { needsScope: false, node: null };
}

async function setPaymentCustomizationEnabled(admin, id, enabled) {
  const json = await adminGraphqlJson(
    admin,
    `#graphql
      mutation SetPartialPaymentCustomizationEnabled($id: ID!, $paymentCustomization: PaymentCustomizationInput!) {
        paymentCustomizationUpdate(id: $id, paymentCustomization: $paymentCustomization) {
          paymentCustomization { id enabled }
          userErrors { field message }
        }
      }
    `,
    { id, paymentCustomization: { enabled } },
  );
  const errors = [
    ...(json.errors || []),
    ...(json.data?.paymentCustomizationUpdate?.userErrors || []),
  ];
  if (errors.length) {
    console.warn(
      "PulsePay payment customization update:",
      errors.map((error) => error.message).join(", "),
    );
  }
}

/**
 * Turn OFF leftover hide-COD so Shopify Cash on Delivery stays visible.
 * Never PATCH a stored ID that Shopify already deleted — that logs
 * "Could not find PaymentCustomization" on every Dashboard load.
 */
export async function ensurePaymentCustomization(admin, settings) {
  const warnings = [];
  try {
    const existing = await findPaymentCustomization(admin);
    if (existing.needsScope) {
      return { settings, warnings };
    }
    const live = existing.node;
    if (live?.id && live.enabled !== false) {
      await setPaymentCustomizationEnabled(admin, live.id, false);
    }
    const liveId = live?.id || "";
    if ((settings.paymentCustomizationId || "") !== liveId) {
      return { settings: { ...settings, paymentCustomizationId: liveId }, warnings };
    }
  } catch (error) {
    console.warn("PulsePay payment customization disable:", error.message);
  }
  return { settings, warnings };
}

export async function syncPartialPaymentSetup(admin, { force = false } = {}) {
  const { shopId, settings } = await loadSettings(admin);
  let next = { ...settings };
  const setupWarnings = [];

  try {
    await syncLineUpdateCapability(admin);
  } catch (error) {
    console.warn("Partial payment lineUpdate capability:", error.message);
  }

  try {
    const paymentFn = await ensurePaymentCustomization(admin, next);
    next = paymentFn.settings;
    if (paymentFn.warnings?.length) setupWarnings.push(...paymentFn.warnings);
  } catch (error) {
    console.warn("PulsePay payment customization teardown:", error.message);
  }

  if (!force && !needsPartialPaymentSetup(next)) {
    const changed = JSON.stringify(next) !== JSON.stringify(settings);
    if (changed) {
      await saveSettings(admin, shopId, next);
    }
    return { shopId, settings: next, setupWarnings };
  }

  try {
    const surcharge = await ensureSurchargeProduct(admin, next);
    next = surcharge.settings;
    if (surcharge.warnings?.length) setupWarnings.push(...surcharge.warnings);
  } catch (error) {
    console.warn("COD surcharge product teardown:", error.message);
    setupWarnings.push(error.message || "Could not hide the old COD extra product.");
  }
  try {
    next = await deactivatePartialPaymentDiscount(admin, next);
  } catch (error) {
    console.warn("Partial payment discount teardown:", error.message);
  }
  try {
    next = await ensureCartTransform(admin, next);
  } catch (error) {
    console.warn("Cart transform setup:", error.message);
  }

  const changed = JSON.stringify(next) !== JSON.stringify(settings);
  if (changed) {
    await saveSettings(admin, shopId, next);
  }
  return { shopId, settings: next, setupWarnings };
}
