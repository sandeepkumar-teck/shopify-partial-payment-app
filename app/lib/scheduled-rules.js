import {
  collectionNumericId,
  formatMoney,
  normalizeRuleCollectionIds,
  normalizeRuleTags,
  parsePayRuleType,
} from "./partial-payment";

export const SCHEDULED_RULES_METAFIELD = {
  namespace: "$app",
  key: "scheduled_rules",
};

export const TARGET_TYPES = ["collection", "product", "tag"];
export const RULE_ACTIONS = ["enable_partial", "disable_partial"];
export const RULE_STATUSES = ["scheduled", "active", "ended", "cancelled"];

export const IST_OFFSET = "+05:30";
export const IST_TIMEZONE = "Asia/Kolkata";

export function newRuleId() {
  if (typeof crypto !== "undefined" && crypto.randomUUID) {
    return crypto.randomUUID();
  }
  return `sr_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
}

export function nowIsoIst(date = new Date()) {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-CA", {
      timeZone: IST_TIMEZONE,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hour12: false,
    })
      .formatToParts(date)
      .filter((part) => part.type !== "literal")
      .map((part) => [part.type, part.value]),
  );
  return `${parts.year}-${parts.month}-${parts.day}T${parts.hour}:${parts.minute}:${parts.second}${IST_OFFSET}`;
}

export function istLocalInputToIso(dateStr, timeStr) {
  const date = String(dateStr || "").trim();
  const time = String(timeStr || "").trim();
  if (!date || !time) return "";
  const normalized = time.length === 5 ? `${time}:00` : time;
  return `${date}T${normalized}${IST_OFFSET}`;
}

export function isoToIstLocalParts(iso) {
  if (!iso) return { date: "", time: "" };
  try {
    const date = new Date(iso);
    if (Number.isNaN(date.getTime())) return { date: "", time: "" };
    const parts = Object.fromEntries(
      new Intl.DateTimeFormat("en-CA", {
        timeZone: IST_TIMEZONE,
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
        hour: "2-digit",
        minute: "2-digit",
        hour12: false,
      })
        .formatToParts(date)
        .filter((part) => part.type !== "literal")
        .map((part) => [part.type, part.value]),
    );
    return {
      date: `${parts.year}-${parts.month}-${parts.day}`,
      time: `${parts.hour}:${parts.minute}`,
    };
  } catch {
    return { date: "", time: "" };
  }
}

export function formatIstDateTime(iso) {
  if (!iso) return "—";
  try {
    const date = new Date(iso);
    if (Number.isNaN(date.getTime())) return "—";
    const datePart = date.toLocaleDateString("en-GB", {
      timeZone: IST_TIMEZONE,
      day: "2-digit",
      month: "short",
      year: "numeric",
    });
    const timePart = date
      .toLocaleTimeString("en-US", {
        timeZone: IST_TIMEZONE,
        hour: "numeric",
        minute: "2-digit",
        hour12: true,
      })
      .replace(/\s/g, " ")
      .replace("AM", "am")
      .replace("PM", "pm");
    return `${datePart}, ${timePart}`;
  } catch {
    return "—";
  }
}

export function formatIstNameStamp(iso) {
  if (!iso) return "";
  try {
    const date = new Date(iso);
    if (Number.isNaN(date.getTime())) return "";
    const day = date.toLocaleDateString("en-GB", {
      timeZone: IST_TIMEZONE,
      day: "numeric",
      month: "short",
    });
    const time = date
      .toLocaleTimeString("en-US", {
        timeZone: IST_TIMEZONE,
        hour: "numeric",
        minute: "2-digit",
        hour12: true,
      })
      .replace(/\s/g, " ")
      .replace("AM", "am")
      .replace("PM", "pm");
    return `${day} ${time}`;
  } catch {
    return "";
  }
}

function numberOr(value, fallback) {
  if (value == null || value === "") return fallback;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function previewTitles(rule) {
  return (rule?.targetPreviews || []).map((item) => String(item?.title || "").trim()).filter(Boolean);
}

function hasExplicitPayFields(raw = {}) {
  return [
    raw.payRuleType,
    raw.payRuleValue,
    raw.fullyCodEnabled,
    raw.fixedAmount,
    raw.percent,
    raw.customAmount,
    raw.surcharge,
    raw.fullyCodExtra,
  ].some((value) => value != null && value !== "");
}

export function isScheduleFullyCod(rule) {
  if (!rule || rule.action === "disable_partial") return false;
  const type = String(rule.payRuleType || "").toLowerCase();
  if (type === "fully_cod" || type === "fullycod") return true;
  return rule.fullyCodEnabled === true || rule.fullyCodEnabled === "true";
}

export function scheduleUsesOwnPayRule(rule) {
  if (!rule || rule.action === "disable_partial") return false;
  if (rule.useShopPayRule === true) return false;
  if (isScheduleFullyCod(rule)) return true;
  return hasExplicitPayFields(rule);
}

export function customRuleLabel(rule) {
  const name = String(rule?.name || "").trim();
  if (!name || /^untitled$/i.test(name)) return "";
  if (name === generateRuleName(rule)) return "";
  if (name === generateRuleName({ ...rule, targetPreviews: [] })) return "";
  const stamp = formatIstNameStamp(rule?.startAt);
  if (stamp && name.endsWith(` · ${stamp}`)) return "";
  return name;
}

export function formatSchedulePayRule(rule, symbol = "₹") {
  if (!rule) return "—";
  if (rule.action === "disable_partial") return "Disable";
  if (isScheduleFullyCod(rule)) {
    const extra = numberOr(rule.fullyCodExtra ?? rule.surcharge, 0);
    return extra > 0 ? `Fully COD +${formatMoney(extra, symbol)}` : "Fully COD";
  }
  if (!scheduleUsesOwnPayRule(rule)) return "Shop default";
  const type = parsePayRuleType(rule.payRuleType);
  if (type === "percent") {
    const percent = numberOr(rule.percent ?? rule.payRuleValue, 25);
    return `${percent > 0 ? percent : 25}%`;
  }
  if (type === "custom") {
    const amount = numberOr(rule.customAmount ?? rule.payRuleValue, 0);
    return amount > 0 ? `Custom ${formatMoney(amount, symbol)}` : "Custom";
  }
  return `Fixed ${formatMoney(500, symbol)}`;
}

export function schedulePayFormType(rule) {
  if (!rule || rule.action === "disable_partial") return "fixed";
  if (isScheduleFullyCod(rule)) return "fully_cod";
  return parsePayRuleType(rule.payRuleType);
}

export function settingsOverlayFromScheduledRule(rule, shopSettings = {}) {
  if (!rule || !scheduleUsesOwnPayRule(rule)) return shopSettings;
  if (isScheduleFullyCod(rule)) {
    const extra = numberOr(rule.fullyCodExtra ?? rule.surcharge, numberOr(shopSettings.surcharge, 500));
    return {
      ...shopSettings,
      payRuleType: "custom",
      customAmount: 0,
      fullyCodEnabled: true,
      surcharge: extra > 0 ? extra : 500,
    };
  }
  const type = parsePayRuleType(rule.payRuleType);
  const value = numberOr(rule.payRuleValue, null);
  return {
    ...shopSettings,
    payRuleType: type,
    fixedAmount: type === "fixed" ? 500 : numberOr(rule.fixedAmount, shopSettings.fixedAmount) || 500,
    percent: numberOr(rule.percent, type === "percent" ? value : shopSettings.percent) || 25,
    customAmount: numberOr(rule.customAmount, type === "custom" ? value : shopSettings.customAmount) || 0,
  };
}

function normalizeSchedulePayFields(raw = {}, existing = null) {
  const src = { ...(existing || {}), ...(raw || {}) };
  const typeRaw = String(src.payRuleType || "").toLowerCase();
  const fullyCod =
    typeRaw === "fully_cod" ||
    typeRaw === "fullycod" ||
    src.fullyCodEnabled === true ||
    src.fullyCodEnabled === "true";
  const type = fullyCod ? "fixed" : parsePayRuleType(src.payRuleType);
  const value = numberOr(src.payRuleValue, null);
  const fixedAmount = type === "fixed" ? 500 : numberOr(src.fixedAmount, null);
  const percent = Math.min(100, Math.max(0, numberOr(src.percent, type === "percent" ? value : null)));
  const customAmount = numberOr(src.customAmount, type === "custom" ? value : null);
  const surcharge = numberOr(src.fullyCodExtra ?? src.surcharge, fullyCod ? value : null);
  const shopFlag = src.useShopPayRule === true || src.useShopPayRule === "true";
  const ownFlag = src.useShopPayRule === false || src.useShopPayRule === "false";
  const hasPay = ownFlag || (!shopFlag && hasExplicitPayFields(raw));
  let payRuleValue = 0;
  if (fullyCod) payRuleValue = surcharge > 0 ? surcharge : 500;
  else if (type === "percent") payRuleValue = percent > 0 ? percent : 25;
  else if (type === "custom") payRuleValue = customAmount || 0;
  else payRuleValue = 500;
  return {
    payRuleType: type,
    payRuleValue,
    fixedAmount: type === "fixed" ? 500 : fixedAmount > 0 ? fixedAmount : 500,
    percent: percent > 0 ? percent : 25,
    customAmount: customAmount || 0,
    fullyCodEnabled: Boolean(fullyCod),
    fullyCodExtra: surcharge > 0 ? surcharge : 500,
    surcharge: surcharge > 0 ? surcharge : 500,
    useShopPayRule: !hasPay,
  };
}

export function generateRuleName(rule = {}) {
  const stamp = formatIstNameStamp(rule.startAt) || "schedule";
  const titles = previewTitles(rule);
  if (rule.targetType === "product") {
    if (titles.length === 1) return `${titles[0]} · ${stamp}`;
    if (titles.length > 1) return `${titles.length} products · ${stamp}`;
    return `Product · ${stamp}`;
  }
  if (rule.targetType === "collection") {
    if (titles[0]) return `${titles[0]} · ${stamp}`;
    return `Collection · ${stamp}`;
  }
  const tag = String((rule.targetTags || [])[0] || "").trim();
  if (tag) return `${tag} · ${stamp}`;
  return `Tag · ${stamp}`;
}

export function displayRuleName(rule) {
  const name = String(rule?.name || "").trim();
  if (name && !/^untitled$/i.test(name)) return name;
  return generateRuleName(rule);
}

export function normalizeTargetPreviews(value) {
  const list = Array.isArray(value) ? value : [];
  const seen = new Set();
  const out = [];
  for (const item of list) {
    const id = String(item?.id || "").trim();
    if (!id || seen.has(id)) continue;
    seen.add(id);
    out.push({
      id,
      title: String(item?.title || "").trim(),
      image: String(item?.image || "").trim(),
      handle: String(item?.handle || "").trim(),
    });
  }
  return out;
}

function parseIsoMs(iso) {
  const ms = Date.parse(String(iso || ""));
  return Number.isFinite(ms) ? ms : NaN;
}

export function ruleWindowValid(startAt, endAt) {
  const startMs = parseIsoMs(startAt);
  const endMs = parseIsoMs(endAt);
  return Number.isFinite(startMs) && Number.isFinite(endMs) && endMs > startMs;
}

export function nowIstParts(date = new Date()) {
  return isoToIstLocalParts(nowIsoIst(date));
}

/** True when start is more than slack before now (IST). */
export function startIsInPast(startAt, now = new Date(), slackMs = 60_000) {
  const ms = parseIsoMs(startAt);
  return Number.isFinite(ms) && ms < now.getTime() - slackMs;
}

export function scheduleInputBounds(form = {}, now = new Date(), { creating = true } = {}) {
  const nowParts = nowIstParts(now);
  const today = nowParts.date;
  const nowTime = nowParts.time;
  const startDate = String(form.startDate || "");
  const startTime = String(form.startTime || "");
  const endDate = String(form.endDate || "");
  const keepPastStart = !creating && startDate && startDate < today;
  const minStartDate = keepPastStart ? startDate : today;
  const minStartTime = keepPastStart ? "" : startDate && startDate <= today ? nowTime : "";
  const minEndDate = startDate && startDate > today ? startDate : today;
  let minEndTime = "";
  if (endDate && startDate && endDate === startDate && startTime) {
    minEndTime = startTime;
  }
  if (endDate && endDate <= today && !keepPastStart) {
    minEndTime = !minEndTime || minEndTime < nowTime ? nowTime : minEndTime;
  }
  return { minStartDate, minStartTime, minEndDate, minEndTime, today, nowTime };
}

export function clampScheduleForm(form, now = new Date(), options = {}) {
  const bounds = scheduleInputBounds(form, now, options);
  const next = { ...form };
  if (next.startDate && next.startDate < bounds.minStartDate) {
    next.startDate = bounds.minStartDate;
  }
  if (next.startDate === bounds.today && next.startTime && bounds.minStartTime && next.startTime < bounds.minStartTime) {
    next.startTime = bounds.minStartTime;
  }
  const endBounds = scheduleInputBounds(next, now, options);
  if (next.endDate && next.endDate < endBounds.minEndDate) {
    next.endDate = endBounds.minEndDate;
  }
  if (next.endTime && endBounds.minEndTime && next.endTime < endBounds.minEndTime) {
    next.endTime = endBounds.minEndTime;
  }
  return next;
}

export function deriveRuleStatus(rule, now = new Date()) {
  if (rule?.status === "cancelled") return "cancelled";
  const startMs = parseIsoMs(rule?.startAt);
  const endMs = parseIsoMs(rule?.endAt);
  const nowMs = now.getTime();
  if (!Number.isFinite(startMs) || !Number.isFinite(endMs)) return "scheduled";
  if (nowMs < startMs) return "scheduled";
  if (nowMs >= startMs && nowMs <= endMs) return "active";
  return "ended";
}

export function normalizeScheduledRule(raw = {}, existing = null) {
  const targetType = TARGET_TYPES.includes(raw.targetType) ? raw.targetType : "collection";
  const action = RULE_ACTIONS.includes(raw.action) ? raw.action : "enable_partial";
  const status = RULE_STATUSES.includes(raw.status) ? raw.status : "scheduled";
  const targetIds =
    targetType === "tag"
      ? []
      : targetType === "collection"
        ? normalizeRuleCollectionIds(raw.targetIds || [])
        : Array.isArray(raw.targetIds)
          ? raw.targetIds.map((id) => String(id).trim()).filter(Boolean)
          : [];
  const targetTags = targetType === "tag" ? normalizeRuleTags(raw.targetTags || raw.targetIds) : [];
  const targetPreviews = normalizeTargetPreviews(raw.targetPreviews || existing?.targetPreviews);
  const now = nowIsoIst();
  const typedName = String(raw.name != null ? raw.name : existing?.name || "").trim();
  const pay = normalizeSchedulePayFields(raw, existing);
  const rule = {
    id: String(raw.id || existing?.id || newRuleId()),
    name: typedName,
    targetType,
    targetIds,
    targetTags,
    targetPreviews,
    action,
    startAt: String(raw.startAt || existing?.startAt || ""),
    endAt: String(raw.endAt || existing?.endAt || ""),
    status,
    createdAt: String(raw.createdAt || existing?.createdAt || now),
    updatedAt: String(raw.updatedAt || now),
    payRuleType: pay.payRuleType,
    payRuleValue: pay.payRuleValue,
    fixedAmount: pay.fixedAmount,
    percent: pay.percent,
    customAmount: pay.customAmount,
    fullyCodEnabled: pay.fullyCodEnabled,
    fullyCodExtra: pay.fullyCodExtra,
    surcharge: pay.surcharge,
    useShopPayRule: action === "disable_partial" ? true : pay.useShopPayRule,
  };
  if (!rule.name || /^untitled$/i.test(rule.name)) {
    rule.name = generateRuleName(rule);
  }
  rule.status = deriveRuleStatus(rule);
  return rule;
}

export function parseScheduledRulesStore(value) {
  try {
    const parsed = typeof value === "string" ? JSON.parse(value || "{}") : value || {};
    const rules = (Array.isArray(parsed.rules) ? parsed.rules : [])
      .map((rule) => normalizeScheduledRule(rule))
      .filter((rule) => rule.id);
    return {
      rules,
      activeScheduleOverrides: parsed.activeScheduleOverrides || {
        enabledTargets: [],
        disabledTargets: [],
      },
      evaluatedAt: parsed.evaluatedAt || "",
    };
  } catch {
    return {
      rules: [],
      activeScheduleOverrides: { enabledTargets: [], disabledTargets: [] },
      evaluatedAt: "",
    };
  }
}

export function ruleTargetKey(rule) {
  if (!rule) return "";
  if (rule.targetType === "tag") {
    return `tag:${(rule.targetTags || []).slice().sort().join("|")}`;
  }
  const ids = (rule.targetIds || []).slice().sort().join("|");
  return `${rule.targetType}:${ids}`;
}

function productMatchKeys(value) {
  const raw = String(value || "").trim();
  if (!raw) return [];
  const digits = raw.replace(/\D/g, "");
  const handle = raw.includes("/") ? "" : raw.toLowerCase();
  return [raw, digits, handle].filter(Boolean);
}

export function ruleMatchesProduct(rule, match = {}) {
  if (!rule || rule.status === "cancelled") return false;
  const productId = String(match.productId || match.id || match.handle || "").trim();
  const tags = (match.tags || [])
    .map((tag) => String(tag || "").trim().toLowerCase())
    .filter(Boolean);
  const collectionIds = (match.collectionIds || match.collections || [])
    .map(collectionNumericId)
    .filter(Boolean);

  if (rule.targetType === "product") {
    const targets = new Set();
    (rule.targetIds || []).forEach((id) => {
      productMatchKeys(id).forEach((key) => targets.add(key));
    });
    (rule.targetPreviews || []).forEach((preview) => {
      productMatchKeys(preview?.id).forEach((key) => targets.add(key));
      const handle = String(preview?.handle || "").trim().toLowerCase();
      if (handle) targets.add(handle);
    });
    const keys = [
      ...productMatchKeys(productId),
      ...productMatchKeys(match.handle),
    ];
    return keys.some((key) => targets.has(key));
  }

  if (rule.targetType === "collection") {
    const ruleIds = new Set((rule.targetIds || []).map(collectionNumericId).filter(Boolean));
    if (!ruleIds.size) return false;
    return collectionIds.some((id) => ruleIds.has(id));
  }

  if (rule.targetType === "tag") {
    const ruleTags = new Set((rule.targetTags || []).map((tag) => String(tag).toLowerCase()));
    if (!ruleTags.size) return false;
    return tags.some((tag) => ruleTags.has(tag));
  }

  return false;
}

/**
 * Disable matches always win over enable. Enable matches add eligibility and a
 * pay-rule overlay for those targets; they do not hide the rest of the catalog.
 */
export function scheduledActionForProduct(rules, match = {}, now = new Date()) {
  const active = (rules || []).filter((rule) => deriveRuleStatus(rule, now) === "active");
  let matchedEnable = false;
  for (const rule of active) {
    if (!ruleMatchesProduct(rule, match)) continue;
    if (rule.action === "disable_partial") return "disable_partial";
    if (rule.action === "enable_partial") matchedEnable = true;
  }
  return matchedEnable ? "enable_partial" : null;
}

export function activeScheduledEnableRule(rules, match = {}, now = new Date()) {
  if (scheduledActionForProduct(rules, match, now) !== "enable_partial") return null;
  const active = (rules || [])
    .filter((rule) => deriveRuleStatus(rule, now) === "active" && rule.action === "enable_partial")
    .sort((a, b) => Date.parse(b.updatedAt || 0) - Date.parse(a.updatedAt || 0));
  for (const rule of active) {
    if (ruleMatchesProduct(rule, match)) return rule;
  }
  return null;
}

export function evaluateScheduledRules(rules = [], now = new Date()) {
  const updatedRules = (rules || []).map((rule) => ({
    ...rule,
    status: deriveRuleStatus(rule, now),
  }));

  const activeRules = updatedRules
    .filter((rule) => rule.status === "active")
    .sort((a, b) => Date.parse(b.updatedAt || 0) - Date.parse(a.updatedAt || 0));

  const seen = new Set();
  const enabledTargets = [];
  const disabledTargets = [];

  for (const rule of activeRules) {
    const key = `${ruleTargetKey(rule)}:${rule.action}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const entry = {
      targetType: rule.targetType,
      targetIds: rule.targetIds || [],
      targetTags: rule.targetTags || [],
      ruleId: rule.id,
      action: rule.action,
      updatedAt: rule.updatedAt,
    };
    if (rule.action === "enable_partial") enabledTargets.push(entry);
    else disabledTargets.push(entry);
  }

  return {
    rules: updatedRules,
    activeScheduleOverrides: { enabledTargets, disabledTargets },
    evaluatedAt: nowIsoIst(now),
  };
}

