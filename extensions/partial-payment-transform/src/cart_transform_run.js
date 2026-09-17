/**
 * Charge each line's Pay now share so the cart total equals the amount due now
 * (partial deposit, or FULLY COD extra only), without a product discount strikethrough.
 * FULLY COD checkout unit price is that line's COD extra share — not catalog, not catalog+extra.
 * Leftover `_cod_surcharge` product lines are zeroed so they do not add a second charge.
 *
 * Always `lineExpand` with a fixed unit price. `lineUpdate` can attach properties
 * but does not change checkout unit price on this API version.
 */

function parseMoney(value) {
  if (value == null || value === "") return null;
  const cleaned = String(value).replace(/[^0-9.-]/g, "");
  const parsed = Number(cleaned);
  return Number.isFinite(parsed) ? parsed : null;
}

function depositForLine(line) {
  return parseMoney(line.depositNow?.value || line.payNow?.value || line.payNowVisible?.value);
}

function extraForLine(line) {
  return parseMoney(line.codExtra?.value) || 0;
}

function isFullyCodLine(line) {
  const payNow = depositForLine(line);
  const remaining = parseMoney(line.remainingCod?.value);
  const full = parseMoney(line.fullPriceVisible?.value);
  const status = String(line.statusVisible?.value || "").toLowerCase();
  if (payNow != null && payNow > 0) return false;
  if (status.includes("unpaid")) return true;
  if (remaining != null && remaining > 0) return true;
  if (full != null && full > 0 && (payNow === 0 || payNowVisibleIsZero(line))) return true;
  return false;
}

function payNowVisibleIsZero(line) {
  const visible = parseMoney(line.payNowVisible?.value);
  return visible === 0;
}

function fullyCodUnitPrice(line) {
  const qty = Number(line.quantity) || 1;
  if (!(qty > 0)) return null;
  const extra = extraForLine(line);
  if (!(extra > 0)) return null;
  const unit = Math.round((extra / qty) * 100) / 100;
  // Never zero a product line; extra share is the checkout price.
  return unit > 0 ? unit : null;
}

function expandAttributes(line) {
  const pairs = [
    ["Pay now", line.payNowVisible?.value],
    ["Remaining COD", line.remainingCod?.value],
    ["Full price", line.fullPriceVisible?.value],
    ["Status", line.statusVisible?.value],
    ["COD extra", line.codExtra?.value],
  ];
  return pairs
    .filter(([, value]) => value != null && String(value).trim() !== "")
    .map(([key, value]) => ({ key, value: String(value) }));
}

function expandLine(line, unitAmount, title, options = {}) {
  const unitPrice = Math.round(Number(unitAmount) * 100) / 100;
  if (unitPrice < 0) return null;
  const quantity = Math.max(1, Number(options.quantity || line.quantity) || 1);
  const attributes = Array.isArray(options.attributes) ? options.attributes : expandAttributes(line);
  const item = {
    merchandiseId: line.merchandise.id,
    quantity,
    price: {
      adjustment: {
        fixedPricePerUnit: {
          amount: unitPrice.toFixed(2),
        },
      },
    },
  };
  if (attributes.length) item.attributes = attributes;

  return {
    cartLineId: line.id,
    title,
    expandedCartItems: [item],
  };
}

function priceOperation(line, unitAmount, title, options) {
  const expanded = expandLine(line, unitAmount, title, options);
  if (expanded) return { lineExpand: expanded };
  return null;
}

/**
 * @param {object} input
 * @returns {{ operations: object[] }}
 */
export function cartTransformRun(input) {
  const operations = [];

  for (const line of input.cart?.lines || []) {
    if (line.merchandise?.__typename !== "ProductVariant" || !line.merchandise.id) continue;

    const title = line.merchandise.product?.title || line.merchandise.title;

    if (line.surchargeLine?.value === "1") {
      const operation = priceOperation(line, 0, title, {
        attributes: [{ key: "_cod_surcharge", value: "1" }],
      });
      if (operation) operations.push(operation);
      continue;
    }

    const payNow = depositForLine(line);

    if (payNow != null && payNow > 0) {
      const quantity = Number(line.quantity) || 1;
      const unitDeposit = Math.round((payNow / quantity) * 100) / 100;
      if (unitDeposit <= 0) continue;
      const operation = priceOperation(line, unitDeposit, title, { quantity });
      if (operation) operations.push(operation);
      continue;
    }

    if (isFullyCodLine(line)) {
      const unit = fullyCodUnitPrice(line);
      if (unit == null || unit < 0) continue;
      const operation = priceOperation(line, unit, title, {});
      if (operation) operations.push(operation);
    }
  }

  return { operations };
}
