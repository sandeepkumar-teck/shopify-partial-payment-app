import { useEffect } from "react";
import { useFetcher, useLoaderData } from "react-router";
import { useAppBridge } from "@shopify/app-bridge-react";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { authenticate } from "../shopify.server";
import { loadSettings, syncPartialPaymentSetup } from "../lib/partial-payment.server";
import { loadDashboardOrders } from "../lib/dashboard.server";
import { buildDashboardStats, countProductRules } from "../lib/dashboard";
import { searchProducts, serializeProduct } from "../lib/products.server";
import { syncOrderSnapshots } from "../lib/reporting-snapshot.server";
import DashboardView from "../components/DashboardView";
import "../styles/dashboard.css";

export const loader = async ({ request }) => {
  const { admin } = await authenticate.admin(request);
  let settings;
  try {
    const loaded = await loadSettings(admin);
    settings = loaded.settings;
    const synced = await syncPartialPaymentSetup(admin);
    settings = synced.settings;
  } catch (error) {
    const loaded = await loadSettings(admin);
    settings = loaded.settings;
  }

  try {
    const { syncScheduledRules } = await import("../lib/scheduled-rules.server");
    await syncScheduledRules(admin);
  } catch (error) {
    console.warn("Scheduled rules sync:", error?.message || String(error));
  }

  let shop = { name: "Store", currencyCode: "INR" };
  let orders = [];
  let error = null;
  try {
    const data = await loadDashboardOrders(admin);
    shop = data.shop;
    orders = data.orders;
    void syncOrderSnapshots(admin, shop, orders);
  } catch (err) {
    console.error("Dashboard GraphQL userErrors", err?.message || String(err));
    error = err?.message || "Dashboard orders could not be loaded";
  }

  try {
    const { syncDueInvoices } = await import("../lib/invoice.server");
    await syncDueInvoices(admin, orders);
  } catch (invoiceError) {
    console.warn("Invoice sync:", invoiceError?.message || String(invoiceError));
  }

  const stats = buildDashboardStats(orders || [], settings);
  const counts = stats.counts || {};
  stats.statusBreakdown = [
    { key: "partial_paid", label: "Partially Paid", value: counts.partial_paid || 0, color: "#f59e0b" },
    { key: "unpaid_cod", label: "Unpaid COD", value: counts.unpaid_cod || 0, color: "#f97316" },
    { key: "fully_paid", label: "Fully Paid", value: counts.fully_paid || 0, color: "#10b981" },
    { key: "refunded", label: "Refunded", value: counts.refunded || 0, color: "#94a3b8" },
  ];

  try {
    const catalog = await searchProducts(admin, { query: "", pageSize: 25 });
    const products = (Array.isArray(catalog?.nodes) ? catalog.nodes : [])
      .map((node) => {
        try {
          return serializeProduct(node, settings);
        } catch {
          return null;
        }
      })
      .filter(Boolean);
    stats.ruleCounts = countProductRules(products, settings);
  } catch {
    stats.ruleCounts = null;
  }

  return {
    shop,
    settings,
    stats,
    loadedAt: new Date().toISOString(),
    error,
  };
};

export const action = async ({ request }) => {
  const { admin } = await authenticate.admin(request);
  const form = await request.formData();
  const intent = String(form.get("intent") || "");
  if (intent === "mark-cod" || intent === "record-online") {
    const { markPartialPaymentFullyPaid } = await import(
      "../lib/process-partial-payment-order.server"
    );
    const ref = String(form.get("orderId") || form.get("orderNumber") || "");
    const collectedVia = intent === "record-online" ? "Invoice paid" : "COD collected";
    return { mark: await markPartialPaymentFullyPaid(admin, ref, { collectedVia }) };
  }
  if (intent === "send-invoice") {
    const { sendOrderInvoice } = await import("../lib/invoice.server");
    return { invoice: await sendOrderInvoice(admin, form.get("orderId")) };
  }
  if (intent === "schedule-invoice") {
    const { scheduleOrderInvoice } = await import("../lib/invoice.server");
    return {
      schedule: await scheduleOrderInvoice(admin, form.get("orderId"), {
        schedule: String(form.get("schedule") || form.get("invoiceMode") || "off"),
        invoiceDays: String(form.get("invoiceDays") || ""),
      }),
    };
  }
  return {};
};

export default function Index() {
  const { shop, settings, stats, error, loadedAt } = useLoaderData();
  const fetcher = useFetcher();
  const shopify = useAppBridge();

  useEffect(() => {
    if (fetcher.data?.mark?.ok) shopify.toast.show(`Marked ${fetcher.data.mark.name} fully paid`);
    if (fetcher.data?.mark?.error) shopify.toast.show(fetcher.data.mark.error);
    if (fetcher.data?.invoice?.ok) {
      shopify.toast.show(`Invoice emailed for ${fetcher.data.invoice.name || "order"}`);
    }
    if (fetcher.data?.invoice?.error) shopify.toast.show(fetcher.data.invoice.error);
    if (fetcher.data?.schedule?.ok) {
      shopify.toast.show(`Auto invoice updated for ${fetcher.data.schedule.name || "order"}`);
    }
    if (fetcher.data?.schedule?.error) shopify.toast.show(fetcher.data.schedule.error);
  }, [fetcher.data, shopify]);

  return (
    <div className="pp-page">
      {error ? <div className="dash-banner">{error}</div> : null}
      <DashboardView
        shop={shop}
        settings={settings}
        stats={stats}
        fetcher={fetcher}
        loadedAt={loadedAt}
      />
    </div>
  );
}

export const headers = (headersArgs) => {
  return boundary.headers(headersArgs);
};
