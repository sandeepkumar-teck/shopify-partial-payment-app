import "@shopify/ui-extensions/preact";
import { render } from "preact";
import { useEffect, useRef, useState } from "preact/hooks";
import {
  buildLinePayment,
  formatMoney,
  hasPaymentDetails,
  isInfoLine,
  isProductLine,
  isSurchargeLine,
  merchandiseId,
  parseSettings,
  paymentAttributes,
  paymentFromAttributes,
  unitPrice,
} from "./logic";

export default async () => {
  render(<CheckoutPicker />, document.body);
};

function readSettings() {
  const metafields = shopify.appMetafields?.value || [];
  const field =
    metafields.find((item) => item.metafield?.key === "partial_payment") ||
    metafields.find((item) => item.key === "partial_payment");
  const value = field?.metafield?.value || field?.value;
  return parseSettings(value);
}

function isUnpaidCodPayment(payment) {
  const status = String(payment?.status || "").toLowerCase();
  if (status.includes("unpaid")) return true;
  if (Number(payment?.surcharge) > 0 && Number(payment?.payCod) > 0) return true;
  if (Number(payment?.payNow) > 0) return false;
  return Number(payment?.payCod) > 0;
}

function CheckoutPicker() {
  const [lines, setLines] = useState(shopify.lines?.value || []);
  const [busy, setBusy] = useState(false);
  const cleaning = useRef(false);
  const settings = readSettings();

  async function removeLeftoverDuplicates() {
    if (cleaning.current) return;
    cleaning.current = true;
    const current = shopify.lines?.value || [];
    const leftovers = current.filter((line) => isInfoLine(line) || isSurchargeLine(line));
    for (const line of leftovers) {
      await shopify.applyCartLinesChange({
        type: "removeCartLine",
        id: line.id,
        quantity: line.quantity,
      });
    }

    const remaining = (shopify.lines?.value || []).filter(
      (line) => !isSurchargeLine(line) && !isInfoLine(line),
    );
    const seen = new Map();
    for (const line of remaining) {
      const merch = merchandiseId(line);
      if (!merch) continue;
      if (seen.has(merch)) {
        await shopify.applyCartLinesChange({
          type: "removeCartLine",
          id: line.id,
          quantity: line.quantity,
        });
        continue;
      }
      seen.set(merch, line);
    }
    cleaning.current = false;
  }

  useEffect(() => {
    if (!shopify.lines?.subscribe) return;
    return shopify.lines.subscribe((next) => setLines(next || []));
  }, []);

  useEffect(() => {
    if (!settings.enabled) return;
    const productLines = (lines || []).filter(isProductLine);
    const leftover = (lines || []).filter((line) => isInfoLine(line) || isSurchargeLine(line));
    if (!productLines.length) return;

    const partialLines = productLines.filter(hasPaymentDetails);
    if (!partialLines.length && !leftover.length) return;

    (async () => {
      setBusy(true);
      await removeLeftoverDuplicates();
      const latest = (shopify.lines?.value || []).filter(isProductLine);
      for (const line of latest) {
        if (!hasPaymentDetails(line)) continue;
        const current = paymentFromAttributes(line.attributes || []);
        if (isUnpaidCodPayment(current)) continue;
        const map = Object.fromEntries((line.attributes || []).map((row) => [row.key, row.value]));
        const hasVisiblePayNow = map["Pay now"] != null && map["Pay now"] !== "";
        const qty = line.quantity || 1;
        const perUnit = qty > 0 ? Math.round((current.payNow / qty) * 100) / 100 : current.payNow;
        const linePayment = buildLinePayment({
          unitPrice: unitPrice(line),
          quantity: qty,
          depositPerUnit: perUnit,
          surchargePerUnit: settings.surcharge,
        });
        if (
          String(current.payNow) === String(linePayment.payNow) &&
          String(current.payCod) === String(linePayment.payCod) &&
          hasVisiblePayNow
        ) {
          continue;
        }
        await shopify.applyCartLinesChange({
          type: "updateCartLine",
          id: line.id,
          attributes: paymentAttributes(linePayment, settings),
        });
      }
      setBusy(false);
    })();
  }, [lines]);

  if (!settings.enabled) return null;

  const productLines = (lines || []).filter(isProductLine);
  const partialLines = productLines.filter(hasPaymentDetails);
  if (!partialLines.length) return null;
  const totals = productLines.reduce(
    (acc, line) => {
      const payment = paymentFromAttributes(line.attributes || []);
      if (!hasPaymentDetails(line)) return acc;
      acc.payNow += Number(payment.payNow || 0);
      acc.payCod += Number(payment.payCod || 0);
      acc.fullPrice += Number(payment.fullPrice || 0);
      return acc;
    },
    { payNow: 0, payCod: 0, fullPrice: 0 },
  );
  const payNow = Math.round(totals.payNow * 100) / 100;
  const payCod = Math.round(totals.payCod * 100) / 100;
  const fullPrice = Math.round(totals.fullPrice * 100) / 100;
  const statusLabelText =
    payCod <= 0 ? "Paid" : payNow <= 0 ? "Unpaid (COD)" : "Partial paid";

  return (
    <s-section heading="Payment summary">
      <s-stack gap="base">
        <s-banner tone="info">
          {`Order Total ${formatMoney(fullPrice)}. Paid Online ${formatMoney(payNow)}. Remaining COD ${formatMoney(payCod)}. Payment Status ${statusLabelText}. Checkout stays on Shopify’s native payment. Remaining COD is collected on delivery, or the merchant can email a Shopify invoice to collect the rest online.`}
        </s-banner>
        {busy ? <s-text>Updating line details…</s-text> : null}
      </s-stack>
    </s-section>
  );
}
