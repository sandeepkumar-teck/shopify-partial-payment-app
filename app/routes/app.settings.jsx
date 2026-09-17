import { useEffect } from "react";
import { useFetcher, useLoaderData } from "react-router";
import { useAppBridge } from "@shopify/app-bridge-react";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { authenticate } from "../shopify.server";
import { collectionNumericId, parseSettings, parsePayRuleType, formatShopActiveRule } from "../lib/partial-payment";
import { loadSettings, saveSettings, syncPartialPaymentSetup } from "../lib/partial-payment.server";
import { loadScheduledRulesView } from "../lib/scheduled-rules.server";
import AppShell from "../components/AppShell";
import ScheduledRulesPanel from "../components/ScheduledRulesPanel";
import "../styles/dashboard.css";

export const loader = async ({ request }) => {
  const { admin } = await authenticate.admin(request);
  const { settings } = await loadSettings(admin);
  let scheduled = { rules: [], collections: [] };
  try {
    scheduled = await loadScheduledRulesView(admin);
  } catch {
    scheduled = { rules: [], collections: [] };
  }
  return {
    settings,
    error: null,
    loadedAt: new Date().toISOString(),
    scheduledRules: scheduled.rules || [],
    collections: scheduled.collections || [],
  };
};

export const action = async ({ request }) => {
  const { admin } = await authenticate.admin(request);
  const form = await request.formData();
  if (form.get("intent") === "restore-order") {
    const { restorePartialPaymentOrderByName } = await import(
      "../lib/process-partial-payment-order.server"
    );
    const restored = await restorePartialPaymentOrderByName(admin, form.get("orderNumber"));
    return { restore: restored };
  }
  if (form.get("intent") === "mark-cod") {
    const { markPartialPaymentFullyPaid } = await import(
      "../lib/process-partial-payment-order.server"
    );
    return { mark: await markPartialPaymentFullyPaid(admin, form.get("orderNumber")) };
  }
  const { shopId, settings } = await loadSettings(admin);
  const next = parseSettings({
    ...settings,
    enabled: form.get("enabled") === "true",
    payRuleType: parsePayRuleType(form.get("payRuleType") || "fixed"),
    fixedAmount: 500,
    percent: Number(form.get("percent") || 25),
    customAmount: Number(form.get("customAmount") || 0),
    surcharge: Number(form.get("surcharge") || 0),
    fullyCodEnabled: form.get("fullyCodEnabled") === "true",
    note: String(form.get("note") || ""),
    productScope: settings.productScope,
    allProductsEnabled: settings.allProductsEnabled,
  });
  await saveSettings(admin, shopId, next);
  const synced = await syncPartialPaymentSetup(admin, { force: true });
  return { settings: synced.settings, setupWarnings: synced.setupWarnings || [] };
};

export default function Settings() {
  const { settings, error, loadedAt, scheduledRules, collections } = useLoaderData();
  const fetcher = useFetcher();
  const shopify = useAppBridge();
  const current = fetcher.data?.settings || settings;
  const isSaving =
    ["loading", "submitting"].includes(fetcher.state) && fetcher.formMethod === "POST";
  const symbol = current.currencySymbol || "₹";
  const collectionTitle =
    (collections || []).find(
      (item) =>
        collectionNumericId(item.id) ===
        collectionNumericId((current.ruleCollectionIds || [])[0] || ""),
    )?.title || "";
  const activeRule = formatShopActiveRule(current, symbol, { collectionTitle });

  useEffect(() => {
    if (fetcher.data?.settings) {
      const warnings = fetcher.data.setupWarnings || [];
      shopify.toast.show("Partial payment settings saved");
      if (warnings.length) {
        shopify.toast.show(warnings[0], { duration: 8000 });
      }
    }
  }, [fetcher.data, shopify]);

  useEffect(() => {
    if (typeof window === "undefined") return;
    if (window.location.hash === "#scheduled-rules") {
      document.getElementById("scheduled-rules")?.scrollIntoView({ behavior: "smooth", block: "start" });
    }
  }, []);

  return (
    <div className="pp-page">
      <AppShell
        kicker="PartialPay · Rules"
        title="Payment setup"
        subtitle="Set the shop deposit and optional sale windows. Who it applies to is chosen on Products."
        active="settings"
        loadedAt={loadedAt}
      >
        <div className="settings-page">
          <section className="panel settings-card">
            <h2>Shop deposit</h2>
            <div className="panel-body">
              {error ? <div className="empty">{error}</div> : null}
              <fetcher.Form
                method="POST"
                className="settings-form"
                key={`${current.payRuleType}-${current.fixedAmount}-${current.percent}-${current.customAmount}-${current.surcharge}-${current.fullyCodEnabled}-${current.note}`}
              >
                <input type="hidden" name="enabled" value="true" />
                <div className="settings-active products-active-rule">
                  <span>Selected rule</span>
                  <strong>{activeRule.headline}</strong>
                  <em>{activeRule.meta}</em>
                  <p className="rule-banner-note">{activeRule.detail}</p>
                </div>
                <div className="settings-grid">
                  <label className="settings-field">
                    <span>Pay now</span>
                    <select name="payRuleType" defaultValue={current.payRuleType || "fixed"}>
                      <option value="fixed">Fixed amount</option>
                      <option value="percent">Percent of cart total</option>
                      <option value="custom">Custom amount</option>
                    </select>
                  </label>
                  <label className="settings-field">
                    <span>Fixed amount</span>
                    <input
                      type="number"
                      name="fixedAmount"
                      value="500"
                      readOnly
                      aria-readonly="true"
                      title="Fixed amount is always ₹500. Use Custom amount for another value."
                    />
                  </label>
                  <label className="settings-field">
                    <span>Percent</span>
                    <input
                      type="number"
                      name="percent"
                      min={0}
                      max={100}
                      step="1"
                      defaultValue={String(current.percent || 25)}
                    />
                  </label>
                  <label className="settings-field">
                    <span>Custom amount</span>
                    <input
                      type="number"
                      name="customAmount"
                      min={0}
                      step="1"
                      defaultValue={String(current.customAmount || 0)}
                    />
                  </label>
                  <label className="settings-field">
                    <span>COD extra</span>
                    <input
                      type="number"
                      name="surcharge"
                      min={0}
                      step="1"
                      defaultValue={String(current.surcharge || 0)}
                    />
                  </label>
                  <div className="settings-field settings-field--toggle">
                    <span>Show FULLY COD</span>
                    <label className="pp-toggle pp-toggle--ok">
                      <input
                        type="checkbox"
                        name="fullyCodEnabled"
                        value="true"
                        defaultChecked={current.fullyCodEnabled !== false}
                      />
                      <span className="pp-toggle__track" aria-hidden="true" />
                    </label>
                  </div>
                  <label className="settings-field settings-field--wide">
                    <span>Line note</span>
                    <input type="text" name="note" defaultValue={current.note || ""} />
                  </label>
                </div>
                <button type="submit" className="btn-primary settings-save" disabled={isSaving}>
                  {isSaving ? "Saving…" : "Save settings"}
                </button>
              </fetcher.Form>
            </div>
          </section>

          <div id="scheduled-rules" className="scheduled-rules-page">
            <ScheduledRulesPanel
              rules={scheduledRules}
              collections={collections}
              settings={current}
            />
          </div>
        </div>
      </AppShell>
    </div>
  );
}

export const headers = (headersArgs) => {
  return boundary.headers(headersArgs);
};
