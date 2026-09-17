export const DEFAULT_SETTINGS = {
  enabled: true,
  depositOptions: [500],
  payRuleType: "fixed",
  fixedAmount: 500,
  percent: 25,
  customAmount: 0,
  surcharge: 500,
  currencySymbol: "₹",
  note: "No EMI available for COD orders. Remaining payment must be paid to the delivery partner.",
};

export function parseSettings(value) {
  try {
    const parsed = typeof value === "string" ? JSON.parse(value || "{}") : value || {};
    const type = String(parsed.payRuleType || "fixed").toLowerCase();
    return {
      enabled: parsed.enabled !== false,
      depositOptions: [500],
      payRuleType: type === "percent" || type === "custom" ? type : "fixed",
      fixedAmount: 500,
      percent: Number(parsed.percent ?? 25),
      customAmount: Number(parsed.customAmount ?? 0),
      surcharge: Number(parsed.surcharge ?? DEFAULT_SETTINGS.surcharge),
      currencySymbol: parsed.currencySymbol || DEFAULT_SETTINGS.currencySymbol,
      note: parsed.note || DEFAULT_SETTINGS.note,
      surchargeVariantId: parsed.surchargeVariantId || "",
    };
  } catch {
    return { ...DEFAULT_SETTINGS, surchargeVariantId: "" };
  }
}

export function formatMoney(amount, symbol = "₹") {
  return `${symbol}${Number(amount).toLocaleString("en-IN")}`;
}

export function parseMoney(value) {
  if (value == null || value === "") return 0;
  if (typeof value === "number") return Number.isFinite(value) ? value : 0;
  const cleaned = String(value).replace(/[^0-9.-]/g, "");
  const parsed = Number(cleaned);
  return Number.isFinite(parsed) ? parsed : 0;
}

export function statusLabel(status) {
  if (status === "fully_paid" || status === "Paid") return "Paid";
  if (status === "unpaid_cod" || status === "Unpaid (COD)") return "Unpaid (COD)";
  if (status === "refunded" || status === "Refunded") return "Refunded";
  return "Partial paid";
}

export function buildLinePayment({ unitPrice, quantity, depositPerUnit, surchargePerUnit }) {
  const qty = Number(quantity) || 1;
  const unit = Math.round(Number(unitPrice || 0) * 100) / 100;
  const full = Math.round(unit * qty * 100) / 100;
  const unitDeposit = Math.min(Math.max(Number(depositPerUnit) || 0, 0), unit);
  const deposit = Math.round(unitDeposit * qty * 100) / 100;

  if (deposit <= 0) {
    return {
      payNow: 0,
      payCod: full,
      fullPrice: full,
      surcharge: 0,
      status: "unpaid_cod",
      unitPrice: unit,
      depositPerUnit: 0,
    };
  }

  return {
    payNow: deposit,
    payCod: Math.round((full - deposit) * 100) / 100,
    fullPrice: full,
    surcharge: 0,
    status: "partial_paid",
    unitPrice: unit,
    depositPerUnit: unitDeposit,
  };
}

export function attributeMap(attributes = []) {
  return Object.fromEntries((attributes || []).map((attribute) => [attribute.key, attribute.value]));
}

export function paymentAttributes(payment, settings, extra = []) {
  const symbol = settings.currencySymbol || "₹";
  const rows = [
    { key: "Pay now", value: formatMoney(payment.payNow, symbol) },
    { key: "Remaining COD", value: formatMoney(payment.payCod, symbol) },
    { key: "Full price", value: formatMoney(payment.fullPrice, symbol) },
    { key: "Status", value: statusLabel(payment.status) },
  ];
  if (Number(payment.surcharge) > 0) {
    rows.push({ key: "COD extra", value: formatMoney(payment.surcharge, symbol) });
  }
  return [...rows, ...extra];
}

export function paymentFromAttributes(attributes = []) {
  const map = attributeMap(attributes);
  return {
    payNow: parseMoney(map["Pay now"] || map._partial_pay_now || map.pay_now),
    payCod: parseMoney(map["Remaining COD"] || map._partial_pay_cod),
    fullPrice: parseMoney(map["Full price"] || map._partial_full),
    surcharge: parseMoney(map["COD extra"] || map._partial_surcharge),
    status: map.Status || map._partial_status || "partial_paid",
  };
}

export function isSurchargeLine(line) {
  return attributeMap(line.attributes || [])._cod_surcharge === "1";
}

export function isInfoLine(line) {
  return attributeMap(line.attributes || [])._partial_info === "1";
}

export function isProductLine(line) {
  return !isSurchargeLine(line) && !isInfoLine(line);
}

export function hasPaymentDetails(line) {
  const map = attributeMap(line.attributes || []);
  return (
    map["Pay now"] != null ||
    map._partial_pay_now != null ||
    map.pay_now != null ||
    map["Remaining COD"] != null ||
    map._partial_pay_cod != null
  );
}

export function merchandiseId(line) {
  return line.merchandise?.id || line.merchandiseId || "";
}

export function unitPrice(line) {
  const map = attributeMap(line.attributes || []);
  const qty = line.quantity || 1;
  const payment = paymentFromAttributes(line.attributes || []);
  const full = payment.fullPrice;
  if (full > 0 && qty > 0) return full / qty;
  const stored = parseMoney(map._partial_unit);
  if (stored > 0) return stored;
  // Checkout UI 2026 CartLineCost only exposes totalAmount (after line discounts).
  const total = Number(line.cost?.totalAmount?.amount);
  if (Number.isFinite(total) && total > 0 && payment.payNow > 0 && Math.abs(total - payment.payNow) < 0.02) {
    return 0;
  }
  if (Number.isFinite(total) && total > 0) return total / qty;
  return Number(line.cost?.subtotalAmount?.amount || 0) / qty;
}

export function sumPayments(lines = []) {
  return lines.reduce(
    (acc, line) => {
      const payment = paymentFromAttributes(line.attributes || []);
      acc.payNow += Number(payment.payNow || 0);
      acc.payCod += Number(payment.payCod || 0);
      acc.fullPrice += Number(payment.fullPrice || 0);
      acc.surcharge += Number(payment.surcharge || 0);
      return acc;
    },
    { payNow: 0, payCod: 0, fullPrice: 0, surcharge: 0 },
  );
}