export function rulesOverlap(a, b) {
  if (!a || !b) return false;
  if (a.id && b.id && a.id === b.id) return false;
  if (a.targetType !== b.targetType) return false;
  if (a.targetType === "tag") {
    const tagsA = new Set((a.targetTags || []).map((t) => String(t).toLowerCase()));
    return (b.targetTags || []).some((t) => tagsA.has(String(t).toLowerCase()));
  }
  const idsA = new Set((a.targetIds || []).map(String));
  return (b.targetIds || []).some((id) => idsA.has(String(id)));
}

export function findOverlappingRules(rules, candidate, now = new Date()) {
  const status = deriveRuleStatus(candidate, now);
  if (status === "ended" || status === "cancelled") return [];
  return (rules || []).filter((rule) => {
    if (rule.id === candidate.id) return false;
    if (rule.status === "cancelled" || deriveRuleStatus(rule, now) === "ended") return false;
    return rulesOverlap(rule, candidate);
  });
}

export function statusBadgeClass(status) {
  if (status === "active") return "badge badge-success";
  if (status === "scheduled") return "badge badge-cod";
  if (status === "ended") return "badge badge-muted";
  if (status === "cancelled") return "badge badge-alert";
  return "badge";
}

export function targetLabel(rule) {
  if (!rule) return "";
  const titles = previewTitles(rule);
  if (rule.targetType === "tag") {
    return (rule.targetTags || []).join(", ") || "—";
  }
  if (titles.length === 1) return titles[0];
  if (titles.length > 1) {
    const extra = titles.length - 1;
    return `${titles[0]} +${extra} more`;
  }
  if (rule.targetType === "collection") {
    const count = (rule.targetIds || []).length;
    return count === 1 ? "1 collection" : `${count} collections`;
  }
  const count = (rule.targetIds || []).length;
  return count === 1 ? "1 product" : `${count} products`;
}
