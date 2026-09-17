const IST = "Asia/Kolkata";
const IST_OFFSET = "+05:30";

function clampInt(value, min, max, fallback) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(max, Math.max(min, Math.round(parsed)));
}

export function clampInvoiceDays(value) {
  return clampInt(value, 1, 365, 7);
}

export function normalizeInvoiceMode(value) {
  const raw = String(value || "off").toLowerCase();
  if (raw === "days" || raw === "monthly") return raw;
  return "off";
}

function istParts(date) {
  const source = date instanceof Date ? date : new Date(date);
  if (Number.isNaN(source.getTime())) return null;
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-CA", {
      timeZone: IST,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      hour12: false,
    })
      .formatToParts(source)
      .filter((part) => part.type !== "literal")
      .map((part) => [part.type, part.value]),
  );
  return {
    year: Number(parts.year),
    month: Number(parts.month),
    day: Number(parts.day),
    hour: Number(parts.hour),
    minute: Number(parts.minute),
  };
}

export function istDayOfMonth(value) {
  const parts = istParts(value || new Date());
  return parts?.day || 1;
}

function lastDayOfMonth(year, month) {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

function addCalendarMonths(year, month, delta) {
  const index = year * 12 + (month - 1) + delta;
  return {
    year: Math.floor(index / 12),
    month: (index % 12) + 1,
  };
}

function istNoonIso(year, month, day) {
  const mm = String(month).padStart(2, "0");
  const dd = String(Math.max(1, day)).padStart(2, "0");
  return `${year}-${mm}-${dd}T10:00:00${IST_OFFSET}`;
}

function clampedMonthDay(year, month, dayOfMonth) {
  return Math.min(Math.max(1, dayOfMonth || 1), lastDayOfMonth(year, month));
}

export function formatShortIstDate(value) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  return date.toLocaleDateString("en-IN", {
    timeZone: IST,
    day: "numeric",
    month: "short",
  });
}

export function parseInvoiceSchedule(meta = {}) {
  const mode = normalizeInvoiceMode(meta.invoiceMode);
  const scheduled = meta.invoiceScheduled === true && mode !== "off";
  return {
    invoiceScheduled: scheduled,
    invoiceMode: scheduled ? mode : "off",
    invoiceDays: clampInvoiceDays(meta.invoiceDays || 7),
    invoiceDueAt: meta.invoiceDueAt || null,
    invoiceSentAt: meta.invoiceSentAt || null,
    invoiceMonthDay: clampInt(meta.invoiceMonthDay, 1, 31, 0) || null,
  };
}

export function addDaysIso(from, days) {
  const date = new Date(from);
  if (Number.isNaN(date.getTime())) return new Date().toISOString();
  date.setTime(date.getTime() + clampInvoiceDays(days) * 86_400_000);
  return date.toISOString();
}

export function nextMonthlyOccurrence(from, dayOfMonth) {
  const now = from instanceof Date ? from : new Date(from || Date.now());
  const parts = istParts(now) || istParts(new Date());
  const thisDay = clampedMonthDay(parts.year, parts.month, dayOfMonth);
  const thisMonthDue = new Date(istNoonIso(parts.year, parts.month, thisDay));
  if (thisMonthDue.getTime() > now.getTime()) return thisMonthDue;
  const next = addCalendarMonths(parts.year, parts.month, 1);
  const nextDay = clampedMonthDay(next.year, next.month, dayOfMonth);
  return new Date(istNoonIso(next.year, next.month, nextDay));
}

export function nextMonthlyDueAfter(dueAt, dayOfMonth) {
  const from = dueAt ? new Date(dueAt) : new Date();
  const parts = istParts(Number.isNaN(from.getTime()) ? new Date() : from) || istParts(new Date());
  const next = addCalendarMonths(parts.year, parts.month, 1);
  const day = clampedMonthDay(next.year, next.month, dayOfMonth || parts.day);
  return new Date(istNoonIso(next.year, next.month, day));
}

export function bumpMonthlyUntilFuture(dueAt, dayOfMonth, now = new Date()) {
  let next = nextMonthlyDueAfter(dueAt, dayOfMonth);
  let guard = 0;
  while (next.getTime() <= now.getTime() && guard < 24) {
    next = nextMonthlyDueAfter(next.toISOString(), dayOfMonth);
    guard += 1;
  }
  return next.toISOString();
}

export function computeInvoiceDueAt({ mode, days, monthDay, from = new Date(), orderCreatedAt } = {}) {
  const normalized = normalizeInvoiceMode(mode);
  if (normalized === "days") return addDaysIso(from, days);
  if (normalized === "monthly") {
    const day = monthDay || istDayOfMonth(orderCreatedAt || from);
    return nextMonthlyOccurrence(from, day).toISOString();
  }
  return null;
}

