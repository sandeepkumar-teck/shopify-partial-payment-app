import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import {
  useFetcher,
  useLoaderData,
  useRouteError,
} from "react-router";
import { useAppBridge } from "@shopify/app-bridge-react";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { authenticate } from "../shopify.server";
import {
  collectionNumericId,
  formatShopActiveRule,
  normalizeRuleCollectionIds,
  normalizeRuleTags,
  parseSettings,
  productAllowsPartial,
  resolveProductScope,
} from "../lib/partial-payment";
import { loadSettings, saveSettings } from "../lib/partial-payment.server";
import { PRODUCTS_PAGE_SIZE } from "../lib/products";
import {
  countProducts,
  listCollections,
  mergeProductOverrides,
  saveProductConfig,
  searchProductsPage,
  serializeProduct,
} from "../lib/products.server";
import AppMark from "../components/AppMark";
import AppShell from "../components/AppShell";
import Pagination from "../components/Pagination";
import { countProductRules, pageWindow } from "../lib/dashboard";
import { syncProductRuleSnapshots } from "../lib/reporting-snapshot.server";
import "../styles/dashboard.css";

function catalogHref({ q = "", collection = "", tag = "", page = 1, after = "", before = "" } = {}) {
  const params = new URLSearchParams();
  if (q) params.set("q", q);
  if (collection) params.set("collection", collection);
  if (tag) params.set("tag", tag);
  if (Number(page) > 1) params.set("page", String(page));
  if (after) params.set("after", after);
  if (before) params.set("before", before);
  const qs = params.toString();
  return qs ? `/app/products?${qs}` : "/app/products";
}

export const loader = async ({ request }) => {
  const { admin } = await authenticate.admin(request);
  const url = new URL(request.url);
  const query = String(url.searchParams.get("q") || "").trim();
  const after = String(url.searchParams.get("after") || "").trim() || null;
  const before = String(url.searchParams.get("before") || "").trim() || null;
  const page = Math.max(1, Number(url.searchParams.get("page") || 1) || 1);
  const { settings } = await loadSettings(admin);

  const collectionFromUrl = url.searchParams.has("collection")
    ? String(url.searchParams.get("collection") || "").trim()
    : "";
  const tagFromUrl = url.searchParams.has("tag")
    ? String(url.searchParams.get("tag") || "").trim()
    : "";
  const savedScope = resolveProductScope(settings);
  const useSavedFilters =
    !url.searchParams.has("collection") &&
    !url.searchParams.has("tag") &&
    (savedScope === "collection" || savedScope === "tag");
  const collectionId =
    collectionFromUrl ||
    (useSavedFilters && savedScope === "collection" ? settings.ruleCollectionIds[0] || "" : "");
  const tag =
    tagFromUrl ||
    (useSavedFilters && savedScope === "tag" ? (settings.ruleTags || []).join(", ") : "");
  const collectionIds = collectionId ? [collectionId] : [];
  const tags = normalizeRuleTags(tag);

  let collections = [];
  try {
    collections = await listCollections(admin);
  } catch {
    collections = [];
  }

  let products = [];
  let pageInfo = {};
  let productCount = 0;
  try {
    const [result, count] = await Promise.all([
      searchProductsPage(admin, {
        query,
        cursor: after,
        before,
        page: after || before ? 1 : page,
        collectionIds,
        tags,
        pageSize: PRODUCTS_PAGE_SIZE,
      }),
      countProducts(admin, { query, collectionIds, tags }),
    ]);
    const nodes = Array.isArray(result?.nodes) ? result.nodes : [];
    products = nodes
      .map((node) => {
        try {
          return serializeProduct(node, settings);
        } catch {
          return null;
        }
      })
      .filter(Boolean);
    void syncProductRuleSnapshots(admin, products, settings);
    pageInfo = result?.pageInfo || {};
    productCount = count;
    try {
      await mergeProductOverrides(admin, products);
    } catch {
      // Storefront overlay backfill must not block the Products page.
    }
  } catch {
    products = [];
    pageInfo = {};
    productCount = 0;
  }

  return {
    settings,
    query,
    collectionId,
    tag,
    collections,
    products,
    pageInfo,
    page,
    pageSize: PRODUCTS_PAGE_SIZE,
    productCount,
    loadedAt: new Date().toISOString(),
  };
};

