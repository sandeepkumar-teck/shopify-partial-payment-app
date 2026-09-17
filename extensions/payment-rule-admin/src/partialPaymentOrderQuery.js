/** Read-only Admin GraphQL for the order-details Partial payment block. */
export const ORDER_BLOCK_POLL_MS = 5000;

export const PARTIAL_PAYMENT_ORDER_QUERY = `#graphql
  query PartialPaymentOrder($id: ID!) {
    order(id: $id) {
      id
      tags
      note
      displayFinancialStatus
      currentTotalPriceSet { shopMoney { amount } }
      totalOutstandingSet { shopMoney { amount } }
      totalReceivedSet { shopMoney { amount } }
      customAttributes { key value }
      metafield(namespace: "$app", key: "partial_payment") {
        value
      }
      lineItems(first: 50) {
        nodes {
          title
          image { url }
          originalUnitPriceSet { shopMoney { amount } }
          discountedUnitPriceSet { shopMoney { amount } }
          customAttributes { key value }
          variant { price }
        }
      }
    }
  }
`;

export function fetchPartialPaymentOrder(query, orderId) {
  return query(PARTIAL_PAYMENT_ORDER_QUERY, { variables: { id: orderId } }).then((result) => {
    const problems = JSON.stringify(result?.errors || "");
    if (!/totaloutstandingset|totalreceivedset/i.test(problems)) return result;
    const fallback = PARTIAL_PAYMENT_ORDER_QUERY
      .replace(/\s+currentTotalPriceSet \{ shopMoney \{ amount \} \}/, "")
      .replace(/\s+totalOutstandingSet \{ shopMoney \{ amount \} \}/, "")
      .replace(/\s+totalReceivedSet \{ shopMoney \{ amount \} \}/, "");
    return query(fallback, { variables: { id: orderId } });
  });
}
