(function () {
  if (window.__pulsePayAtc) return;
  window.__pulsePayAtc = true;

  var PARTIAL_DEPOSIT = 500;
  var ruleLogged = false;
  // Drawer, cart page (button may sit outside #cart via form="cart"), and Dawn cart-notification.
  var CHECKOUT_SELECTOR = [
    'button[name="checkout"]',
    'input[name="checkout"]',
    '[name="checkout"]',
    '#checkout',
    '#checkout[form="cart"]',
    '[name="checkout"][form="cart"]',
    '.cart__checkout-button',
    '.cart__checkout-button[form="cart"]',
    '#CartDrawer-Checkout',
    '[id="CartDrawer-Checkout"]',
    '.cart-drawer__checkout',
    '#CartNotification-Checkout',
    '[id="CartNotification-Checkout"]',
    '#cart-notification-form',
    'form#cart-notification-form',
    '#cart-notification-form [name="checkout"]',
    '#CartNotification-Form',
    'form#CartNotification-Form',
    '#CartNotification-Form [name="checkout"]',
    'a[href="/checkout"]',
    'a[href$="/checkout"]',
    'a[href*="/checkout"]',
  ].join(", ");
  var DYNAMIC_CHECKOUT_ROOT =
    ".shopify-payment-button, [data-shopify='payment-button'], shopify-accelerated-checkout, shopify-accelerated-checkout-cart, .cart__dynamic-checkout-buttons, #dynamic-checkout-cart, .accelerated-checkout, .additional-checkout-buttons, #additional-checkout-buttons";
  // Cart-page extra wallets only. PDP Buy it now / payment_button stays visible.
  var CART_EXTRA_CHECKOUT =
    "shopify-accelerated-checkout-cart, .cart__dynamic-checkout-buttons, #dynamic-checkout-cart, #CartDrawer shopify-accelerated-checkout, cart-drawer shopify-accelerated-checkout, #CartDrawer .shopify-payment-button, cart-drawer .shopify-payment-button, #main-cart-footer shopify-accelerated-checkout, #main-cart-footer .additional-checkout-buttons, form#cart .additional-checkout-buttons, #cart-notification-form .additional-checkout-buttons, #cart-notification .additional-checkout-buttons, #CartNotification .additional-checkout-buttons, cart-notification .additional-checkout-buttons";
  var NOTIFICATION_FORM_SELECTOR =
    "#cart-notification-form, form#cart-notification-form, #CartNotification-Form, form#CartNotification-Form";
  var NOTIFICATION_ROOT_SELECTOR =
    "cart-notification, #cart-notification, #CartNotification, .cart-notification, #cart-notification-form, #CartNotification-Form";
  var pending = null;
  var lastFocus = null;
  var interceptLock = false;
  var selectedMode = "full";
  var redirecting = false;

  function shopRoot() {
    return (
      document.querySelector("[data-pp-embed][data-pp-shop]") ||
      document.querySelector("[data-pp-shop][data-pay-rule]") ||
      document.querySelector("[data-pp-shop]") ||
      document.querySelector("[data-pp-root]")
    );
  }

  function attrValue(root, name) {
    if (!root) return "";
    var raw = root.getAttribute(name);
    return raw == null || raw === "" ? "" : raw;
  }

  function firstFiniteNumber() {
    for (var i = 0; i < arguments.length; i += 1) {
      var value = arguments[i];
      if (value == null || value === "") continue;
      var parsed = Number(value);
      if (Number.isFinite(parsed)) return parsed;
    }
    return NaN;
  }

  function parseJsonText(text) {
    if (text == null || String(text).trim() === "") return {};
    try {
      var parsed = JSON.parse(text);
      if (typeof parsed === "string") parsed = JSON.parse(parsed);
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
      return parsed;
    } catch (error) {
      return {};
    }
  }

  function jsonFromTag(id) {
    var el = document.getElementById(id);
    if (!el) return {};
    return parseJsonText(el.textContent || "");
  }

  function parseLooseBoolean(value, fallback) {
    if (fallback === undefined) fallback = true;
    if (value === false || value === "false" || value === 0 || value === "0") return false;
    if (value === true || value === "true" || value === 1 || value === "1") return true;
    if (value == null || value === "") return fallback;
    return fallback;
  }

  function normalizeScope(value) {
    var raw = String(value || "all").toLowerCase();
    if (raw === "selected" || raw === "collection" || raw === "tag" || raw === "all") return raw;
    return "all";
  }

  function settingsFromJsonTag() {
    var constructed = jsonFromTag("pp-shop-settings");
    if (!Object.keys(constructed).length) constructed = jsonFromTag("pp-shop-settings-cart");
    var raw = jsonFromTag("pp-shop-settings-raw");
    if (!Object.keys(raw).length) raw = jsonFromTag("pp-shop-settings-cart-raw");
    // Liquid-normalized #pp-shop-settings wins. Raw metafield overlay used to
    // hide the popup when empty $app JSON was re-parsed as restrictive targeting.
    if (!Object.keys(constructed).length) return raw;
    return Object.assign({}, raw, constructed);
  }

  function money(amount, symbol) {
    return symbol + Number(amount || 0).toLocaleString("en-IN", {
      maximumFractionDigits: 2,
      minimumFractionDigits: Number(amount) % 1 === 0 ? 0 : 2,
    });
  }

  function parseMoney(value) {
    if (value == null || value === "") return 0;
    if (typeof value === "number") return Number.isFinite(value) ? value : 0;
    var cleaned = String(value).replace(/[^0-9.-]/g, "");
    var parsed = Number(cleaned);
    return Number.isFinite(parsed) ? parsed : 0;
  }

  function checkoutUrl() {
    var root = (window.Shopify && Shopify.routes && Shopify.routes.root) || "/";
    return String(root).replace(/\/?$/, "/") + "checkout";
  }

  function hrefIsCheckout(href) {
    if (!href) return false;
    try {
      var url = new URL(href, window.location.origin);
      var path = String(url.pathname || "");
      return /\/checkout\/?$/.test(path) || path.indexOf("/checkouts/") !== -1;
    } catch (error) {
      return /\/checkout/.test(String(href));
    }
  }

  function shopOn() {
    var root = shopRoot();
    if (root && root.getAttribute("data-shop-on") === "false") return false;
    return true;
  }

  function symbolOf() {
    var root = shopRoot();
    var cfg = window.PulsePayConfig || {};
    return (root && root.getAttribute("data-symbol")) || cfg.currencySymbol || "₹";
  }

  function logRuleOnce(type, percent, deposit) {
    if (ruleLogged) return;
    ruleLogged = true;
    console.log("[partial-payment] rule", {
      type: type,
      percent: percent,
      deposit: deposit,
    });
  }

  function shopSettings() {
    var parsed = settingsFromJsonTag();
    var cfg = window.PulsePayConfig || {};
    var root = shopRoot();
    var type = String(
      parsed.payRuleType ||
        parsed.ruleType ||
        parsed.rule ||
        cfg.payRuleType ||
        attrValue(root, "data-pay-rule") ||
        "fixed",
    ).toLowerCase();
    if (type === "percentage") type = "percent";
    if (type !== "percent" && type !== "custom") type = "fixed";
    var percent = firstFiniteNumber(parsed.percent, cfg.percent, attrValue(root, "data-percent"), 25);
    var customAmount = firstFiniteNumber(
      parsed.customAmount,
      cfg.customAmount,
      attrValue(root, "data-custom"),
      attrValue(root, "data-custom-amount"),
      0,
    );
    var surcharge = firstFiniteNumber(
      parsed.surcharge,
      cfg.surcharge,
      attrValue(root, "data-surcharge"),
      500,
    );
    var fullyCodEnabled = parseLooseBoolean(
      parsed.fullyCodEnabled != null
        ? parsed.fullyCodEnabled
        : cfg.fullyCodEnabled != null
          ? cfg.fullyCodEnabled
          : root
            ? root.getAttribute("data-fully-cod-enabled")
            : null,
      surcharge > 0,
    );
    var productScope = normalizeScope(
      attrValue(root, "data-scope") || parsed.productScope || cfg.productScope || "all",
    );
    var allProductsEnabled = parseLooseBoolean(
      root
        ? root.getAttribute("data-all-products")
        : parsed.allProductsEnabled != null
          ? parsed.allProductsEnabled
          : cfg.allProductsEnabled != null
            ? cfg.allProductsEnabled
            : null,
      productScope !== "selected",
    );
    var ruleCollectionIds = listFrom(parsed.ruleCollectionIds || cfg.ruleCollectionIds || attrValue(root, "data-rule-collection-ids"));
    var ruleTags = listFrom(parsed.ruleTags || cfg.ruleTags || attrValue(root, "data-rule-tags"), true);
    if (productScope === "all" && !allProductsEnabled) {
      if (ruleCollectionIds.length) productScope = "collection";
      else if (ruleTags.length) productScope = "tag";
      else productScope = "selected";
    }
    if (productScope === "selected" || productScope === "collection" || productScope === "tag") {
      allProductsEnabled = false;
    }
    return {
      payRuleType: type,
      fixedAmount: PARTIAL_DEPOSIT,
      percent: percent > 0 ? percent : 25,
      customAmount: Number.isFinite(customAmount) ? customAmount : 0,
      productScope: productScope,
      allProductsEnabled: allProductsEnabled,
      ruleCollectionIds: ruleCollectionIds,
      ruleTags: ruleTags,
      surcharge: surcharge > 0 ? surcharge : 500,
      fullyCodEnabled: fullyCodEnabled && Number(surcharge) > 0,
    };
  }

  function shopRule() {
    return shopSettings();
  }

  function shopConfiguredPayNow(total, settings) {
    var catalog = Math.round((Number(total) || 0) * 100) / 100;
    var rule = settings || shopSettings();
    var type = String(rule.payRuleType || "fixed").toLowerCase();
    if (type === "percentage") type = "percent";
    if (type === "percent") {
      var pct = Number(rule.percent) > 0 ? Number(rule.percent) : 25;
      return Math.round(((catalog * pct) / 100) * 100) / 100;
    }
    if (type === "custom") {
      return Math.round(Number(rule.customAmount || 0) * 100) / 100;
    }
    return PARTIAL_DEPOSIT;
  }

  function depositForCartTotal(total, settings) {
    var catalog = Math.round((Number(total) || 0) * 100) / 100;
    if (!(catalog > 0)) return 0;
    var rule = settings || shopSettings();
    var type = String(rule.payRuleType || "fixed").toLowerCase();
    if (type === "percentage") type = "percent";
    var amount = shopConfiguredPayNow(catalog, rule);
    var pct = Number(rule.percent) > 0 ? Number(rule.percent) : 25;
    if (amount > catalog) amount = catalog;
    logRuleOnce(type, type === "percent" ? pct : rule.percent, amount);
    if (!(amount > 0) || amount >= catalog) return 0;
    return amount;
  }

  // Shop Pay now cannot leave Remaining COD: eligible catalog < configured
  // Pay now (Fixed ₹500 vs ₹400, Custom ₹700 vs ₹600), or remaining ≤ 0
  // (price equals deposit). Percent 50% still has remaining unless ≤ 0.
  function cannotLeaveRemainingCod(eligibleTotal, settings) {
    var catalog = Math.round((Number(eligibleTotal) || 0) * 100) / 100;
    if (!(catalog > 0)) return true;
    var payNow = shopConfiguredPayNow(catalog, settings);
    var remaining = Math.round((catalog - payNow) * 100) / 100;
    return catalog < payNow || remaining <= 0;
  }

  function depositOf() {
    var rule = shopSettings();
    if (rule.payRuleType === "percent" || rule.payRuleType === "custom") return 0;
    return PARTIAL_DEPOSIT;
  }

  function noteOf() {
    var root = shopRoot();
    var cfg = window.PulsePayConfig || {};
    return (root && root.getAttribute("data-note")) || cfg.note || "";
  }

  function productOffIds() {
    var root = shopRoot();
    var cfg = window.PulsePayConfig || {};
    var fromCfg = cfg.productOffIds || [];
    var fromAttr = root && root.getAttribute("data-product-off-ids");
    var list = fromCfg.slice();
    if (fromAttr) {
      String(fromAttr)
        .split(",")
        .forEach(function (id) {
          if (id) list.push(id);
        });
    }
    return list.map(String);
  }

  function flagIsTrue(value) {
    return value === true || value === "true" || value === 1 || value === "1";
  }

  function flagIsFalse(value) {
    return value === false || value === "false" || value === 0 || value === "0";
  }

  function parseProductRaw(raw) {
    if (typeof raw === "string") {
      try {
        raw = JSON.parse(raw);
        if (typeof raw === "string") raw = JSON.parse(raw);
      } catch (error) {
        return { enabled: false, configured: false, useShopRule: true, explicitOff: false };
      }
    }
    var empty =
      raw == null ||
      raw === "" ||
      raw === "{}" ||
      raw === "null" ||
      (typeof raw === "object" && !Array.isArray(raw) && Object.keys(raw).length === 0);
    if (empty) {
      return { enabled: false, configured: false, useShopRule: true, explicitOff: false };
    }
    var keys = raw && typeof raw === "object" ? Object.keys(raw) : [];
    var configured = keys.length > 0;
    var enabled = flagIsTrue(raw.enabled) || flagIsTrue(raw.partialEnabled);
    // Explicit Off only when metafield sets enabled/partialEnabled to false.
    // Missing Liquid #pp-cart-products / empty {} is not Off.
    var explicitOff = !enabled && (flagIsFalse(raw.enabled) || flagIsFalse(raw.partialEnabled));
    var type = raw && raw.payRuleType;
    var useShop =
      type == null ||
      type === "" ||
      String(type).toLowerCase() === "shop" ||
      String(type).toLowerCase() === "default";
    return {
      enabled: Boolean(enabled),
      partialEnabled: Boolean(enabled),
      configured: configured,
      explicitOff: Boolean(explicitOff),
      useShopRule: useShop,
      payRuleType: useShop ? "shop" : String(type).toLowerCase(),
      fixedAmount: raw && raw.fixedAmount,
      percent: raw && raw.percent,
      customAmount: raw && raw.customAmount,
      fullyCodEnabled:
        raw && raw.fullyCodEnabled != null && raw.fullyCodEnabled !== ""
          ? raw.fullyCodEnabled !== false
          : null,
    };
  }

  function productOverridesMap() {
    var parsed = settingsFromJsonTag() || {};
    var cfg = window.PulsePayConfig || {};
    return Object.assign({}, cfg.productOverrides || {}, parsed.productOverrides || {});
  }

  function lookupShopOverride(item) {
    var map = productOverridesMap();
    var id = String((item && (item.product_id || item.productId)) || "").replace(/\D/g, "");
    if (!id) return null;
    var ovr = map[id] || map[Number(id)] || map["gid://shopify/Product/" + id] || null;
    if (!ovr || typeof ovr !== "object") return null;
    if (ovr.explicitOff === true) return ovr;
    if (ovr.enabled === true || ovr.partialEnabled === true) return ovr;
    var type = String(ovr.payRuleType || "shop").toLowerCase();
    if (type && type !== "shop" && type !== "default") return ovr;
    return null;
  }

  function cartCatalog() {
    return Object.assign(
      {},
      jsonFromTag("pp-cart-products-cart"),
      jsonFromTag("pp-cart-products"),
      window.__ppFetchedCatalog || {},
    );
  }

  function catalogRecord(item) {
    var catalog = cartCatalog();
    var id = String((item && item.product_id) || "");
    var rec = catalog[id] || catalog[Number(id)] || catalog["gid://shopify/Product/" + id];
    if (rec && typeof rec === "object") return rec;
    var cfg = window.PulsePayConfig || {};
    var products = cfg.products || {};
    var meta = cfg.productMeta || {};
    var raw = products[id] || products[Number(id)] || products["gid://shopify/Product/" + id];
    var metaRec = meta[id] || meta[Number(id)] || meta["gid://shopify/Product/" + id] || {};
    if (raw || (metaRec && (metaRec.tags || metaRec.collectionIds || metaRec.handle))) {
      return {
        config: raw || {},
        tags: metaRec.tags || [],
        collectionIds: metaRec.collectionIds || [],
        handle: metaRec.handle || "",
      };
    }
    return {};
  }

  function productAllowsFullyCod(item) {
    if (!productAllowsPartial(item)) return false;
    var scheduled = scheduledEnableRuleForItem(item);
    if (scheduled && isScheduleFullyCod(scheduled)) {
      return firstFiniteNumber(scheduled.fullyCodExtra, scheduled.surcharge, 0) > 0;
    }
    var shop = shopSettings();
    if (!shop.fullyCodEnabled || !(Number(shop.surcharge) > 0)) return false;
    var cfg = productConfigOf(item);
    if (cfg.fullyCodEnabled === false) return false;
    return true;
  }

  function listFrom(value, asTags) {
    var list = [];
    if (Array.isArray(value)) list = value.slice();
    else if (value == null || value === "") list = [];
    else list = String(value).split(",");
    var seen = {};
    var out = [];
    list.forEach(function (item) {
      var raw = String(item || "").trim();
      if (!raw) return;
      var key = asTags ? raw.toLowerCase() : collectionNumericId(raw);
      if (!key || seen[key]) return;
      seen[key] = true;
      out.push(asTags ? key : raw);
    });
    return out;
  }

  function collectionNumericId(id) {
    if (id == null || id === "") return "";
    var match = String(id).match(/Collection\/(\d+)/i);
    if (match) return match[1];
    var digits = String(id).replace(/\D/g, "");
    return digits || "";
  }

  function preferProductConfig(primary, fallback) {
    var a = primary || { enabled: false, configured: false, useShopRule: true, explicitOff: false };
    var b = fallback || { enabled: false, configured: false, useShopRule: true, explicitOff: false };
    if (a.useShopRule === false) return a;
    if (b.useShopRule === false) return b;
    if (a.explicitOff) return a;
    if (b.explicitOff) return b;
    if (a.configured) return a;
    if (b.configured) return b;
    if (a.enabled) return a;
    if (b.enabled) return b;
    return a;
  }

  function productConfigOf(item) {
    var rec = catalogRecord(item);
    var fromCatalog = { enabled: false, configured: false, useShopRule: true, explicitOff: false };
    if (rec && rec.config != null) fromCatalog = parseProductRaw(rec.config);
    else if (rec && (rec.enabled != null || rec.partialEnabled != null || rec.payRuleType != null)) {
      fromCatalog = parseProductRaw(rec);
    } else {
      var cfg = window.PulsePayConfig || {};
      var map = cfg.products || {};
      var id = String((item && item.product_id) || "");
      fromCatalog = parseProductRaw(map[id] || map[Number(id)] || map["gid://shopify/Product/" + id] || null);
    }
    var override = lookupShopOverride(item);
    if (!override) return fromCatalog;
    return preferProductConfig(fromCatalog, parseProductRaw(override));
  }

  function productMetaOf(item) {
    var rec = catalogRecord(item);
    if (rec.tags || rec.collectionIds || rec.handle) {
      return { tags: rec.tags || [], collectionIds: rec.collectionIds || [], handle: rec.handle || "" };
    }
    var cfg = window.PulsePayConfig || {};
    var map = cfg.productMeta || {};
    var id = String((item && item.product_id) || "");
    return map[id] || map[Number(id)] || {};
  }

  function storefrontPath(path) {
    var root = (window.Shopify && Shopify.routes && Shopify.routes.root) || "/";
    if (root.charAt(root.length - 1) !== "/") root += "/";
    return root + String(path || "").replace(/^\//, "");
  }

  function mergeCatalogFromHtml(html) {
    if (!html) return;
    var doc;
    try {
      doc = new DOMParser().parseFromString(html, "text/html");
    } catch (error) {
      return;
    }
    ["pp-cart-products", "pp-cart-products-cart"].forEach(function (id) {
      var el = doc.getElementById(id);
      if (!el) return;
      window.__ppFetchedCatalog = Object.assign(
        {},
        window.__ppFetchedCatalog || {},
        parseJsonText(el.textContent || ""),
      );
    });
    var raw = doc.getElementById("pp-shop-settings-raw") || doc.getElementById("pp-shop-settings-cart-raw");
    if (raw) {
      var parsed = parseJsonText(raw.textContent || "");
      if (parsed.productOverrides && typeof parsed.productOverrides === "object") {
        window.PulsePayConfig = Object.assign({}, window.PulsePayConfig || {}, {
          productOverrides: Object.assign(
            {},
            (window.PulsePayConfig && window.PulsePayConfig.productOverrides) || {},
            parsed.productOverrides,
          ),
        });
      }
    }
  }

  function hasOwnPayRule(item) {
    var cfg = productConfigOf(item);
    return Boolean(cfg && (cfg.useShopRule === false || cfg.explicitOff));
  }

  function ensureProductCatalog(cart) {
    var items = productItems(cart);
    var missing = items.filter(function (item) {
      return !hasOwnPayRule(item);
    });
    if (!missing.length) return Promise.resolve();

    var work = fetch(storefrontPath("cart"), { credentials: "same-origin" })
      .then(function (res) {
        return res.text();
      })
      .then(mergeCatalogFromHtml)
      .catch(function () {});

    return work.then(function () {
      var stillMissing = items.filter(function (item) {
        return !hasOwnPayRule(item);
      });
      if (!stillMissing.length) return;
      var handles = [];
      stillMissing.forEach(function (item) {
        var handle = item.handle || (productMetaOf(item) && productMetaOf(item).handle);
        if (!handle || handles.indexOf(handle) !== -1) return;
        handles.push(handle);
      });
      if (!handles.length) return;
      return Promise.all(
        handles.map(function (handle) {
          return fetch(storefrontPath("products/" + handle), { credentials: "same-origin" })
            .then(function (res) {
              return res.text();
            })
            .then(mergeCatalogFromHtml)
            .catch(function () {});
        }),
      );
    });
  }

  function collectionIdsFor(item, meta) {
    var ids = ((meta && meta.collectionIds) || []).slice();
    var root = shopRoot();
    var pageProduct = attrValue(root, "data-product-id");
    var pageCol = attrValue(root, "data-page-collection-id");
    var id = String((item && item.product_id) || "");
    if (pageCol && id && id === pageProduct) ids.push(pageCol);
    return ids;
  }

  function productMatchesTargeting(shop, item, meta) {
    var ruleIds = {};
    (shop.ruleCollectionIds || []).forEach(function (id) {
      var numeric = collectionNumericId(id);
      if (numeric) ruleIds[numeric] = true;
    });
    var ruleTags = {};
    (shop.ruleTags || []).forEach(function (tag) {
      if (tag) ruleTags[String(tag).toLowerCase()] = true;
    });
    var scope = shop.productScope || "all";
    var collectionIds = collectionIdsFor(item, meta);
    var tags = (meta && meta.tags) || [];
    if (scope === "collection") {
      if (!Object.keys(ruleIds).length) return false;
      for (var i = 0; i < collectionIds.length; i += 1) {
        if (ruleIds[collectionNumericId(collectionIds[i])]) return true;
      }
      return false;
    }
    if (scope === "tag") {
      if (!Object.keys(ruleTags).length) return false;
      for (var t = 0; t < tags.length; t += 1) {
        if (ruleTags[String(tags[t] || "").toLowerCase()]) return true;
      }
      return false;
    }
    return scope === "all" && shop.allProductsEnabled !== false;
  }

  function shopTargetingIsOpen(shop) {
    var root = shopRoot();
    if (root && root.getAttribute("data-all-products") === "true") return true;
    if (root && root.getAttribute("data-scope") === "selected") return false;
    var settings = shop || shopSettings();
    return settings.productScope === "all" && settings.allProductsEnabled !== false;
  }

  function scheduledRulesStore() {
    var cfg = window.PulsePayConfig || {};
    var el = document.getElementById("pp-scheduled-rules");
    var parsed = null;
    if (el) {
      try {
        parsed = JSON.parse(el.textContent || "{}");
        if (typeof parsed === "string") parsed = JSON.parse(parsed);
      } catch (error) {
        parsed = null;
      }
    }
    if (Array.isArray(parsed)) return parsed;
    if (parsed && Array.isArray(parsed.rules)) return parsed.rules;
    if (Array.isArray(cfg.scheduledRules)) return cfg.scheduledRules;
    return [];
  }

  function deriveRuleStatus(rule, now) {
    if (!rule || rule.status === "cancelled") return rule ? rule.status : "scheduled";
    var startMs = Date.parse(rule.startAt || "");
    var endMs = Date.parse(rule.endAt || "");
    var nowMs = (now || new Date()).getTime();
    if (!Number.isFinite(startMs) || !Number.isFinite(endMs)) return "scheduled";
    if (nowMs < startMs) return "scheduled";
    if (nowMs >= startMs && nowMs <= endMs) return "active";
    return "ended";
  }

  function productIdKeys(value) {
    var raw = String(value || "").trim();
    if (!raw) return [];
    var digits = raw.replace(/\D/g, "");
    var keys = [raw];
    if (digits) keys.push(digits);
    if (raw.indexOf("/") === -1) keys.push(raw.toLowerCase());
    return keys;
  }

  function ruleMatchesScheduleTarget(rule, item, meta) {
    if (!rule || deriveRuleStatus(rule) !== "active") return false;
    var productId = String((item && (item.product_id || item.productId)) || "");
    var handle = String((meta && meta.handle) || (item && item.handle) || "").toLowerCase();
    var tags = ((meta && meta.tags) || []).map(function (tag) {
      return String(tag || "").trim().toLowerCase();
    });
    var collectionIds = collectionIdsFor(item, meta).map(collectionNumericId);

    if (rule.targetType === "product") {
      var targets = {};
      (rule.targetIds || []).concat((rule.targetPreviews || []).map(function (preview) {
        return preview && preview.id;
      })).forEach(function (id) {
        productIdKeys(id).forEach(function (key) {
          if (key) targets[key] = true;
        });
      });
      (rule.targetPreviews || []).forEach(function (preview) {
        var previewHandle = String((preview && preview.handle) || "").toLowerCase();
        if (previewHandle) targets[previewHandle] = true;
      });
      var keys = productIdKeys(productId);
      if (handle) keys.push(handle);
      return keys.some(function (key) {
        return targets[key];
      });
    }
    if (rule.targetType === "collection") {
      var ruleIds = {};
      (rule.targetIds || []).forEach(function (id) {
        var numeric = collectionNumericId(id);
        if (numeric) ruleIds[numeric] = true;
      });
      return collectionIds.some(function (id) {
        return ruleIds[id];
      });
    }
    if (rule.targetType === "tag") {
      var ruleTags = {};
      (rule.targetTags || []).forEach(function (tag) {
        if (tag) ruleTags[String(tag).toLowerCase()] = true;
      });
      return tags.some(function (tag) {
        return ruleTags[tag];
      });
    }
    return false;
  }

  function scheduledActionForItem(item) {
    var rules = scheduledRulesStore().filter(function (rule) {
      return deriveRuleStatus(rule) === "active";
    });
    var meta = productMetaOf(item);
    var matchedEnable = false;
    for (var i = 0; i < rules.length; i += 1) {
      if (!ruleMatchesScheduleTarget(rules[i], item, meta)) continue;
      if (rules[i].action === "disable_partial") return "disable_partial";
      if (rules[i].action === "enable_partial") matchedEnable = true;
    }
    return matchedEnable ? "enable_partial" : null;
  }

  function isScheduleFullyCod(rule) {
    if (!rule || rule.action === "disable_partial") return false;
    var type = String(rule.payRuleType || "").toLowerCase();
    if (type === "fully_cod" || type === "fullycod") return true;
    return rule.fullyCodEnabled === true || rule.fullyCodEnabled === "true";
  }

  function scheduleUsesOwnPayRule(rule) {
    if (!rule || rule.action === "disable_partial") return false;
    if (rule.useShopPayRule === true || rule.useShopPayRule === "true") return false;
    if (isScheduleFullyCod(rule)) return true;
    return (
      (rule.payRuleType != null && rule.payRuleType !== "") ||
      (rule.payRuleValue != null && rule.payRuleValue !== "") ||
      (rule.fixedAmount != null && rule.fixedAmount !== "") ||
      (rule.percent != null && rule.percent !== "") ||
      (rule.customAmount != null && rule.customAmount !== "") ||
      (rule.surcharge != null && rule.surcharge !== "") ||
      (rule.fullyCodExtra != null && rule.fullyCodExtra !== "")
    );
  }

  function overlayFromSchedule(rule, shop) {
    shop = shop || shopSettings();
    if (!rule || !scheduleUsesOwnPayRule(rule)) return shop;
    if (isScheduleFullyCod(rule)) {
      var extra = firstFiniteNumber(rule.fullyCodExtra, rule.surcharge, shop.surcharge, 500);
      return {
        payRuleType: "custom",
        customAmount: 0,
        fixedAmount: shop.fixedAmount,
        percent: shop.percent,
        fullyCodEnabled: true,
        surcharge: extra > 0 ? extra : 500,
      };
    }
    var type = String(rule.payRuleType || "fixed").toLowerCase();
    if (type === "percentage") type = "percent";
    if (type !== "percent" && type !== "custom") type = "fixed";
    var value = Number(rule.payRuleValue);
    return {
      payRuleType: type,
      fixedAmount:
        type === "fixed"
          ? PARTIAL_DEPOSIT
          : firstFiniteNumber(rule.fixedAmount, value, shop.fixedAmount),
      percent: firstFiniteNumber(rule.percent, type === "percent" ? value : null, shop.percent),
      customAmount: firstFiniteNumber(rule.customAmount, type === "custom" ? value : null, shop.customAmount),
      fullyCodEnabled: shop.fullyCodEnabled,
      surcharge: shop.surcharge,
    };
  }

  function scheduledEnableRuleForItem(item) {
    if (scheduledActionForItem(item) !== "enable_partial") return null;
    var rules = scheduledRulesStore()
      .filter(function (rule) {
        return deriveRuleStatus(rule) === "active" && rule.action === "enable_partial";
      })
      .sort(function (a, b) {
        return Date.parse(b.updatedAt || 0) - Date.parse(a.updatedAt || 0);
      });
    var meta = productMetaOf(item);
    for (var i = 0; i < rules.length; i += 1) {
      if (ruleMatchesScheduleTarget(rules[i], item, meta)) return rules[i];
    }
    return null;
  }

  function isListedOff(item) {
    var id = String((item && item.product_id) || "").replace(/\D/g, "");
    if (!id) return false;
    var offs = productOffIds();
    for (var i = 0; i < offs.length; i += 1) {
      if (String(offs[i] || "").replace(/\D/g, "") === id) return true;
    }
    return false;
  }

  function isExplicitProductOff(item) {
    var cfg = productConfigOf(item);
    return Boolean((cfg && cfg.explicitOff) || isListedOff(item));
  }

  function productAllowsPartial(item) {
    var scheduleAction = scheduledActionForItem(item);
    if (scheduleAction === "disable_partial") return false;
    if (isExplicitProductOff(item)) return false;

    var shop = shopSettings();
    var cfg = productConfigOf(item);
    var enabled = Boolean(cfg.enabled || cfg.partialEnabled);
    if (shop.productScope === "selected") return enabled;
    if (scheduleAction === "enable_partial") {
      return shopOn();
    }
    if (shopTargetingIsOpen(shop)) {
      return true;
    }
    if (enabled) return true;
    return productMatchesTargeting(shop, item, productMetaOf(item));
  }

  function isProductOff(item) {
    return !productAllowsPartial(item);
  }

  function lineRule(item) {
    var shop = shopRule();
    var cfg = productConfigOf(item);
    if (cfg && cfg.useShopRule === false) {
      return {
        payRuleType: cfg.payRuleType,
        fixedAmount:
          String(cfg.payRuleType || "").toLowerCase() === "fixed"
            ? PARTIAL_DEPOSIT
            : Number(cfg.fixedAmount != null ? cfg.fixedAmount : shop.fixedAmount),
        percent: Number(cfg.percent != null ? cfg.percent : shop.percent),
        customAmount: Number(cfg.customAmount != null ? cfg.customAmount : shop.customAmount),
      };
    }
    var scheduled = scheduledEnableRuleForItem(item);
    if (scheduled && scheduleUsesOwnPayRule(scheduled)) return overlayFromSchedule(scheduled, shop);
    if (!cfg || cfg.useShopRule) return shop;
    return {
      payRuleType: cfg.payRuleType,
      fixedAmount:
        String(cfg.payRuleType || "").toLowerCase() === "fixed"
          ? PARTIAL_DEPOSIT
          : Number(cfg.fixedAmount != null ? cfg.fixedAmount : shop.fixedAmount),
      percent: Number(cfg.percent != null ? cfg.percent : shop.percent),
      customAmount: Number(cfg.customAmount != null ? cfg.customAmount : shop.customAmount),
    };
  }

  var PROPERTY_KEYS = [
    "Pay now",
    "Remaining COD",
    "Full price",
    "Status",
    "COD extra",
    "_partial_pay_now",
    "_partial_pay_cod",
    "_partial_full",
    "_partial_status",
    "_partial_surcharge",
    "_partial_unit",
    "_partial_deposit_unit",
    "_partial_info",
    "description",
    "Partial payment",
    "pay_now",
  ];

  function emptyProperties() {
    var props = {};
    PROPERTY_KEYS.forEach(function (key) {
      props[key] = "";
    });
    return props;
  }

  function propsOf(item) {
    return (item && item.properties) || {};
  }

  function isSurcharge(item) {
    var props = propsOf(item);
    return props._cod_surcharge === "1" || props._cod_surcharge === 1;
  }

  function isLeftoverInfo(item) {
    return propsOf(item)._partial_info === "1";
  }

  function catalogOf(item) {
    var props = propsOf(item);
    var extra = parseMoney(props["COD extra"] || props._partial_surcharge);
    var full = parseMoney(props["Full price"] || props._partial_full);
    var remaining = parseMoney(props["Remaining COD"] || props._partial_pay_cod);
    var payNow = parseMoney(props["Pay now"] || props._partial_pay_now);
    var status = String(props.Status || props._partial_status || "").toLowerCase();
    var unpaid = status.indexOf("unpaid") !== -1;
    // FULLY COD: Remaining COD and visible Full price are catalog (not catalog+extra).
    if (extra > 0 && remaining > 0 && (unpaid || Math.abs(payNow - extra) < 0.02)) {
      if (full > 0 && Math.abs(full - remaining) < 0.02) return remaining;
      if (payNow > 0) return remaining;
    }
    // Legacy FULLY COD baked catalog+extra into Full price with Pay now 0.
    if (extra > 0 && full > extra && payNow <= 0) {
      return Math.round((full - extra) * 100) / 100;
    }
    if (full > 0 && extra <= 0) return full;
    var qty = Number(item.quantity) || 1;
    if (item.original_line_price != null && item.original_line_price !== "") {
      return Number(item.original_line_price) / 100;
    }
    if (item.original_price != null) {
      return (Number(item.original_price) / 100) * qty;
    }
    return (Number(item.price || 0) / 100) * qty;
  }

  function productItems(cart) {
    return (cart.items || []).filter(function (item) {
      return !isSurcharge(item) && !isLeftoverInfo(item) && catalogOf(item) > 0;
    });
  }

  function fullyCodEligibleItems(cart) {
    return productItems(cart).filter(function (item) {
      return productAllowsFullyCod(item);
    });
  }

  function eligibleItems(cart) {
    return productItems(cart).filter(function (item) {
      return !isProductOff(item);
    });
  }

  function offItems(cart) {
    return productItems(cart).filter(function (item) {
      return isProductOff(item);
    });
  }

  function computeLineDeposits(items) {
    var shop = shopRule();
    var shares = items.map(function () {
      return 0;
    });
    var extras = items.map(function () {
      return 0;
    });
    var modes = items.map(function () {
      return "shop";
    });
    var groups = {};

    function addGroup(key, index, settings) {
      if (!groups[key]) groups[key] = { indexes: [], settings: settings };
      groups[key].indexes.push(index);
    }

    items.forEach(function (item, index) {
      var cfg = productConfigOf(item);
      if (cfg && cfg.useShopRule === false) {
        shares[index] = depositForCartTotal(catalogOf(item), lineRule(item));
        modes[index] = "override";
        return;
      }
      var scheduled = scheduledEnableRuleForItem(item);
      if (scheduled && isScheduleFullyCod(scheduled)) {
        modes[index] = "fully_cod";
        extras[index] = firstFiniteNumber(scheduled.fullyCodExtra, scheduled.surcharge, shop.surcharge, 500);
        return;
      }
      if (scheduled && scheduleUsesOwnPayRule(scheduled)) {
        addGroup("schedule:" + String(scheduled.id || index), index, overlayFromSchedule(scheduled, shop));
        modes[index] = "schedule";
        return;
      }
      addGroup("shop", index, shop);
    });

    var extraGroups = {};
    items.forEach(function (item, index) {
      if (modes[index] !== "fully_cod") return;
      var scheduled = scheduledEnableRuleForItem(item);
      var key = "cod:" + String((scheduled && scheduled.id) || index);
      if (!extraGroups[key]) {
        extraGroups[key] = {
          indexes: [],
          extra: firstFiniteNumber(
            scheduled && scheduled.fullyCodExtra,
            scheduled && scheduled.surcharge,
            shop.surcharge,
            500,
          ),
        };
      }
      extraGroups[key].indexes.push(index);
    });
    Object.keys(extraGroups).forEach(function (key) {
      var group = extraGroups[key];
      var allocated = allocateShares(
        group.indexes.map(function (index) {
          return catalogOf(items[index]);
        }),
        group.extra,
      );
      group.indexes.forEach(function (index, position) {
        extras[index] = allocated[position];
      });
    });

    Object.keys(groups).forEach(function (key) {
      var group = groups[key];
      var subtotal = 0;
      group.indexes.forEach(function (index) {
        subtotal += catalogOf(items[index]);
      });
      subtotal = Math.round(subtotal * 100) / 100;
      var deposit = depositForCartTotal(subtotal, group.settings);
      var allocated = allocateShares(
        group.indexes.map(function (index) {
          return catalogOf(items[index]);
        }),
        deposit,
      );
      group.indexes.forEach(function (index, position) {
        shares[index] = allocated[position];
      });
    });

    var payNow = 0;
    shares.forEach(function (amount, index) {
      payNow += Number(amount || 0) + Number(extras[index] || 0);
    });
    return {
      shares: shares,
      extras: extras,
      modes: modes,
      payNow: Math.round(payNow * 100) / 100,
    };
  }

  function cartCatalogTotal(items) {
    return items.reduce(function (sum, item) {
      return Math.round((sum + catalogOf(item)) * 100) / 100;
    }, 0);
  }

  function cartItemCount(items) {
    return items.reduce(function (sum, item) {
      return sum + (Number(item.quantity) || 1);
    }, 0);
  }

  function allocateShares(amounts, deposit) {
    var sum = amounts.reduce(function (a, b) {
      return a + b;
    }, 0);
    if (!(sum > 0) || !amounts.length) {
      return amounts.map(function () {
        return 0;
      });
    }
    var depositCents = Math.round(Number(deposit) * 100);
    var shares = [];
    var used = 0;
    for (var i = 0; i < amounts.length; i++) {
      var shareCents;
      if (i === amounts.length - 1) {
        shareCents = depositCents - used;
      } else {
        shareCents = Math.round((amounts[i] / sum) * depositCents);
        if (used + shareCents > depositCents) shareCents = depositCents - used;
      }
      if (shareCents < 0) shareCents = 0;
      shares.push(shareCents / 100);
      used += shareCents;
    }
    return shares;
  }

  function paymentFromShare(item, payNowShare) {
    var qty = Number(item.quantity) || 1;
    var full = Math.round(catalogOf(item) * 100) / 100;
    var payNow = Math.round(Number(payNowShare) * 100) / 100;
    if (payNow > full) payNow = full;
    var unit = qty > 0 ? Math.round((full / qty) * 100) / 100 : full;
    return {
      payNow: payNow,
      payCod: Math.round((full - payNow) * 100) / 100,
      fullPrice: full,
      surcharge: 0,
      status: "partial_paid",
      unitPrice: unit,
      depositPerUnit: qty > 0 ? Math.round((payNow / qty) * 100) / 100 : payNow,
    };
  }

  function surchargeSettings() {
    var cfg = window.PulsePayConfig || {};
    var jsonCfg = settingsFromJsonTag();
    var root = shopRoot();
    return {
      amount: firstFiniteNumber(cfg.surcharge, jsonCfg.surcharge, attrValue(root, "data-surcharge"), 500),
    };
  }

  function visibleProperties(payment, symbol) {
    var props = {
      "Pay now": money(payment.payNow, symbol),
      "Remaining COD": money(payment.payCod, symbol),
      "Full price": money(payment.fullPrice, symbol),
      Status: payment.status === "unpaid_cod" ? "Unpaid (COD)" : "Partial paid",
      "COD extra": "",
    };
    if (Number(payment.surcharge) > 0) {
      props["COD extra"] = money(payment.surcharge, symbol);
    }
    return props;
  }

  function paymentFromFullyCod(item, extraShare) {
    var qty = Number(item.quantity) || 1;
    var catalog = Math.round(catalogOf(item) * 100) / 100;
    var extra = Math.round(Number(extraShare || 0) * 100) / 100;
    if (extra < 0) extra = 0;
    var unitCatalog = qty > 0 ? Math.round((catalog / qty) * 100) / 100 : catalog;
    var unitExtra = qty > 0 ? Math.round((extra / qty) * 100) / 100 : extra;
    return {
      payNow: extra,
      payCod: catalog,
      fullPrice: catalog,
      surcharge: extra,
      status: "unpaid_cod",
      unitPrice: unitCatalog,
      depositPerUnit: unitExtra,
    };
  }

  function removeSurchargeLines(cart) {
    var surchargeItems = (cart.items || []).filter(isSurcharge);
    return surchargeItems.reduce(function (chain, item) {
      return chain.then(function () {
        return fetchJson("/cart/change.js", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ id: item.key, quantity: 0 }),
        });
      });
    }, Promise.resolve());
  }

  function fetchJson(url, options) {
    var next = Object.assign({ credentials: "same-origin" }, options || {});
    next.headers = Object.assign({ Accept: "application/json", "X-PulsePay": "1" }, next.headers || {});
    return fetch(url, next).then(function (response) {
      return response.json().then(function (data) {
        if (!response.ok) {
          throw new Error(data.description || data.message || "Cart request failed");
        }
        return data;
      });
    });
  }

  function cartJson() {
    return fetchJson("/cart.js");
  }

  function changeLine(item, properties) {
    return fetchJson("/cart/change.js", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        id: item.key,
        quantity: item.quantity,
        properties: properties,
      }),
    });
  }

  function matchCartItem(cart, item) {
    var items = (cart && cart.items) || [];
    var byKey = items.find(function (row) {
      return row.key === item.key;
    });
    if (byKey) return byKey;
    var variantId = String(item.variant_id || "");
    if (!variantId) return null;
    return items.find(function (row) {
      return String(row.variant_id) === variantId && !isSurcharge(row) && !isLeftoverInfo(row);
    });
  }

  function changeLineFresh(item, properties) {
    return cartJson().then(function (cart) {
      var current = matchCartItem(cart, item) || item;
      return changeLine(current, properties);
    });
  }

  function updateCartAttributes(attrs) {
    return fetchJson("/cart/update.js", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ attributes: attrs }),
    });
  }

  function clearPartialCartAttributes() {
    return updateCartAttributes({
      partial_deposit: "",
      partial_remaining_cod: "",
      partial_full_price: "",
      partial_payment_status: "",
      partial_item_count: "",
    });
  }

  function setPartialCartAttributes(payments, symbol, deposit, statusLabel) {
    var payNow = payments.reduce(function (sum, row) {
      return sum + Number(row.payNow || 0);
    }, 0);
    var payCod = payments.reduce(function (sum, row) {
      return sum + Number(row.payCod || 0);
    }, 0);
    var surcharge = payments.reduce(function (sum, row) {
      return sum + Number(row.surcharge || 0);
    }, 0);
    var full = payments.reduce(function (sum, row) {
      return sum + Number(row.fullPrice || 0);
    }, 0);
    if (surcharge > 0 && payNow > 0) {
      full = Math.round((payNow + payCod) * 100) / 100;
    }
    return updateCartAttributes({
      partial_deposit: money(deposit != null ? deposit : payNow, symbol),
      partial_remaining_cod: money(payCod, symbol),
      partial_full_price: money(full, symbol),
      partial_payment_status: statusLabel || "Partial paid",
      partial_item_count: String(payments.length),
    });
  }

  function itemImageSrc(item) {
    if (!item) return "";
    if (typeof item.image === "string" && item.image) return item.image;
    if (item.image && typeof item.image === "object") {
      return item.image.url || item.image.src || "";
    }
    var featured = item.featured_image;
    if (typeof featured === "string" && featured) return featured;
    if (featured && typeof featured === "object") return featured.url || featured.src || "";
    return "";
  }

  function fillModalThumbs(modal, cart) {
    var row = modal && modal.querySelector("[data-pp-item-thumbs]");
    if (!row) return;
    row.innerHTML = "";
    var items = productItems(cart);
    items.slice(0, 4).forEach(function (item) {
      var src = itemImageSrc(item);
      var node = document.createElement(src ? "img" : "span");
      node.className = "pp-modal__thumb";
      if (src) {
        node.src = src;
        node.alt = item.product_title || item.title || "";
      }
      row.appendChild(node);
    });
    if (items.length > 4) {
      var more = document.createElement("span");
      more.className = "pp-modal__thumb pp-modal__thumb--more";
      more.textContent = "+" + (items.length - 4);
      row.appendChild(more);
    }
    row.hidden = items.length === 0;
  }

  function chainItems(items, worker) {
    return items.reduce(function (chain, item, index) {
      return chain.then(function () {
        return worker(item, index);
      });
    }, Promise.resolve());
  }

  function ensureModal() {
    var existing = document.getElementById("pp-pay-modal");
    if (existing && existing.querySelector('[data-pp-ui="v4"]')) {
      return existing;
    }
    if (existing) existing.remove();
    var wrap = document.createElement("div");
    wrap.id = "pp-pay-modal";
    wrap.className = "pp-modal";
    wrap.hidden = true;
    wrap.innerHTML =
      '<div class="pp-modal__overlay" data-pp-dismiss></div>' +
      '<div class="pp-modal__dialog" data-pp-ui="v4" role="dialog" aria-modal="true" aria-labelledby="pp-pay-title" tabindex="-1">' +
      '<div class="pp-modal__hero">' +
      '<div class="pp-modal__thumbs" data-pp-item-thumbs></div>' +
      '<div class="pp-modal__header-text">' +
      '<h2 id="pp-pay-title">Order summary</h2>' +
      '<p class="pp-modal__count" data-pp-item-count></p>' +
      "</div>" +
      '<div class="pp-modal__total">' +
      "<span>Total</span>" +
      '<strong class="pp-modal__header-price" data-pp-header-price></strong>' +
      "</div>" +
      '<button type="button" class="pp-modal__close" data-pp-dismiss aria-label="Close">' +
      '<svg viewBox="0 0 20 20" width="14" height="14" aria-hidden="true"><path d="M5 5l10 10M15 5L5 15" stroke="currentColor" stroke-width="2" fill="none" stroke-linecap="round"/></svg>' +
      "</button>" +
      "</div>" +
      '<div class="pp-modal__body">' +
      '<p class="pp-modal__section">Pay via</p>' +
      '<div class="pp-modal__error" data-pp-error hidden></div>' +
      '<div class="pp-modal__choices" role="radiogroup" aria-label="Pay via">' +
      '<button type="button" class="pp-modal__choice is-selected" role="radio" aria-checked="true" data-pp-choice="full">' +
      '<span class="pp-modal__radio" aria-hidden="true"></span>' +
      '<span class="pp-modal__choice-body">' +
      '<span class="pp-modal__choice-row">' +
      '<span class="pp-modal__choice-title">Full Payment <em>Prepaid</em></span>' +
      '<span class="pp-modal__choice-amount" data-pp-full-price></span>' +
      "</span>" +
      '<span class="pp-modal__choice-copy" data-pp-full-copy></span>' +
      '<span class="pp-modal__choice-warning" data-pp-full-warning hidden>' +
      '<span data-pp-full-warning-main></span>' +
      '<span class="pp-modal__choice-warning-sub" data-pp-full-warning-sub></span>' +
      "</span>" +
      "</span>" +
      "</button>" +
      '<button type="button" class="pp-modal__choice" role="radio" aria-checked="false" data-pp-choice="partial">' +
      '<span class="pp-modal__radio" aria-hidden="true"></span>' +
      '<span class="pp-modal__choice-body">' +
      '<span class="pp-modal__choice-row">' +
      '<span class="pp-modal__choice-title">Partial Payment <em>Deposit</em></span>' +
      '<span class="pp-modal__choice-amount" data-pp-deposit-label></span>' +
      "</span>" +
      '<span class="pp-modal__split">' +
      '<span class="pp-modal__split-item"><span>Pay now</span><strong data-pp-partial-now></strong></span>' +
      '<span class="pp-modal__split-item"><span>On delivery</span><strong data-pp-partial-due></strong></span>' +
      "</span>" +
      '<span class="pp-modal__choice-copy" data-pp-partial-copy></span>' +
      "</span>" +
      "</button>" +
      '<button type="button" class="pp-modal__choice" role="radio" aria-checked="false" data-pp-choice="cod">' +
      '<span class="pp-modal__radio" aria-hidden="true"></span>' +
      '<span class="pp-modal__choice-body">' +
      '<span class="pp-modal__choice-row">' +
      '<span class="pp-modal__choice-title">FULLY COD <em>Extra now</em></span>' +
      '<span class="pp-modal__choice-amount" data-pp-cod-checkout></span>' +
      "</span>" +
      '<span class="pp-modal__split">' +
      '<span class="pp-modal__split-item"><span>Pay now</span><strong data-pp-cod-now></strong></span>' +
      '<span class="pp-modal__split-item"><span>On delivery</span><strong data-pp-cod-due></strong></span>' +
      "</span>" +
      '<span class="pp-modal__choice-copy" data-pp-cod-copy></span>' +
      '<span class="pp-modal__choice-hint" data-pp-cod-hint hidden></span>' +
      "</span>" +
      "</button>" +
      "</div>" +
      '<p class="pp-modal__tax">Inclusive of taxes</p>' +
      '<p class="pp-modal__note" data-pp-note hidden></p>' +
      '<button type="button" class="pp-modal__continue" data-pp-continue>Continue</button>' +
      "</div>" +
      "</div>";
    document.body.appendChild(wrap);
    wrap.addEventListener("click", function (event) {
      if (event.target.closest("[data-pp-dismiss]")) {
        event.preventDefault();
        closeModal();
        return;
      }
      if (event.target.closest("[data-pp-continue]")) {
        event.preventDefault();
        confirmChoice(selectedMode);
        return;
      }
      var choice = event.target.closest("[data-pp-choice]");
      if (choice && !choice.disabled && !choice.hidden) {
        event.preventDefault();
        var mode = choice.getAttribute("data-pp-choice");
        if (choice.classList.contains("is-selected") && choice.getAttribute("data-pp-armed") === "1") {
          confirmChoice(mode);
        } else {
          selectChoice(mode);
          modalChoicesArm(mode);
        }
      }
    });
    return wrap;
  }

  function selectChoice(mode) {
    selectedMode = mode === "partial" ? "partial" : mode === "cod" ? "cod" : "full";
    var modal = document.getElementById("pp-pay-modal");
    if (!modal) return;
    modal.querySelectorAll("[data-pp-choice]").forEach(function (el) {
      var on = el.getAttribute("data-pp-choice") === selectedMode;
      el.classList.toggle("is-selected", on);
      el.setAttribute("aria-checked", on ? "true" : "false");
    });
    modal.setAttribute("data-selected", selectedMode);
  }

  function modalChoicesArm(mode) {
    var modal = document.getElementById("pp-pay-modal");
    if (!modal) return;
    modal.querySelectorAll("[data-pp-choice]").forEach(function (el) {
      el.setAttribute("data-pp-armed", el.getAttribute("data-pp-choice") === mode ? "1" : "0");
    });
  }

  function focusable(dialog) {
    return Array.prototype.slice
      .call(
        dialog.querySelectorAll(
          'button:not([disabled]):not([hidden]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
        ),
      )
      .filter(function (el) {
        return el.offsetParent !== null || el === dialog;
      });
  }

  function trapFocus(event) {
    var modal = document.getElementById("pp-pay-modal");
    if (!modal || modal.hidden || event.key !== "Tab") return;
    var dialog = modal.querySelector(".pp-modal__dialog");
    var nodes = focusable(dialog);
    if (!nodes.length) return;
    var first = nodes[0];
    var last = nodes[nodes.length - 1];
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  }

  function openModal(cart, form) {
    var items = eligibleItems(cart);
    if (!items.length && shopTargetingIsOpen()) {
      items = productItems(cart).filter(function (item) {
        return !isExplicitProductOff(item);
      });
    }
    if (!items.length) return false;
    var modal = ensureModal();
    var symbol = symbolOf();
    var codItems = fullyCodEligibleItems(cart);
    var allItems = productItems(cart);
    var eligibleTotal = cartCatalogTotal(items);
    var codEligibleTotal = cartCatalogTotal(codItems);
    var fullTotal = cartCatalogTotal(allItems);
    var computed = computeLineDeposits(items);
    items.forEach(function (item) {
      var cfg = productConfigOf(item);
      console.log("[partial-payment] line rule", item.product_id, {
        payRuleType: cfg.payRuleType,
        useShopRule: cfg.useShopRule,
        customAmount: cfg.customAmount,
        configured: cfg.configured,
      });
    });
    var deposit = computed.payNow;
    var qty = cartItemCount(allItems);
    var remainingCatalog = Math.round((eligibleTotal - (computed.shares || []).reduce(function (sum, amount) {
      return sum + Number(amount || 0);
    }, 0)) * 100) / 100;
    if (remainingCatalog < 0) remainingCatalog = 0;
    var remaining = remainingCatalog;
    var shopCfg = shopSettings();
    var shop = shopRule();
    var scheduleCodCount = (computed.modes || []).filter(function (mode) {
      return mode === "fully_cod";
    }).length;
    var onlyScheduleCod = items.length > 0 && scheduleCodCount === items.length;
    var depositOnly = Math.round(
      (computed.shares || []).reduce(function (sum, amount) {
        return sum + Number(amount || 0);
      }, 0) * 100,
    ) / 100;
    var allowPartial = !onlyScheduleCod && items.length > 0 && depositOnly > 0 && depositOnly < eligibleTotal;
    if (!onlyScheduleCod && scheduleCodCount && deposit > 0) allowPartial = true;
    var surchargeCfg = surchargeSettings();
    var codExtra = Number(surchargeCfg.amount) > 0 ? Number(surchargeCfg.amount) : 500;
    var allowFullyCod =
      (shopCfg.fullyCodEnabled && codItems.length > 0 && codEligibleTotal > 0) || scheduleCodCount > 0;
    if (onlyScheduleCod) {
      allowPartial = false;
      allowFullyCod = true;
    }
    var fullOnly = !allowPartial && !allowFullyCod;
    var remainingCodCatalog = allowFullyCod ? (scheduleCodCount ? eligibleTotal : codEligibleTotal) : 0;
    var extraTotal = Math.round(
      (computed.extras || []).reduce(function (sum, amount) {
        return sum + Number(amount || 0);
      }, 0) * 100,
    ) / 100;
    var remainingCatalog = remainingCodCatalog;
    var codCheckout = allowFullyCod ? (onlyScheduleCod && extraTotal > 0 ? extraTotal : codExtra) : 0;
    var error = modal.querySelector("[data-pp-error]");
    var partialBtn = modal.querySelector('[data-pp-choice="partial"]');
    var codBtn = modal.querySelector('[data-pp-choice="cod"]');
    pending = {
      cart: cart,
      form: form,
      items: items,
      codItems: codItems,
      allItems: allItems,
      total: eligibleTotal,
      codTotal: codEligibleTotal,
      fullTotal: fullTotal,
      deposit: deposit,
      shares: computed.shares,
      extras: computed.extras || [],
      modes: computed.modes || [],
      orderSurcharge: onlyScheduleCod && extraTotal > 0 ? extraTotal : codExtra,
      fullOnly: fullOnly,
    };
    if (error) {
      error.hidden = true;
      error.textContent = "";
    }
    function setText(selector, text) {
      var node = modal.querySelector(selector);
      if (node) node.textContent = text;
    }
    setText("[data-pp-header-price]", money(fullTotal, symbol));
    setText("[data-pp-item-count]", qty === 1 ? "1 item" : qty + " items");
    setText("[data-pp-deposit-label]", money(deposit, symbol));
    setText("[data-pp-full-price]", money(fullTotal, symbol));
    setText("[data-pp-partial-now]", money(deposit, symbol));
    setText("[data-pp-partial-due]", money(remaining, symbol));
    setText("[data-pp-cod-now]", allowFullyCod ? money(codCheckout, symbol) : "—");
    setText("[data-pp-cod-due]", allowFullyCod ? money(remainingCatalog, symbol) : "—");
    fillModalThumbs(modal, cart);
    var fullCopyEl = modal.querySelector("[data-pp-full-copy]");
    if (fullCopyEl) {
      fullCopyEl.textContent = "";
      fullCopyEl.hidden = true;
    }
    var warningEl = modal.querySelector("[data-pp-full-warning]");
    var warningMain = modal.querySelector("[data-pp-full-warning-main]");
    var warningSub = modal.querySelector("[data-pp-full-warning-sub]");
    if (warningEl) {
      warningEl.hidden = !fullOnly;
      if (warningMain) {
        warningMain.textContent = fullOnly ? "Partial is not available for this price." : "";
      }
      if (warningSub) {
        warningSub.textContent = "";
        warningSub.hidden = true;
      }
    }
    modal.classList.toggle("is-full-only", Boolean(fullOnly));
    if (fullOnly) {
      console.log("[partial-payment] full-only popup: shop Pay now cannot leave Remaining COD");
    }
    var mixed = offItems(cart).length > 0;
    var mixedNote = mixed ? "Some items stay at catalog price." : "";
    var partialCopyEl = modal.querySelector("[data-pp-partial-copy]");
    if (partialCopyEl) {
      partialCopyEl.textContent = mixedNote;
      partialCopyEl.hidden = !mixedNote;
    }
    var codCopyEl = modal.querySelector("[data-pp-cod-copy]");
    if (codCopyEl) {
      codCopyEl.textContent = mixedNote;
      codCopyEl.hidden = !mixedNote;
    }
    setText("[data-pp-cod-checkout]", allowFullyCod ? money(codCheckout, symbol) : "—");
    var hintEl = modal.querySelector("[data-pp-cod-hint]");
    if (hintEl) {
      hintEl.textContent = "";
      hintEl.hidden = true;
    }
    var noteEl = modal.querySelector("[data-pp-note]");
    if (noteEl) {
      noteEl.textContent = "";
      noteEl.hidden = true;
    }
    if (partialBtn) {
      partialBtn.hidden = !allowPartial;
      partialBtn.disabled = !allowPartial;
    }
    if (codBtn) {
      codBtn.hidden = !allowFullyCod;
      codBtn.disabled = !allowFullyCod;
    }
    selectChoice("full");
    modalChoicesArm("");
    lastFocus = document.activeElement;
    modal.hidden = false;
    document.documentElement.classList.add("pp-modal-open");
    document.body.classList.add("pp-modal-open");
    var dialog = modal.querySelector(".pp-modal__dialog");
    window.setTimeout(function () {
      var continueBtn = modal.querySelector("[data-pp-continue]");
      if (continueBtn) continueBtn.focus();
      else dialog.focus();
    }, 10);
  }

  function closeModal() {
    var modal = document.getElementById("pp-pay-modal");
    if (modal) {
      modal.hidden = true;
      modal.classList.remove("is-busy");
      modal.classList.remove("is-full-only");
    }
    document.documentElement.classList.remove("pp-modal-open");
    document.body.classList.remove("pp-modal-open");
    pending = null;
    selectedMode = "full";
    if (lastFocus && lastFocus.focus) lastFocus.focus();
    lastFocus = null;
  }

  function setBusy(busy, message) {
    var modal = document.getElementById("pp-pay-modal");
    if (!modal) return;
    modal.classList.toggle("is-busy", Boolean(busy));
    modal.querySelectorAll("[data-pp-choice], [data-pp-continue]").forEach(function (btn) {
      if (!btn.hidden) btn.disabled = Boolean(busy);
    });
    var error = modal.querySelector("[data-pp-error]");
    if (error && message) {
      error.hidden = false;
      error.textContent = message;
    } else if (error && !busy) {
      error.hidden = true;
    }
  }

  function skipFlag(form) {
    if (!form || !form.getAttribute) return false;
    return form.getAttribute("data-pp-skip") === "1" || form.getAttribute("data-pp-proceed") === "1";
  }

  function clearSkipFlag(form) {
    if (!form || !form.removeAttribute) return;
    form.removeAttribute("data-pp-skip");
    form.removeAttribute("data-pp-proceed");
  }

  function goCheckout(form) {
    redirecting = true;
    form = form || (pending && pending.form);
    closeModal();
    if (form && form.getAttribute) form.setAttribute("data-pp-skip", "1");
    window.location.href = checkoutUrl();
  }

  function confirmChoice(mode) {
    if (!pending) return;
    if (pending.fullOnly) mode = "full";
    var items = pending.items || [];
    var codItems = pending.codItems || [];
    var skipped = offItems(pending.cart || { items: [] });
    var total = pending.total || 0;
    var symbol = symbolOf();
    var computed = pending.shares
      ? {
          shares: pending.shares,
          extras: pending.extras || [],
          modes: pending.modes || [],
          payNow: pending.deposit,
        }
      : computeLineDeposits(items);
    var deposit = computed.payNow;
    var usePartial = mode === "partial" && items.length > 0 && deposit > 0;
    var useFullyCod = mode === "cod" && (codItems.length > 0 || (computed.modes || []).indexOf("fully_cod") !== -1);
    var surchargeCfg = surchargeSettings();
    var orderSurcharge = Number(pending.orderSurcharge || surchargeCfg.amount) > 0 ? Number(pending.orderSurcharge || surchargeCfg.amount) : 500;
    setBusy(true);

    var work = Promise.resolve();
    if (useFullyCod) {
      if (!codItems.length) {
        codItems = items.filter(function (item, index) {
          return (computed.modes || [])[index] === "fully_cod";
        });
      }
      var extraShares = allocateShares(
        codItems.map(function (item) {
          return catalogOf(item);
        }),
        orderSurcharge,
      );
      var sourceItems = pending.items || items;
      var codPayments = [];
      var codKeys = {};
      codItems.forEach(function (item) {
        codKeys[item.key] = true;
      });
      work = chainItems(codItems, function (item, index) {
        var extraShare = extraShares[index];
        var sourceIndex = sourceItems.indexOf(item);
        if (sourceIndex < 0) {
          for (var s = 0; s < sourceItems.length; s += 1) {
            if (sourceItems[s] && sourceItems[s].key === item.key) {
              sourceIndex = s;
              break;
            }
          }
        }
        if (sourceIndex >= 0 && computed.extras && Number(computed.extras[sourceIndex]) > 0) {
          extraShare = computed.extras[sourceIndex];
        }
        var payment = paymentFromFullyCod(item, extraShare);
        codPayments.push(payment);
        return changeLineFresh(item, visibleProperties(payment, symbol));
      })
        .then(function () {
          return chainItems(items, function (item) {
            if (codKeys[item.key]) return Promise.resolve();
            var props = propsOf(item);
            var hasPartial =
              props["Pay now"] != null ||
              props["Remaining COD"] != null ||
              props._partial_pay_now != null;
            if (!hasPartial) return Promise.resolve();
            return changeLineFresh(item, emptyProperties());
          });
        })
        .then(function () {
          return chainItems(skipped, function (item) {
            var props = propsOf(item);
            var hasPartial =
              props["Pay now"] != null ||
              props["Remaining COD"] != null ||
              props._partial_pay_now != null;
            if (!hasPartial) return Promise.resolve();
            return changeLineFresh(item, emptyProperties());
          });
        })
        .then(function () {
          var extraNow = codPayments.reduce(function (sum, row) {
            return sum + Number(row.payNow || 0);
          }, 0);
          extraNow = Math.round(extraNow * 100) / 100;
          return setPartialCartAttributes(codPayments, symbol, extraNow, "Unpaid (COD)");
        })
        .then(function () {
          return cartJson();
        })
        .then(function (cart) {
          return removeSurchargeLines(cart);
        });
    } else if (usePartial) {
      var shares = computed.shares || [];
      var extras = computed.extras || [];
      var modes = computed.modes || [];
      var payments = [];
      work = chainItems(items, function (item, index) {
        if (modes[index] === "fully_cod") {
          var extraPayment = paymentFromFullyCod(item, extras[index]);
          payments.push(extraPayment);
          return changeLineFresh(item, visibleProperties(extraPayment, symbol));
        }
        var share = shares[index];
        if (!(share > 0) || share >= catalogOf(item)) {
          payments.push({ payNow: 0, payCod: 0, fullPrice: catalogOf(item) });
          return changeLineFresh(item, emptyProperties());
        }
        var payment = paymentFromShare(item, share);
        payments.push(payment);
        return changeLineFresh(item, visibleProperties(payment, symbol));
      })
        .then(function () {
          return chainItems(skipped, function (item) {
            var props = propsOf(item);
            var hasPartial =
              props._partial_pay_now != null ||
              props.pay_now != null ||
              props["Pay now"] != null ||
              props["Remaining COD"] != null;
            if (!hasPartial) return Promise.resolve();
            return changeLineFresh(item, emptyProperties());
          });
        })
        .then(function () {
          return setPartialCartAttributes(payments, symbol, deposit, "Partial paid");
        })
        .then(function () {
          return cartJson();
        })
        .then(function (cart) {
          return removeSurchargeLines(cart);
        });
    } else {
      var allItems = ((pending.cart && pending.cart.items) || []).filter(function (item) {
        return !isSurcharge(item);
      });
      work = chainItems(allItems, function (item) {
        var props = propsOf(item);
        var hasPartial =
          props._partial_pay_now != null ||
          props.pay_now != null ||
          props["Pay now"] != null ||
          props["Remaining COD"] != null;
        if (!hasPartial) return Promise.resolve();
        return changeLineFresh(item, emptyProperties());
      })
        .then(function () {
          return removeSurchargeLines(pending.cart || { items: [] });
        })
        .then(function () {
          return clearPartialCartAttributes();
        });
    }

    work
      .then(function () {
        goCheckout();
      })
      .catch(function (error) {
        var msg = (error && error.message) || "Could not update cart. Try again.";
        setBusy(false, msg);
      });
  }

  /* ---- Checkout intercept: drawer, cart page, Dawn cart-notification ---- */

  function nodeClassName(node) {
    if (!node) return "";
    if (typeof node.className === "string") return node.className;
    if (node.className && node.className.baseVal) return node.className.baseVal;
    return "";
  }

  function controlLabel(node) {
    if (!node) return "";
    return [
      node.getAttribute && node.getAttribute("aria-label"),
      node.getAttribute && node.getAttribute("title"),
      node.value,
      node.innerText,
      node.textContent,
    ]
      .map(function (value) {
        return String(value || "")
          .replace(/\s+/g, " ")
          .trim()
          .toLowerCase();
      })
      .filter(Boolean);
  }

  function isEnglishCheckoutLabel(node) {
    return controlLabel(node).some(function (text) {
      return (
        text === "checkout" ||
        text === "check out" ||
        text === "check-out" ||
        /^check\s*out$/.test(text)
      );
    });
  }

  function isInNotification(node) {
    if (!node) return false;
    var id = String(node.id || "");
    if (
      id === "cart-notification-form" ||
      id === "CartNotification-Form" ||
      id === "CartNotification-Checkout" ||
      id === "cart-notification"
    ) {
      return true;
    }
    if (!node.closest) return false;
    return Boolean(node.closest(NOTIFICATION_ROOT_SELECTOR));
  }

  function isNotificationCheckoutForm(form) {
    if (!form || !form.tagName || String(form.tagName).toLowerCase() !== "form") return false;
    var id = String(form.id || "");
    if (id === "cart-notification-form" || id === "CartNotification-Form") return true;
    if (form.matches && form.matches(NOTIFICATION_FORM_SELECTOR)) return true;
    if (isInNotification(form) && form.querySelector && form.querySelector('[name="checkout"]')) return true;
    return false;
  }

  function isInDrawer(node) {
    if (!node || !node.closest) return false;
    if (isInNotification(node)) return false;
    return Boolean(node.closest("#CartDrawer, cart-drawer, .cart-drawer, #CartDrawer-Form, .drawer"));
  }

  function checkoutSource(node, form) {
    var el = node || form;
    if (isInNotification(el) || isNotificationCheckoutForm(form) || isNotificationCheckoutForm(el)) {
      return "notification";
    }
    if (isInDrawer(el) || isInDrawer(form)) return "drawer";
    return "page";
  }

  function isExplicitCartCheckout(node) {
    if (!node) return false;
    var name = String((node.getAttribute && node.getAttribute("name")) || "").toLowerCase();
    var id = String(node.id || "");
    var formAttr = String((node.getAttribute && node.getAttribute("form")) || "");
    if (name === "checkout") return true;
    if (
      id === "checkout" ||
      id === "CartDrawer-Checkout" ||
      id === "CartNotification-Checkout" ||
      id === "cart-notification-form" ||
      id === "CartNotification-Form"
    ) {
      return true;
    }
    if (formAttr === "cart" && (name === "checkout" || id === "checkout")) return true;
    if (node.matches && node.matches(".cart__checkout-button, .cart-drawer__checkout")) return true;
    if (isInNotification(node) && name !== "add") return Boolean(name === "checkout" || /checkout/i.test(id));
    return false;
  }

  function isAddToCartControl(node) {
    if (!node || !node.closest) return false;
    if (node.closest("#pp-pay-modal")) return false;
    // Dawn cart-notification / cart footer Checkout can sit near product-form; never treat as ATC.
    if (isExplicitCartCheckout(node)) return false;
    if (isInNotification(node)) return false;
    var name = String((node.getAttribute && node.getAttribute("name")) || "").toLowerCase();
    var id = String(node.id || "").toLowerCase();
    var cls = nodeClassName(node).toLowerCase();
    if (name === "add" || name === "add-to-cart") return true;
    if (id.indexOf("productsubmitbutton") !== -1 || id.indexOf("add-to-cart") !== -1 || id.indexOf("product-form-submit") !== -1) {
      return true;
    }
    if (cls.indexOf("product-form__submit") !== -1 || cls.indexOf("add-to-cart") !== -1) return true;
    if (node.closest("product-form") || node.closest('[data-type="add-to-cart-form"]')) return true;
    var form = node.form || (node.closest && node.closest("form"));
    if (form && isNotificationCheckoutForm(form)) return false;
    var action = String((form && (form.getAttribute("action") || form.action)) || "");
    if (/\/cart\/add/i.test(action)) return true;
    return controlLabel(node).some(function (text) {
      return /add\s*to\s*cart/.test(text) || text === "added" || text === "adding...";
    });
  }

  function isUpdateControl(node) {
    if (!node) return false;
    var name = String((node.getAttribute && node.getAttribute("name")) || "").toLowerCase();
    if (name === "update" || name === "updates") return true;
    var cls = nodeClassName(node).toLowerCase();
    return cls.indexOf("quantity") !== -1 && cls.indexOf("checkout") === -1;
  }

  // Buy it now / accelerated wallets — never intercept. PDP payment_button stays visible.
  // Never treat drawer / cart / notification Checkout as dynamic.
  function isBuyItNowControl(node) {
    if (!node || !node.closest) return false;
    if (isExplicitCartCheckout(node) || isInNotification(node) || isInDrawer(node)) return false;
    var name = String((node.getAttribute && node.getAttribute("name")) || "").toLowerCase();
    if (name === "checkout") return false;
    if (node.matches && node.matches(".cart__checkout-button, .cart-drawer__checkout, #cart-notification-form, #CartNotification-Checkout")) {
      return false;
    }
    return Boolean(node.closest(DYNAMIC_CHECKOUT_ROOT));
  }

  function hideCartExtraCheckout() {
    document.querySelectorAll(CART_EXTRA_CHECKOUT).forEach(function (el) {
      if (!el || el.getAttribute("data-pp-hidden") === "1") return;
      if (el.closest && el.closest("product-form, form[action*='/cart/add']")) return;
      el.setAttribute("data-pp-hidden", "1");
      el.setAttribute("hidden", "");
      el.setAttribute("aria-hidden", "true");
      el.style.setProperty("display", "none", "important");
      el.style.setProperty("visibility", "hidden", "important");
      el.style.setProperty("pointer-events", "none", "important");
    });
  }

  function isCheckoutControl(node) {
    if (!node || !node.closest) return false;
    if (node.closest("#pp-pay-modal")) return false;
    if (isAddToCartControl(node)) return false;
    if (isBuyItNowControl(node)) return false;
    if (isUpdateControl(node)) return false;

    if (node.matches && node.matches(CHECKOUT_SELECTOR)) return true;
    if (isExplicitCartCheckout(node)) return true;
    if (isNotificationCheckoutForm(node)) return true;

    var name = String((node.getAttribute && node.getAttribute("name")) || "").toLowerCase();
    if (name === "checkout") return true;

    var id = String(node.id || "");
    if (
      id === "CartDrawer-Checkout" ||
      id === "checkout" ||
      id === "CartNotification-Checkout" ||
      id === "cart-notification-form" ||
      id === "CartNotification-Form"
    ) {
      return true;
    }
    if (id.toLowerCase().indexOf("checkout") !== -1 && id.toLowerCase().indexOf("dynamic") === -1) return true;

    var cls = nodeClassName(node).toLowerCase();
    if (
      cls.indexOf("checkout") !== -1 &&
      cls.indexOf("dynamic-checkout") === -1 &&
      cls.indexOf("accelerated-checkout") === -1
    ) {
      return true;
    }

    var href = (node.getAttribute && (node.getAttribute("href") || node.getAttribute("formaction"))) || "";
    if (hrefIsCheckout(href)) return true;

    if (isEnglishCheckoutLabel(node)) return true;

    var formAttr = node.getAttribute && node.getAttribute("form");
    if (formAttr === "cart" && (name === "checkout" || id === "checkout" || isEnglishCheckoutLabel(node))) {
      return true;
    }

    if (isInNotification(node) && (name === "checkout" || isEnglishCheckoutLabel(node))) return true;

    return false;
  }

  function asElement(node) {
    if (!node) return null;
    if (node.nodeType === 1) return node;
    return node.parentElement || null;
  }

  function closestCheckoutControl(node) {
    var el = asElement(node);
    if (!el || !el.closest) return null;
    var match = el.closest(CHECKOUT_SELECTOR);
    if (match && isNotificationCheckoutForm(match) && match.querySelector) {
      var inner = match.querySelector(
        'button[name="checkout"], input[name="checkout"], #CartNotification-Checkout',
      );
      if (inner && isCheckoutControl(inner)) return inner;
    }
    if (match && isCheckoutControl(match)) return match;
    var control = el.closest(
      "button, a[href], input[type='submit'], input[type='button'], input[type='image'], [role='button']",
    );
    if (control && isCheckoutControl(control)) return control;
    return null;
  }

  function isCartCheckoutForm(form) {
    if (!form || !form.tagName || String(form.tagName).toLowerCase() !== "form") return false;
    if (form.closest && form.closest("#pp-pay-modal")) return false;
    if (isNotificationCheckoutForm(form)) return true;
    var id = String(form.id || "");
    if (
      id === "cart" ||
      id === "CartDrawer-Form" ||
      id === "CartNotification-Form" ||
      id === "cart-notification-form"
    ) {
      return true;
    }
    if (form.getAttribute("data-type") === "add-to-cart-form") return false;
    if (form.closest && form.closest("product-form") && !isInNotification(form)) return false;
    var action = String(form.getAttribute("action") || form.action || "");
    if (/\/cart\/add/i.test(action)) return false;
    if (hrefIsCheckout(action)) return true;
    if (
      form.closest &&
      form.closest(
        "cart-drawer, #CartDrawer, cart-notification, #cart-notification, #CartNotification, #main-cart-footer, .cart__footer, .cart-drawer__footer",
      )
    ) {
      return true;
    }
    if (/\/cart/i.test(action) && form.querySelector && form.querySelector(CHECKOUT_SELECTOR)) {
      return true;
    }
    if (/\/cart/i.test(action) && form.querySelector && form.querySelector('[name="checkout"]')) {
      return true;
    }
    return false;
  }

  function resolveFormForControl(node) {
    if (!node) return null;
    if (node.form && isCartCheckoutForm(node.form)) return node.form;
    var formAttr = node.getAttribute && node.getAttribute("form");
    if (formAttr) {
      var byId = document.getElementById(formAttr);
      if (byId && isCartCheckoutForm(byId)) return byId;
    }
    var closest = node.closest && node.closest("form");
    if (closest && isCartCheckoutForm(closest)) return closest;
    if (isInNotification(node)) {
      var noteForm =
        document.getElementById("cart-notification-form") || document.getElementById("CartNotification-Form");
      if (noteForm && isCartCheckoutForm(noteForm)) return noteForm;
    }
    if (isInDrawer(node)) {
      var drawerForm = document.getElementById("CartDrawer-Form");
      if (drawerForm && isCartCheckoutForm(drawerForm)) return drawerForm;
    }
    var cartForm = document.getElementById("cart");
    if (cartForm && isCartCheckoutForm(cartForm)) return cartForm;
    return null;
  }

  function associatedCheckout(form) {
    if (!form) return null;
    if (form.querySelector) {
      var inside = form.querySelector(CHECKOUT_SELECTOR);
      if (inside && isCheckoutControl(inside)) return inside;
      var named = form.querySelector('button[name="checkout"], input[name="checkout"]');
      if (named && isCheckoutControl(named)) return named;
    }
    var id = form.id ? String(form.id) : "";
    if (!id || !document.querySelector) return null;
    var byForm = document.querySelector(
      '[name="checkout"][form="' +
        id +
        '"], #checkout[form="' +
        id +
        '"], #CartDrawer-Checkout[form="' +
        id +
        '"], #CartNotification-Checkout[form="' +
        id +
        '"], .cart__checkout-button[form="' +
        id +
        '"]',
    );
    if (byForm && isCheckoutControl(byForm)) return byForm;
    return null;
  }

  function halt(event) {
    if (!event) return;
    if (event.preventDefault) event.preventDefault();
    if (event.stopPropagation) event.stopPropagation();
    if (event.stopImmediatePropagation) event.stopImmediatePropagation();
    if (typeof event.returnValue !== "undefined") event.returnValue = false;
  }

  function intercept(event, form, source) {
    if (!shopOn()) {
      console.log("[partial-payment] skip intercept: shop off");
      return false;
    }
    var path = window.location.pathname || "";
    if (/\/checkouts?\//.test(path) || /\/checkout\/?$/.test(path)) return false;
    if (skipFlag(form)) {
      clearSkipFlag(form);
      return false;
    }
    if (redirecting) {
      halt(event);
      return true;
    }
    var open = document.getElementById("pp-pay-modal");
    if (open && !open.hidden) {
      halt(event);
      return true;
    }
    if (interceptLock) {
      halt(event);
      return true;
    }
    interceptLock = true;
    window.setTimeout(function () {
      interceptLock = false;
    }, 8000);

    console.log("[partial-payment] checkout intercepted", source || "page");
    halt(event);
    cartJson()
      .then(function (cart) {
        return ensureProductCatalog(cart).then(function () {
          return cart;
        });
      })
      .then(function (cart) {
        var shop = shopSettings();
        var lines = productItems(cart);
        var items = eligibleItems(cart);
        // All products ON: treat cart lines as eligible unless explicitly Off.
        // Empty/stale Liquid #pp-cart-products must not skip the popup.
        if (!items.length && shopTargetingIsOpen(shop)) {
          items = lines.filter(function (item) {
            return !isExplicitProductOff(item);
          });
        }
        if (!items.length) {
          if (!lines.length) {
            console.log("[partial-payment] skip popup: empty cart");
          } else if (shop.productScope === "selected" || shop.allProductsEnabled === false) {
            console.log("[partial-payment] skip popup: restrictive targeting, no matching lines");
          } else {
            console.log("[partial-payment] skip popup: all cart lines explicitly Off");
          }
          goCheckout(form);
          return;
        }
        try {
          openModal(cart, form);
        } catch (error) {
          console.log("[partial-payment] popup render failed", error && error.message);
          goCheckout(form);
        }
      })
      .catch(function () {
        goCheckout(form);
      })
      .then(function () {
        interceptLock = false;
      });
    return true;
  }

  function onCheckoutClick(event) {
    var target = closestCheckoutControl(event.target);
    if (!target) return;
    if (isAddToCartControl(target)) return;
    if (isBuyItNowControl(target)) return;
    if (!isCheckoutControl(target)) return;
    var form = resolveFormForControl(target);
    if (form && !isCartCheckoutForm(form)) form = null;
    intercept(event, form, checkoutSource(target, form));
  }

  function onCheckoutSubmit(event) {
    var form = event.target;
    if (skipFlag(form)) {
      clearSkipFlag(form);
      return;
    }

    var submitter = event.submitter || null;
    if (!submitter && document.activeElement && isCheckoutControl(document.activeElement)) {
      submitter = document.activeElement;
    }
    if (submitter && isAddToCartControl(submitter)) return;
    if (submitter && isUpdateControl(submitter)) return;
    if (submitter && isBuyItNowControl(submitter)) return;

    // Dawn cart-notification POSTs to /cart with name="checkout" — halt and open modal.
    if (isNotificationCheckoutForm(form)) {
      intercept(event, form, "notification");
      return;
    }

    if (!isCartCheckoutForm(form)) {
      if (submitter && isCheckoutControl(submitter)) {
        intercept(event, form, checkoutSource(submitter, form));
      }
      return;
    }

    if (submitter && isCheckoutControl(submitter)) {
      intercept(event, form, checkoutSource(submitter, form));
      return;
    }
    if (hrefIsCheckout(form.getAttribute("action") || form.action)) {
      intercept(event, form, checkoutSource(null, form));
      return;
    }
    var associated = associatedCheckout(form);
    if (associated && (!submitter || submitter === associated || !form.contains(submitter))) {
      intercept(event, form, checkoutSource(associated, form));
    }
  }

  function bindCheckoutButtons() {
    var buttons = document.querySelectorAll(CHECKOUT_SELECTOR);
    for (var i = 0; i < buttons.length; i++) {
      var button = buttons[i];
      if (!isCheckoutControl(button) && !isNotificationCheckoutForm(button)) continue;
      // Always re-bind: Dawn clones #checkout / CartDrawer / cart-notification
      // and may copy data-pp-bound without the capture listener.
      button.setAttribute("data-pp-bound", "1");
      button.addEventListener("click", onCheckoutClick, true);
      if (String(button.tagName || "").toLowerCase() === "form") {
        button.addEventListener("submit", onCheckoutSubmit, true);
      }
    }
  }

  function refreshCheckoutBindings() {
    hideCartExtraCheckout();
    bindCheckoutButtons();
  }

  // Capture-phase only — no form.submit monkey-patch, no pointerdown races.
  document.addEventListener("click", onCheckoutClick, true);
  window.addEventListener("click", onCheckoutClick, true);
  document.addEventListener("submit", onCheckoutSubmit, true);
  window.addEventListener("submit", onCheckoutSubmit, true);

  refreshCheckoutBindings();
  console.log("[partial-payment] checkout intercept ready v3");

  document.addEventListener("keydown", function (event) {
    if (event.key === "Escape") {
      var modal = document.getElementById("pp-pay-modal");
      if (modal && !modal.hidden) {
        event.preventDefault();
        closeModal();
      }
    }
    trapFocus(event);
  });

  document.addEventListener("DOMContentLoaded", refreshCheckoutBindings);
  document.addEventListener("shopify:section:load", refreshCheckoutBindings);
  if (window.MutationObserver) {
    try {
      new MutationObserver(function (mutations) {
        for (var i = 0; i < mutations.length; i++) {
          if (mutations[i].addedNodes && mutations[i].addedNodes.length) {
            refreshCheckoutBindings();
            return;
          }
        }
      }).observe(document.documentElement, {
        childList: true,
        subtree: true,
      });
    } catch (error) {}
  }
})();
