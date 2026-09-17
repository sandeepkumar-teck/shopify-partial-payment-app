import "@shopify/ui-extensions/preact";
import { render } from "preact";
import {
  attributeMap,
  formatMoney,
  hasPaymentDetails,
  isSurchargeLine,
  paymentFromAttributes,
} from "./logic";

export default async () => {
  render(<CartLineItem />, document.body);
};

function CartLineItem() {
  const line = shopify.target?.value;
  if (!line) return null;

  const attrs = attributeMap(line.attributes || []);
  if (isSurchargeLine(line)) {
    return (
      <s-text color="subdued">
        {attrs.description || "COD extra because no advance payment was selected."}
      </s-text>
    );
  }

  if (!hasPaymentDetails(line)) return null;

  const payment = paymentFromAttributes(line.attributes || []);
  const status =
    payment.status === "Unpaid (COD)" || payment.status === "unpaid_cod"
      ? "Unpaid (COD)"
      : payment.status === "Paid" || payment.status === "fully_paid"
        ? "Paid"
        : "Partial paid";
  const payNowShown = attrs["Pay now"] != null && attrs["Pay now"] !== "";

  return (
    <s-stack gap="none">
      {!payNowShown ? <s-text>Paid Online {formatMoney(payment.payNow)}</s-text> : null}
      <s-text>Order Total {formatMoney(payment.fullPrice)}</s-text>
      <s-text>Remaining COD {formatMoney(payment.payCod)}</s-text>
      <s-text>Payment Status {status}</s-text>
      {payment.surcharge > 0 ? (
        <s-text>COD extra {formatMoney(payment.surcharge)}</s-text>
      ) : null}
    </s-stack>
  );
}
