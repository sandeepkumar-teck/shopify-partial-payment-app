import "@shopify/ui-extensions/preact";
import { render } from "preact";
import {
  formatMoney,
  hasPaymentDetails,
  isProductLine,
  statusLabel,
  sumPayments,
} from "./logic";

export default async () => {
  render(<ThankYouStatus />, document.body);
};

function ThankYouStatus() {
  const lines = shopify.lines?.value || [];
  const products = lines.filter((line) => isProductLine(line) && hasPaymentDetails(line));
  if (!products.length) return null;

  const totals = sumPayments(products);
  if (!totals.payNow && !totals.payCod && !totals.fullPrice) return null;

  const payNow = Math.round(Number(totals.payNow || 0) * 100) / 100;
  const payCod = Math.round(Number(totals.payCod || 0) * 100) / 100;
  const fullPrice = Math.round(Number(totals.fullPrice || 0) * 100) / 100;
  const surcharge = Math.round(Number(totals.surcharge || 0) * 100) / 100;
  const charged = payNow > 0 ? payNow : 0;
  const status = payCod <= 0 ? "fully_paid" : payNow <= 0 ? "unpaid_cod" : "partial_paid";
  const tone = status === "fully_paid" ? "success" : status === "unpaid_cod" ? "critical" : "warning";

  return (
    <s-banner tone={tone} heading="Payment summary">
      Order Total {formatMoney(fullPrice)}. Paid Online {formatMoney(charged)}
      {surcharge > 0 && payNow <= 0 ? ` (includes COD extra ${formatMoney(surcharge)})` : ""}. Remaining
      COD {formatMoney(payCod)}. Payment Status {statusLabel(status)}.
      {payCod > 0
        ? " Remaining balance is due on delivery. To pay the rest online, ask the merchant to email a Shopify order invoice from Admin."
        : ""}
    </s-banner>
  );
}
