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
  render(<CartLineList />, document.body);
};

function CartLineList() {
  const lines = shopify.lines?.value || [];
  const products = lines.filter((line) => isProductLine(line) && hasPaymentDetails(line));
  if (!products.length) return null;

  const totals = sumPayments(products);
  const payNow = Math.round(Number(totals.payNow || 0) * 100) / 100;
  const payCod = Math.round(Number(totals.payCod || 0) * 100) / 100;
  const fullPrice = Math.round(Number(totals.fullPrice || 0) * 100) / 100;
  if (payNow <= 0 && payCod <= 0) return null;

  const status = payCod <= 0 ? "fully_paid" : payNow <= 0 ? "unpaid_cod" : "partial_paid";

  return (
    <s-banner tone="info" heading="Payment summary">
      {`Order Total ${formatMoney(fullPrice)}. Paid Online ${formatMoney(payNow)}. Remaining COD ${formatMoney(payCod)}. Payment Status ${statusLabel(status)}. ${
        payNow <= 0
          ? "Remaining COD is collected on delivery."
          : "Checkout total is Paid Online only; Remaining COD is collected on delivery or via a Shopify invoice from the merchant."
      }`}
    </s-banner>
  );
}