export function shouldRevalidate({ currentUrl, nextUrl, defaultShouldRevalidate, formMethod }) {
  if (formMethod && String(formMethod).toUpperCase() !== "GET") return true;
  if (currentUrl.search !== nextUrl.search) return false;
  return defaultShouldRevalidate;
}

export const action = async ({ request }) => {
  const { admin } = await authenticate.admin(request);
  const { shopId, settings } = await loadSettings(admin);
  const form = await request.formData();
  const intent = String(form.get("intent") || "save");

  if (intent === "scope" || intent === "targeting") {
    const requested = String(form.get("productScope") || "").toLowerCase();
    const allValues = form
      .getAll("allProductsEnabled")
      .map((value) => String(value).trim().toLowerCase())
      .filter((value) => value !== "");
    const lastFlag = allValues[allValues.length - 1];
    const allOn =
      lastFlag != null
        ? lastFlag === "1" || lastFlag === "true" || lastFlag === "on"
        : requested === "all";
    let collectionIds = normalizeRuleCollectionIds(
      String(form.get("ruleCollectionId") || "").trim(),
    );
    let tags = normalizeRuleTags(String(form.get("ruleTags") || ""));
    let productScope = requested;
    if (requested === "selected") {
      productScope = "selected";
      collectionIds = [];
      tags = [];
    } else if (requested === "tag" || (!allOn && tags.length && requested !== "collection")) {
      productScope = "tag";
      collectionIds = [];
    } else if (requested === "collection" || (!allOn && collectionIds.length)) {
      productScope = "collection";
      tags = [];
    } else if (!allOn) {
      productScope = "selected";
      collectionIds = [];
      tags = [];
    } else {
      productScope = "all";
      collectionIds = [];
      tags = [];
    }
    const next = parseSettings({
      ...settings,
      allProductsEnabled: productScope === "all",
      ruleCollectionIds: collectionIds,
      ruleTags: tags,
      productScope,
    });
    await saveSettings(admin, shopId, next);
    return { settings: next, targeting: true };
  }

  if (intent === "enableMany") {
    const ids = String(form.get("productIds") || "")
      .split(",")
      .map((value) => value.trim())
      .filter(Boolean);
    for (const productId of ids) {
      await saveProductConfig(admin, productId, {
        enabled: true,
        payRuleType: "shop",
        depositOptions: [],
        surcharge: null,
        skus: [],
      });
    }
    return { ok: true };
  }

  const productId = String(form.get("productId") || "");
  if (!productId) return { error: "Product missing" };

  const skus = String(form.get("skus") || "")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);
  const depositRaw = String(form.get("depositOptions") || "").trim();
  const depositOptions = depositRaw
    ? depositRaw.split(",").map((value) => Number(value.trim())).filter((n) => n > 0)
    : [];
  const surchargeRaw = String(form.get("surcharge") || "").trim();
  const fullyCodRaw = String(form.get("fullyCodEnabled") || "").trim();

  await saveProductConfig(admin, productId, {
    enabled: form.get("enabled") === "true",
    payRuleType: String(form.get("payRuleType") || "shop"),
    fixedAmount: 500,
    percent: String(form.get("percent") || "").trim(),
    customAmount: String(form.get("customAmount") || "").trim(),
    depositOptions,
    surcharge: surchargeRaw === "" ? null : Number(surchargeRaw),
    fullyCodEnabled: fullyCodRaw === "" ? null : fullyCodRaw === "true",
    skus,
  });

  return { ok: true };
};

