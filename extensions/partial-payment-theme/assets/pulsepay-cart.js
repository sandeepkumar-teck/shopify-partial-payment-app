(function () {

  if (window.__pulsePayCart) return;

  window.__pulsePayCart = true;



  var syncing = false;

  var timer = 0;

  var VISIBLE_KEYS = ["Pay now", "Remaining COD", "Full price", "Status", "COD extra"];



  function settingsFromJsonTag() {
    var el = document.getElementById("pp-shop-settings");
    if (!el) return {};
    try {
      var parsed = JSON.parse(el.textContent || "{}");
      if (typeof parsed === "string") parsed = JSON.parse(parsed);
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
      return parsed;
    } catch (error) {
      return {};
    }
  }

  function cartVariantNumericId(value) {
    var text = String(value || "").trim();
    if (!text || text === "null" || text === "undefined") return 0;
    var variantMatch = text.match(/ProductVariant\/(\d+)/i);
    if (variantMatch) return Number(variantMatch[1]);
    if (/Product\/(\d+)/i.test(text)) return 0;
    var tail = text.match(/(\d+)\s*$/);
    if (tail) return Number(tail[1]);
    var digits = text.replace(/\D/g, "");
    return digits ? Number(digits) : 0;
  }

  function config() {

    var root = document.querySelector("[data-pp-root]") || document.querySelector("[data-pp-shop]");

    var cfg = window.PulsePayConfig || {};
    var jsonCfg = settingsFromJsonTag();
    var variantRaw = String(
      (root && root.getAttribute("data-surcharge-variant-numeric")) ||
        cfg.surchargeVariantNumericId ||
        jsonCfg.surchargeVariantNumericId ||
        (root && root.getAttribute("data-surcharge-variant")) ||
        cfg.surchargeVariantId ||
        jsonCfg.surchargeVariantId ||
        "",
    ).trim();

    return {

      symbol: (root && root.getAttribute("data-symbol")) || cfg.currencySymbol || jsonCfg.currencySymbol || "₹",

      surcharge: Number((root && root.getAttribute("data-surcharge")) || cfg.surcharge || jsonCfg.surcharge || 0),

      surchargeVariantId: variantRaw,

      surchargeVariantNumericId: cartVariantNumericId(variantRaw),

      note: (root && root.getAttribute("data-note")) || cfg.note || jsonCfg.note || "",

    };

  }



  function money(amount, symbol) {

    return symbol + Number(amount || 0).toLocaleString("en-IN", {

      maximumFractionDigits: 2,

      minimumFractionDigits: Number(amount) % 1 === 0 ? 0 : 2,

    });

  }



  function parseMoney(value) {

    if (value == null || value === "") return 0;

    var cleaned = String(value).replace(/[^0-9.-]/g, "");

    var parsed = Number(cleaned);

    return isFinite(parsed) ? parsed : 0;

  }



  function propsOf(item) {

    return item.properties || {};

  }



  function isSurcharge(item) {

    var props = propsOf(item);

    return props._cod_surcharge === "1" || props._cod_surcharge === 1;

  }



  function isLeftoverInfo(item) {

    return propsOf(item)._partial_info === "1";

  }



  function hasPartialProps(item) {

    var props = propsOf(item);

    return (

      props._partial_pay_now != null ||

      props.pay_now != null ||

      props["Pay now"] != null ||

      props["Remaining COD"] != null

    );

  }



  function fetchJson(url, options) {

    var next = Object.assign({ credentials: "same-origin" }, options || {});

    next.headers = Object.assign({ Accept: "application/json", "X-PulsePay": "1" }, next.headers || {});

    return fetch(url, next).then(function (response) {

      return response.json();

    });

  }



  function cartJson() {

    return fetchJson("/cart.js");

  }



  var LEGACY_KEYS = [

    "pay_now",

    "_partial_pay_now",

    "_partial_pay_cod",

    "_partial_full",

    "_partial_status",

    "_partial_unit",

    "_partial_deposit_unit",

    "_partial_info",

    "_partial_surcharge",

    "description",

    "Partial payment",

  ];



  function lineProperties(payment, settings) {

    var props = {

      "Pay now": money(payment.payNow, settings.symbol),

      "Remaining COD": money(payment.payCod, settings.symbol),

      "Full price": money(payment.fullPrice, settings.symbol),

      Status: payment.status === "unpaid_cod" ? "Unpaid (COD)" : "Partial paid",

      "COD extra": Number(payment.surcharge) > 0 ? money(payment.surcharge, settings.symbol) : "",

    };

    LEGACY_KEYS.forEach(function (key) {

      props[key] = "";

    });

    return props;

  }



  function changeLine(item, quantity, properties) {

    var body = { id: item.key, quantity: quantity };

    if (properties) body.properties = properties;

    return fetchJson("/cart/change.js", {

      method: "POST",

      headers: { "Content-Type": "application/json" },

      body: JSON.stringify(body),

    });

  }



  function variantKey(item) {

    return String(item.variant_id || item.id || "");

  }



  function depositPerUnit(cart, item) {

    var qty = item.quantity || 1;

    var hidden = propsOf(item)._partial_deposit_unit;

    if (hidden != null && hidden !== "") {

      return Number(hidden);

    }

    return parseMoney(propsOf(item)["Pay now"] || propsOf(item)._partial_pay_now || propsOf(item).pay_now) / qty;

  }



  function paymentFromItem(item, cart, settings) {

    var qty = item.quantity || 1;

    var props = propsOf(item);

    var extra = parseMoney(props["COD extra"] || props._partial_surcharge);

    var statusText = String(props.Status || props._partial_status || "").toLowerCase();

    var remaining = parseMoney(props["Remaining COD"] || props._partial_pay_cod);

    var visibleFull = parseMoney(props["Full price"]);

    var unpaid = statusText.indexOf("unpaid") !== -1;

    if (extra > 0 && unpaid) {

      var catalog = remaining > 0 ? remaining : visibleFull;

      if (!(catalog > 0)) {

        catalog =

          Number(props._partial_unit || 0) * qty ||

          (Number(item.original_price || item.price || 0) / 100) * qty;

      }

      catalog = Math.round(Number(catalog) * 100) / 100;

      var payNowExtra = parseMoney(props["Pay now"] || props._partial_pay_now);

      if (!(payNowExtra > 0)) payNowExtra = extra;

      var unitCatalog = qty > 0 ? Math.round((catalog / qty) * 100) / 100 : catalog;

      return {

        payNow: payNowExtra,

        payCod: catalog,

        fullPrice: catalog,

        surcharge: extra,

        status: "unpaid_cod",

        unitPrice: unitCatalog,

        depositPerUnit: qty > 0 ? Math.round((payNowExtra / qty) * 100) / 100 : payNowExtra,

      };

    }

    var catalog =

      visibleFull ||

      parseMoney(props._partial_full) ||

      Number(props._partial_unit || 0) * qty ||

      (Number(item.original_price || item.price || 0) / 100) * qty;

    var unit = qty > 0 ? Math.round((catalog / qty) * 100) / 100 : catalog;

    var unitDeposit = Math.min(Math.max(depositPerUnit(cart, item) || 0, 0), unit);

    var payNow = Math.round(unitDeposit * qty * 100) / 100;

    var full = Math.round(unit * qty * 100) / 100;

    if (payNow <= 0) {

      return {

        payNow: 0,

        payCod: full,

        fullPrice: full,

        surcharge: extra > 0 ? extra : 0,

        status: "unpaid_cod",

        unitPrice: unit,

        depositPerUnit: 0,

      };

    }

    return {

      payNow: payNow,

      payCod: Math.round((full - payNow) * 100) / 100,

      fullPrice: full,

      surcharge: 0,

      status: "partial_paid",

      unitPrice: unit,

      depositPerUnit: unitDeposit,

    };

  }



  function sameProps(current, next) {

    var keys = VISIBLE_KEYS.concat([

      "_partial_pay_now",

      "_partial_pay_cod",

      "_partial_full",

      "_partial_status",

      "_partial_unit",

      "_partial_deposit_unit",

    ]);

    return keys.every(function (key) {

      return String(current[key] || "") === String(next[key] || "");

    });

  }



  function removeDuplicateLines(cart) {

    var groups = {};

    (cart.items || []).forEach(function (item) {

      if (isSurcharge(item)) return;

      var key = variantKey(item);

      groups[key] = groups[key] || [];

      groups[key].push(item);

    });



    var chain = Promise.resolve();

    Object.keys(groups).forEach(function (key) {

      var list = groups[key];

      if (list.length === 1 && isLeftoverInfo(list[0])) {

        chain = chain.then(function () {

          return changeLine(list[0], 0);

        });

        return;

      }

      if (list.length < 2) return;



      list.sort(function (a, b) {

        var aInfo = isLeftoverInfo(a) ? 1 : 0;

        var bInfo = isLeftoverInfo(b) ? 1 : 0;

        if (aInfo !== bInfo) return aInfo - bInfo;

        return (b.quantity || 1) - (a.quantity || 1);

      });

      var keep = list[0];

      var source = list.find(function (item) {

        return propsOf(item)["Pay now"] || propsOf(item)._partial_pay_now || propsOf(item).pay_now;

      });

      if (source && source !== keep) {

        chain = chain.then(function () {

          return changeLine(keep, keep.quantity, propsOf(source));

        });

      }

      list.slice(1).forEach(function (item) {

        chain = chain.then(function () {

          return changeLine(item, 0);

        });

      });

    });

    return chain;

  }



  function syncSurcharge(cart, settings) {

    var surchargeItems = (cart.items || []).filter(isSurcharge);

    return surchargeItems.reduce(function (chain, item) {

      return chain.then(function () {

        return changeLine(item, 0);

      });

    }, Promise.resolve());

  }



  function partialProductItems(cart) {

    return (cart.items || []).filter(function (item) {

      return !isSurcharge(item) && !isLeftoverInfo(item) && hasPartialProps(item);

    });

  }



  function syncProductProperties(cart, settings) {

    var partials = partialProductItems(cart);

    return partials.reduce(function (chain, item) {

      var payment = paymentFromItem(item, cart, settings);

      var next = lineProperties(payment, settings);

      if (sameProps(propsOf(item), next) && !isLeftoverInfo(item)) return chain;

      return chain.then(function () {

        return changeLine(item, item.quantity, next);

      });

    }, Promise.resolve());

  }



  function itemRoots() {

    return Array.prototype.slice.call(

      document.querySelectorAll(

        '[id^="CartDrawer-Item"], [id^="CartItem-"], .cart-drawer .cart-item, cart-drawer .cart-item, #CartDrawer .cart-item, .cart-items .cart-item',

      ),

    );

  }



  function hideNoisyProperties(el) {

    el.querySelectorAll(".product-option, .cart-item__details dl, .properties, .product-option dt, .product-option dd").forEach(

      function (node) {

        var text = node.textContent || "";

        if (text.indexOf("_partial_") !== -1 || text.indexOf("pay_now:") !== -1) {

          node.style.display = "none";

          node.classList.add("pp-prop-hidden");

        }

      },

    );

  }



  function ensureOrderSummary(cart, settings) {

    var partials = partialProductItems(cart);

    var hosts = document.querySelectorAll(

      "#main-cart-footer .cart__blocks, #main-cart-footer .cart__ctas, #main-cart-footer, .cart__footer, #CartDrawer .cart-drawer__footer, cart-drawer .cart-drawer__footer",

    );

    if (!hosts.length) return;



    if (!partials.length) {

      document.querySelectorAll("[data-pp-order-summary]").forEach(function (node) {

        node.remove();

      });

      return;

    }



    var payNow = 0;

    var payCod = 0;

    var full = 0;

    partials.forEach(function (item) {

      var payment = paymentFromItem(item, cart, settings);

      payNow += Number(payment.payNow || 0);

      payCod += Number(payment.payCod || 0);

      full += Number(payment.fullPrice || 0);

    });

    payNow = Math.round(payNow * 100) / 100;

    payCod = Math.round(payCod * 100) / 100;

    full = Math.round(full * 100) / 100;



    var html =

      '<div class="pp-order-summary__title">Payment summary</div>' +

      '<div class="pp-order-summary__row">Order Total ' +

      money(full, settings.symbol) +

      "</div>" +

      '<div class="pp-order-summary__row">Paid Online ' +

      money(payNow, settings.symbol) +

      "</div>" +

      '<div class="pp-order-summary__row">Remaining COD ' +

      money(payCod, settings.symbol) +

      "</div>" +

      '<div class="pp-order-summary__row">Payment Status Partial paid</div>';



    Array.prototype.forEach.call(hosts, function (host) {

      var box = host.querySelector("[data-pp-order-summary]");

      if (!box) {

        box = document.createElement("div");

        box.className = "pp-order-summary";

        box.setAttribute("data-pp-order-summary", "1");

        var ctas = host.querySelector(".cart__ctas, #checkout, .cart__checkout-button");

        if (ctas && ctas.parentNode === host) host.insertBefore(box, ctas);

        else if (ctas) host.insertBefore(box, ctas);

        else host.insertBefore(box, host.firstChild);

      }

      box.innerHTML = html;

    });

  }



  function patchDrawer(cart) {

    var settings = config();

    var items = cart.items || [];

    var roots = itemRoots();

    items.forEach(function (item, index) {

      var el = roots[index];

      if (!el) return;

      hideNoisyProperties(el);

      if (isSurcharge(item)) {

        var note = el.querySelector(".pp-line-note");

        if (!note) {

          note = document.createElement("div");

          note.className = "pp-line-note product-option";

          el.appendChild(note);

        }

        note.textContent = propsOf(item).description || "COD extra charged at checkout";

      }

    });

    ensureOrderSummary(cart, settings);

  }



  function scheduleSync() {

    clearTimeout(timer);

    timer = setTimeout(runSync, 180);

  }



  function runSync() {

    if (syncing) {

      scheduleSync();

      return;

    }

    syncing = true;

    var settings = config();

    cartJson()

      .then(function (cart) {

        return removeDuplicateLines(cart).then(function () {

          return cartJson();

        });

      })

      .then(function (cart) {

        return syncProductProperties(cart, settings).then(function () {

          return cartJson();

        });

      })

      .then(function (cart) {

        return syncSurcharge(cart, settings).then(function () {

          return cartJson();

        });

      })

      .then(function (cart) {

        patchDrawer(cart);

        setTimeout(function () {

          patchDrawer(cart);

        }, 400);

      })

      .catch(function () {})

      .then(function () {

        syncing = false;

      });

  }



  var nativeFetch = window.fetch;

  if (nativeFetch) {

    window.fetch = function (input, init) {

      var url = typeof input === "string" ? input : (input && input.url) || "";

      var headers = (init && init.headers) || (input && input.headers) || {};

      var skip =

        (headers["X-PulsePay"] || headers["x-pulsepay"] || (headers.get && headers.get("X-PulsePay"))) === "1";

      var result = nativeFetch.apply(this, arguments);

      if (!skip && /\/cart\/(add|change|update|clear)/.test(String(url))) {

        result

          .then(function () {

            scheduleSync();

          })

          .catch(function () {});

      }

      return result;

    };

  }



  document.addEventListener("cart:updated", scheduleSync);

  document.addEventListener("cart:refresh", scheduleSync);

  document.addEventListener("shopify:section:load", scheduleSync);

  document.addEventListener("DOMContentLoaded", scheduleSync);

  if (document.readyState !== "loading") scheduleSync();

})();