export function buildInvoiceSchedulePatch(
  { mode, days, orderCreatedAt, now = new Date() } = {},
  existing = {},
) {
  const current = parseInvoiceSchedule(existing);
  const normalized = normalizeInvoiceMode(mode);
  if (normalized === "off") {
    return {
      invoiceScheduled: false,
      invoiceMode: "off",
      invoiceDays: current.invoiceDays,
      invoiceDueAt: null,
      invoiceMonthDay: current.invoiceMonthDay,
      invoiceSentAt: current.invoiceSentAt,
    };
  }

  const invoiceDays = clampInvoiceDays(days || current.invoiceDays || 7);
  const invoiceMonthDay = istDayOfMonth(orderCreatedAt || now);
  return {
    invoiceScheduled: true,
    invoiceMode: normalized,
    invoiceDays,
    invoiceMonthDay,
    invoiceDueAt: computeInvoiceDueAt({
      mode: normalized,
      days: invoiceDays,
      monthDay: invoiceMonthDay,
      from: now,
      orderCreatedAt,
    }),
    invoiceSentAt: current.invoiceSentAt,
  };
}

export function invoiceAlreadySentForDue(schedule) {
  if (!schedule?.invoiceSentAt || !schedule?.invoiceDueAt) return false;
  const sent = new Date(schedule.invoiceSentAt);
  const due = new Date(schedule.invoiceDueAt);
  if (Number.isNaN(sent.getTime()) || Number.isNaN(due.getTime())) return false;
  return sent.getTime() >= due.getTime();
}

export function invoiceIsDue(schedule, now = new Date()) {
  if (!schedule?.invoiceScheduled || schedule.invoiceMode === "off") return false;
  if (!schedule.invoiceDueAt) return false;
  const due = new Date(schedule.invoiceDueAt);
  if (Number.isNaN(due.getTime()) || due.getTime() > now.getTime()) return false;
  if (invoiceAlreadySentForDue(schedule)) return false;
  if (schedule.invoiceMode === "days" && schedule.invoiceSentAt) {
    const sent = new Date(schedule.invoiceSentAt);
    if (!Number.isNaN(sent.getTime())) {
      const windowStart = due.getTime() - clampInvoiceDays(schedule.invoiceDays) * 86_400_000;
      if (sent.getTime() >= windowStart) return false;
    }
  }
  return true;
}

export function afterInvoiceSend(meta = {}, { stillUnpaid = true, now = new Date() } = {}) {
  const current = parseInvoiceSchedule(meta);
  const sentAt = now.toISOString();
  if (!stillUnpaid) {
    return {
      ...meta,
      invoiceSentAt: sentAt,
      invoiceScheduled: false,
      invoiceMode: "off",
      invoiceDueAt: null,
    };
  }
  if (current.invoiceMode === "monthly" && current.invoiceScheduled) {
    const monthDay = current.invoiceMonthDay || istDayOfMonth(now);
    return {
      ...meta,
      invoiceSentAt: sentAt,
      invoiceScheduled: true,
      invoiceMode: "monthly",
      invoiceMonthDay: monthDay,
      invoiceDueAt: bumpMonthlyUntilFuture(current.invoiceDueAt || sentAt, monthDay, now),
    };
  }
  return {
    ...meta,
    invoiceSentAt: sentAt,
    invoiceScheduled: false,
    invoiceMode: "off",
    invoiceDueAt: null,
  };
}

export function repairStaleMonthlySchedule(meta = {}, now = new Date()) {
  const current = parseInvoiceSchedule(meta);
  if (current.invoiceMode !== "monthly" || !current.invoiceScheduled || !current.invoiceDueAt) {
    return null;
  }
  const due = new Date(current.invoiceDueAt);
  if (Number.isNaN(due.getTime()) || due.getTime() > now.getTime()) return null;
  if (!invoiceAlreadySentForDue(current)) return null;
  const monthDay = current.invoiceMonthDay || istDayOfMonth(due);
  return {
    ...meta,
    invoiceMonthDay: monthDay,
    invoiceDueAt: bumpMonthlyUntilFuture(current.invoiceDueAt, monthDay, now),
  };
}

export function orderAllowsInvoice(order) {
  if (!order) return false;
  if (order.cancelledAt) return false;
  if (order.status === "fully_paid" || order.status === "refunded") return false;
  return Number(order.payCod) > 0;
}

export function scheduleSelectValue(order) {
  if (!order?.invoiceScheduled || order.invoiceMode === "off") return "off";
  if (order.invoiceMode === "monthly") return "monthly";
  if (order.invoiceMode === "days") {
    const days = Number(order.invoiceDays);
    if (days === 7 || days === 10 || days === 15) return String(days);
    return "custom";
  }
  return "off";
}

export function parseScheduleFormValue(schedule, customDays) {
  const raw = String(schedule || "off").toLowerCase();
  if (raw === "off") return { mode: "off", days: 7 };
  if (raw === "monthly") return { mode: "monthly", days: 7 };
  if (raw === "custom") return { mode: "days", days: clampInvoiceDays(customDays) };
  if (raw === "7" || raw === "10" || raw === "15") return { mode: "days", days: Number(raw) };
  const days = clampInvoiceDays(raw);
  return { mode: "days", days };
}