export default function Products() {
  const loaderData = useLoaderData() || {};
  const fetcher = useFetcher();
  const catalogNav = useFetcher();
  const shopify = useAppBridge();
  const data = Array.isArray(catalogNav.data?.products) ? catalogNav.data : loaderData;
  const [query, setQuery] = useState(data.query || "");
  const [collectionId, setCollectionId] = useState(data.collectionId || "");
  const [tag, setTag] = useState(data.tag || "");
  const [editingProductId, setEditingProductId] = useState(null);
  const [editingSnapshot, setEditingSnapshot] = useState(null);
  const [portalTarget, setPortalTarget] = useState(() =>
    typeof document !== "undefined" ? document.body : null,
  );
  const currentSettings = fetcher.data?.settings || data.settings || {};
  const [productScope, setProductScope] = useState(() => resolveProductScope(currentSettings));
  const [allProducts, setAllProducts] = useState(() => resolveProductScope(currentSettings) === "all");
  const catalogBusy = catalogNav.state !== "idle";
  const products = Array.isArray(data.products) ? data.products : [];
  const collections = Array.isArray(data.collections) ? data.collections : [];
  const pageInfo = data.pageInfo || {};
  const page = Math.max(1, Number(data.page) || 1);
  const pageSize = Number(data.pageSize) || PRODUCTS_PAGE_SIZE;
  const productCount = Number(data.productCount) || 0;
  const totalPages = Math.max(
    1,
    productCount > 0 ? Math.ceil(productCount / pageSize) : pageInfo.hasNextPage ? page + 1 : page,
  );
  const ruleCounts = countProductRules(products, currentSettings);
  const symbol = currentSettings.currencySymbol || "₹";
  const savedCollectionId = (currentSettings.ruleCollectionIds || [])[0] || "";
  const savedCollectionTitle =
    collections.find(
      (item) => collectionNumericId(item.id) === collectionNumericId(savedCollectionId),
    )?.title || "";
  const activeRule = formatShopActiveRule(currentSettings, symbol, {
    collectionTitle: savedCollectionTitle,
  });
  const targetingBusy = ["submitting", "loading"].includes(fetcher.state) && fetcher.formMethod === "POST";

  useEffect(() => {
    setQuery(data.query || "");
    setCollectionId(data.collectionId || "");
    setTag(data.tag || "");
  }, [data.query, data.collectionId, data.tag]);

  useEffect(() => {
    if (targetingBusy) return;
    const scope = resolveProductScope(currentSettings);
    setProductScope(scope);
    setAllProducts(scope === "all");
  }, [currentSettings.productScope, currentSettings.allProductsEnabled, currentSettings.ruleCollectionIds, currentSettings.ruleTags, targetingBusy]);

  useEffect(() => {
    if (fetcher.data?.targeting && fetcher.data?.settings) {
      shopify.toast.show("Product targeting saved");
      return;
    }
    if (fetcher.data?.ok || fetcher.data?.settings) {
      shopify.toast.show("Product / SKU settings saved");
    }
  }, [fetcher.data, shopify]);

  function saveTargeting({
    scope = productScope,
    allOn = allProducts,
    collection = collectionId,
    tags = tag,
  } = {}) {
    const form = new FormData();
    form.set("intent", "targeting");
    form.set("productScope", scope);
    form.set("allProductsEnabled", scope === "all" && allOn ? "1" : "0");
    form.set("ruleCollectionId", scope === "collection" ? collection || "" : "");
    form.set("ruleTags", scope === "tag" ? tags || "" : "");
    fetcher.submit(form, { method: "POST" });
  }

  function browseCatalog(opts) {
    const href = catalogHref({
      q: opts.q ?? query,
      collection: opts.collection ?? collectionId,
      tag: opts.tag ?? tag,
      page: opts.page ?? 1,
      after: opts.after || "",
      before: opts.before || "",
    });
    catalogNav.load(href);
  }

  async function pickProducts() {
    const selected = await shopify.resourcePicker({
      type: "product",
      multiple: true,
      action: "select",
    });
    if (!selected?.length) return;
    const form = new FormData();
    form.set("intent", "enableMany");
    form.set("productIds", selected.map((product) => product.id).join(","));
    fetcher.submit(form, { method: "POST" });
  }

  const pages = pageWindow(page, totalPages);
  const canPrev = Boolean(pageInfo.hasPreviousPage) || page > 1;
  const canNext = Boolean(pageInfo.hasNextPage) || (productCount > 0 && page < totalPages);
  const showPager =
    productCount > pageSize ||
    pageInfo.hasNextPage ||
    pageInfo.hasPreviousPage ||
    page > 1 ||
    (productCount === 0 && products.length >= pageSize);
  const liveEditingProduct = products.find((product) => product.id === editingProductId) || null;
  const editingProduct =
    liveEditingProduct ||
    (editingProductId && editingSnapshot?.id === editingProductId ? editingSnapshot : null);

  useEffect(() => {
    setPortalTarget(document.body);
  }, []);

  function openRuleModal(product, event) {
    event?.preventDefault?.();
    event?.stopPropagation?.();
    setEditingSnapshot(product);
    setEditingProductId(product.id);
  }

  function closeRuleModal() {
    setEditingProductId(null);
    setEditingSnapshot(null);
  }

  useEffect(() => {
    if (!editingProductId) return undefined;
    function onKeyDown(event) {
      if (event.key === "Escape") closeRuleModal();
    }
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    window.addEventListener("keydown", onKeyDown);
    return () => {
      document.body.style.overflow = previousOverflow;
      window.removeEventListener("keydown", onKeyDown);
    };
  }, [editingProductId]);

  function renderRuleEditor(product) {
    const variants = Array.isArray(product.variants) ? product.variants : [];
    const config = product.config || {};
    const skus = Array.isArray(config.skus) ? config.skus : [];
    return (
      <fetcher.Form method="POST" className="sku-editor sku-editor--modal" key={product.id}>
        <input type="hidden" name="productId" value={product.id} />
        <input type="hidden" name="depositOptions" value="" />
        <input
          type="hidden"
          name="enabled"
          id={`enabled-${product.id}`}
          defaultValue={config.enabled ? "true" : "false"}
        />
        <div className="sku-editor-row">
          <span>Partial payment</span>
          <label className="pp-toggle pp-toggle--ok">
            <input
              type="checkbox"
              defaultChecked={Boolean(config.enabled)}
              onChange={(event) => {
                const hidden = document.getElementById(`enabled-${product.id}`);
                if (hidden) hidden.value = event.currentTarget.checked ? "true" : "false";
              }}
            />
            <span className="pp-toggle__track" aria-hidden="true" />
          </label>
        </div>
        <div className="sku-editor-row">
          <span>Fully COD</span>
          <div className="pp-seg" role="radiogroup" aria-label="Allow FULLY COD">
            <label className="pp-seg__opt">
              <input
                type="radio"
                name="fullyCodEnabled"
                value="shop"
                defaultChecked={config.fullyCodEnabled == null}
              />
              <span>Shop</span>
            </label>
            <label className="pp-seg__opt">
              <input
                type="radio"
                name="fullyCodEnabled"
                value="true"
                defaultChecked={config.fullyCodEnabled === true}
              />
              <span>On</span>
            </label>
            <label className="pp-seg__opt">
              <input
                type="radio"
                name="fullyCodEnabled"
                value="false"
                defaultChecked={config.fullyCodEnabled === false}
              />
              <span>Off</span>
            </label>
          </div>
        </div>
        <div className="sku-editor-row">
          <span>Pay now</span>
          <select name="payRuleType" defaultValue={config.payRuleType || "shop"}>
            <option value="shop">Use shop default</option>
            <option value="fixed">Fixed</option>
            <option value="percent">Percent</option>
            <option value="custom">Custom</option>
          </select>
        </div>
        <div className="sku-editor-amounts">
          <label className="sku-editor-amt">
            <span>Fixed</span>
            <input
              type="number"
              name="fixedAmount"
              value="500"
              readOnly
              aria-readonly="true"
              title="Fixed amount is always ₹500. Use Custom for another value."
            />
          </label>
          <label className="sku-editor-amt">
            <span>%</span>
            <input
              type="number"
              name="percent"
              defaultValue={config.percent == null ? "" : String(config.percent)}
              title="Blank = shop"
            />
          </label>
          <label className="sku-editor-amt">
            <span>Custom</span>
            <input
              type="number"
              name="customAmount"
              defaultValue={config.customAmount == null ? "" : String(config.customAmount)}
              title="Blank = shop"
            />
          </label>
          <label className="sku-editor-amt">
            <span>COD extra</span>
            <input
              type="text"
              name="surcharge"
              defaultValue={config.useShopSurcharge ? "" : String(config.surcharge)}
              title="Blank = shop"
            />
          </label>
        </div>
        <fieldset className="sku-editor-skus">
          <legend>SKUs</legend>
          {variants.map((variant) => {
            return (
              <label key={variant.id} className="sku-editor-sku">
                <input
                  type="checkbox"
                  name="skuChoice"
                  value={variant.sku || ""}
                  defaultChecked={!skus.length || skus.includes(variant.sku)}
                  disabled={!variant.sku}
                />
                <span>
                  {variant.title} · {variant.sku || "no SKU"} · ₹{variant.price}
                </span>
              </label>
            );
          })}
        </fieldset>
        <input type="hidden" name="skus" id={`skus-${product.id}`} defaultValue={skus.join(",")} />
        <div className="sku-editor-actions">
          <button
            type="submit"
            className="btn-primary sku-editor-save"
            onClick={(event) => {
              const form = event.currentTarget.closest("form");
              const checked = [...form.querySelectorAll('input[name="skuChoice"]:checked')]
                .map((input) => input.value)
                .filter(Boolean);
              const allSkus = variants.map((variant) => variant.sku).filter(Boolean);
              form.querySelector(`#skus-${product.id}`).value =
                checked.length === allSkus.length ? "" : checked.join(",");
            }}
          >
            Save product rule
          </button>
        </div>
      </fetcher.Form>
    );
  }

  return (
    <div className="pp-page">
      <AppShell
        kicker="PartialPay · Catalog"
        title="Products / SKU"
        subtitle="Pick who pays a deposit at checkout. Search only finds products in this list."
        active="products"
        loadedAt={data.loadedAt}
      >
        <div className="products-page">
        <section className="panel sku-panel">
          <h2>Catalog</h2>
          <div className="panel-body">
          <div className="settings-active products-active-rule">
            <span>Selected rule</span>
            <strong>{activeRule.headline}</strong>
            <em>{activeRule.meta}</em>
            <p className="rule-banner-note">{activeRule.detail}</p>
          </div>
          <div className="products-toolbar">
            <fetcher.Form method="POST" className="products-toolbar-form" onSubmit={(event) => {
              event.preventDefault();
              saveTargeting();
            }}>
              <input type="hidden" name="intent" value="targeting" />
              <input type="hidden" name="allProductsEnabled" value="0" />
              <input type="hidden" name="productScope" value={productScope} />
              <div className="products-toolbar-row products-toolbar-row--main">
                <div className={`products-target${productScope === "all" ? " is-active" : ""}`}>
                  <div className="products-all-toggle">
                    <span>All products</span>
                    <label className="pp-toggle pp-toggle--ok">
                      <input
                        type="checkbox"
                        name="allProductsEnabled"
                        value="1"
                        checked={allProducts}
                        disabled={targetingBusy}
                        onChange={(event) => {
                          const on = event.currentTarget.checked;
                          if (on) {
                            setAllProducts(true);
                            setProductScope("all");
                            setCollectionId("");
                            setTag("");
                            saveTargeting({ scope: "all", allOn: true, collection: "", tags: "" });
                            browseCatalog({ collection: "", tag: "", page: 1 });
                            return;
                          }
                          setAllProducts(false);
                          setProductScope("selected");
                          saveTargeting({
                            scope: "selected",
                            allOn: false,
                            collection: "",
                            tags: "",
                          });
                        }}
                      />
                      <span className="pp-toggle__track" aria-hidden="true" />
                    </label>
                  </div>
                </div>
                <div className={`products-target${productScope === "selected" ? " is-active" : ""}`}>
                  <div className="products-scope-seg" role="radiogroup" aria-label="Catalog scope">
                    <label className={`products-scope-seg__opt${productScope === "all" ? " is-on" : ""}`}>
                      <input
                        type="radio"
                        name="productScopeChoice"
                        value="all"
                        checked={productScope === "all"}
                        disabled={targetingBusy}
                        onChange={() => {
                          setProductScope("all");
                          setAllProducts(true);
                          setCollectionId("");
                          setTag("");
                          saveTargeting({ scope: "all", allOn: true, collection: "", tags: "" });
                          browseCatalog({ collection: "", tag: "", page: 1 });
                        }}
                      />
                      All except Off
                    </label>
                    <label className={`products-scope-seg__opt${productScope === "selected" ? " is-on" : ""}`}>
                      <input
                        type="radio"
                        name="productScopeChoice"
                        value="selected"
                        checked={productScope === "selected"}
                        disabled={targetingBusy}
                        onChange={() => {
                          setProductScope("selected");
                          setAllProducts(false);
                          setCollectionId("");
                          setTag("");
                          saveTargeting({ scope: "selected", allOn: false });
                          browseCatalog({ collection: "", tag: "", page: 1 });
                        }}
                      />
                      Enabled SKUs only
                    </label>
                  </div>
                </div>
                <label className={`settings-field products-field-collection${productScope === "collection" ? " is-active" : ""}`}>
                  <span>Collection only</span>
                  <select
                    name="ruleCollectionId"
                    value={collectionId}
                    onChange={(event) => {
                      const value = event.currentTarget.value;
                      setCollectionId(value);
                      if (value) {
                        setAllProducts(false);
                        setProductScope("collection");
                        setTag("");
                        saveTargeting({
                          scope: "collection",
                          allOn: false,
                          collection: value,
                          tags: "",
                        });
                        browseCatalog({ collection: value, tag: "", page: 1 });
                        return;
                      }
                      if (productScope === "collection") {
                        setAllProducts(true);
                        setProductScope("all");
                        saveTargeting({ scope: "all", allOn: true, collection: "", tags: "" });
                      }
                      browseCatalog({ collection: "", tag: "", page: 1 });
                    }}
                  >
                    <option value="">Choose a collection</option>
                    {collections.map((collection) => (
                      <option key={collection.id} value={collection.id}>
                        {collection.title}
                      </option>
                    ))}
                  </select>
                </label>
                <label className={`settings-field products-field-tag${productScope === "tag" ? " is-active" : ""}`}>
                  <span>Tag only</span>
                  <input
                    type="text"
                    name="ruleTags"
                    value={tag}
                    onChange={(event) => setTag(event.currentTarget.value)}
                    placeholder="e.g. sale"
                  />
                </label>
                <button
                  type="submit"
                  className="btn-primary products-toolbar-btn"
                  disabled={targetingBusy}
                  onClick={(event) => {
                    event.preventDefault();
                    if (String(tag || "").trim()) {
                      setAllProducts(false);
                      setProductScope("tag");
                      setCollectionId("");
                      saveTargeting({
                        scope: "tag",
                        allOn: false,
                        collection: "",
                        tags: tag,
                      });
                      browseCatalog({ collection: "", tag, page: 1 });
                      return;
                    }
                    if (productScope === "tag") {
                      shopify.toast.show("Enter a tag, or turn All products on.");
                      return;
                    }
                    saveTargeting();
                  }}
                >
                  {targetingBusy ? "Saving…" : "Save tag rule"}
                </button>
              </div>
            </fetcher.Form>
            <div className="products-toolbar-row products-toolbar-row--search">
              <form
                className="products-search-form"
                onSubmit={(event) => {
                  event.preventDefault();
                  browseCatalog({ q: query, collection: collectionId, tag, page: 1 });
                }}
              >
                <label className="settings-field products-field-search">
                  <span>Search</span>
                  <input
                    type="search"
                    value={query}
                    onChange={(event) => setQuery(event.currentTarget.value)}
                    placeholder="Title, SKU, or handle"
                  />
                </label>
                <button type="submit" className="btn-secondary products-toolbar-btn">
                  Search
                </button>
                <button type="button" className="btn-primary products-toolbar-btn" onClick={pickProducts}>
                  Pick products
                </button>
              </form>
            </div>
            {ruleCounts ? (
              <div className="products-stats">
                <div className={`rule-chip rule-chip--fixed${ruleCounts.fixed > 0 ? " is-hot" : ""}`}>
                  <span>Fixed</span>
                  <strong>{ruleCounts.fixed}</strong>
                </div>
                <div className={`rule-chip rule-chip--pct25${ruleCounts.percent25 > 0 ? " is-hot" : ""}`}>
                  <span>25%</span>
                  <strong>{ruleCounts.percent25}</strong>
                </div>
                <div className={`rule-chip rule-chip--pct50${ruleCounts.percent50 > 0 ? " is-hot" : ""}`}>
                  <span>50%</span>
                  <strong>{ruleCounts.percent50}</strong>
                </div>
                <div className={`rule-chip rule-chip--custom${ruleCounts.custom > 0 ? " is-hot" : ""}`}>
                  <span>Custom</span>
                  <strong>{ruleCounts.custom}</strong>
                </div>
                <div className={`rule-chip rule-chip--disabled${ruleCounts.disabled > 0 ? " is-hot" : ""}`}>
                  <span>Disabled</span>
                  <strong>{ruleCounts.disabled}</strong>
                </div>
              </div>
            ) : null}
          </div>

          {!products.length ? (
            <div className={`empty${catalogBusy ? " is-loading" : ""}`}>No products</div>
          ) : (
            <div
              className={`product-grid${catalogBusy ? " is-loading" : ""}`}
              aria-busy={catalogBusy}
              key={`catalog-${page}-${data.query}-${data.collectionId}-${data.tag}`}
            >
            {products.map((product) => {
              const variants = Array.isArray(product.variants) ? product.variants : [];
              const config = product.config || {};
              const skus = Array.isArray(config.skus) ? config.skus : [];
              const allowsShop = productAllowsPartial(config, currentSettings, {
                collectionIds: product.collectionIds,
                tags: product.tags,
              });
              const shopDefault = allowsShop && !config.configured;
              const cardState = config.enabled ? "on" : shopDefault ? "shop" : "off";
              const statusOn = cardState !== "off";
              const statusLabel = statusOn ? "Enable" : "Disable";
              const badgeLabel = config.enabled
                ? "Partial on"
                : shopDefault
                  ? "Shop default"
                  : "Off";
              const ruleLabel = config.useShopRule
                ? "Shop rule"
                : config.payRuleType === "percent"
                  ? `${config.percent || currentSettings.percent}% now`
                  : config.payRuleType === "custom"
                    ? `Custom ₹${config.customAmount || 0}`
                    : `Fixed ₹${config.fixedAmount || currentSettings.fixedAmount || 500}`;
              const skuLabel =
                variants.filter((variant) => variant.sku).map((variant) => variant.sku).join(", ") ||
                "No SKU";
              return (
              <div className={`product-card is-${cardState}${editingProductId === product.id ? " is-editing" : ""}`} key={product.id}>
                <span className="product-card-rail" aria-hidden="true" />
                <div className="product-card-head">
                  <div className="product-main">
                    <div className="product-thumb">
                      {product.image ? <img src={product.image} alt="" /> : <div className="thumb" />}
                    </div>
                    <div className="product-copy">
                      <strong className="product-title">{product.title}</strong>
                      <div className="product-badge-row">
                        <span className={`product-status is-${cardState}`}>{badgeLabel}</span>
                        <span className="product-rule-chip">{ruleLabel}</span>
                      </div>
                      <div className="product-sku">{skuLabel}</div>
                    </div>
                  </div>
                  <div className="product-actions">
                    <fetcher.Form method="POST">
                      <input type="hidden" name="productId" value={product.id} />
                      <input type="hidden" name="enabled" value={config.enabled ? "false" : "true"} />
                      <input type="hidden" name="payRuleType" value={config.payRuleType || "shop"} />
                      <input type="hidden" name="fixedAmount" value="500" />
                      <input type="hidden" name="percent" value={config.percent ?? ""} />
                      <input type="hidden" name="customAmount" value={config.customAmount ?? ""} />
                      <input type="hidden" name="depositOptions" value={config.useShopDeposits ? "" : (config.depositOptions || []).join(",")} />
                      <input type="hidden" name="surcharge" value={config.useShopSurcharge ? "" : String(config.surcharge ?? "")} />
                      <input type="hidden" name="skus" value={skus.join(",")} />
                      <button
                        type="submit"
                        className={`product-action ${statusOn ? "product-action--on" : "product-action--off"}`}
                        aria-pressed={statusOn}
                        title={statusOn ? "Partial is on" : "Partial is off"}
                      >
                        {statusLabel}
                      </button>
                    </fetcher.Form>
                    <button
                      type="button"
                      className="product-action product-action--partial"
                      onClick={(event) => openRuleModal(product, event)}
                    >
                      Partial
                    </button>
                  </div>
                </div>
              </div>
              );
            })}
            </div>
          )}
          {showPager ? (
            <Pagination
              label="Product pages"
              pages={pages}
              current={page}
              total={totalPages}
              busy={catalogBusy}
              canPrev={canPrev}
              canNext={canNext}
              summary={
                productCount > 0
                  ? `${Math.min((page - 1) * pageSize + 1, productCount)}–${Math.min(page * pageSize, productCount)} of ${productCount}`
                  : `Page ${page} of ${totalPages}`
              }
              onPrev={() =>
                browseCatalog({
                  q: data.query,
                  collection: data.collectionId,
                  tag: data.tag,
                  page: page - 1,
                  before: pageInfo.startCursor,
                })
              }
              onNext={() =>
                browseCatalog({
                  q: data.query,
                  collection: data.collectionId,
                  tag: data.tag,
                  page: page + 1,
                  after: pageInfo.endCursor,
                })
              }
              onPage={(n) =>
                browseCatalog({
                  q: data.query,
                  collection: data.collectionId,
                  tag: data.tag,
                  page: n,
                  after: n === page + 1 ? pageInfo.endCursor : "",
                  before: n === page - 1 ? pageInfo.startCursor : "",
                })
              }
            />
          ) : null}
          </div>
        </section>
        </div>
      </AppShell>
      {editingProduct && portalTarget
        ? createPortal(
            <div
              className="sku-modal-backdrop"
              onClick={(event) => {
                if (event.target === event.currentTarget) closeRuleModal();
              }}
            >
              <div
                className="sku-modal"
                role="dialog"
                aria-modal="true"
                aria-labelledby="sku-modal-title"
                tabIndex={-1}
                onClick={(event) => event.stopPropagation()}
              >
                <div className="sku-modal-head">
                  <AppMark size={36} />
                  {editingProduct.image ? (
                    <img src={editingProduct.image} alt="" />
                  ) : (
                    <div className="thumb" />
                  )}
                  <div className="sku-modal-copy">
                    <span>Product deposit</span>
                    <strong id="sku-modal-title">{editingProduct.title}</strong>
                  </div>
                  <button type="button" className="sku-modal-close" onClick={closeRuleModal} aria-label="Close">
                    ×
                  </button>
                </div>
                {renderRuleEditor(editingProduct)}
              </div>
            </div>,
            portalTarget,
          )
        : null}
    </div>
  );
}

export const headers = (headersArgs) => {
  return boundary.headers(headersArgs);
};

export function ErrorBoundary() {
  useRouteError();
  return (
    <div className="pp-page">
      <AppShell
        kicker="PartialPay · Catalog"
        title="Products / SKU"
        subtitle="Catalog could not be loaded."
        active="products"
      >
        <div className="products-page">
          <section className="panel">
            <h2>Catalog</h2>
            <div className="panel-body">
              <div className="empty">No products</div>
            </div>
          </section>
        </div>
      </AppShell>
    </div>
  );
}
