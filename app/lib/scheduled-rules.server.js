import {
  SCHEDULED_RULES_METAFIELD,
  evaluateScheduledRules,
  generateRuleName,
  istLocalInputToIso,
  normalizeScheduledRule,
  normalizeTargetPreviews,
  parseScheduledRulesStore,
  ruleWindowValid,
  startIsInPast,
} from "./scheduled-rules";
import { listCollections } from "./products.server";
import { syncScheduledRuleSnapshots } from "./reporting-snapshot.server";

const QUERY = `#graphql
  query PartialPaymentScheduledRules {
    shop {
      id
      metafield(namespace: "${SCHEDULED_RULES_METAFIELD.namespace}", key: "${SCHEDULED_RULES_METAFIELD.key}") {
        value
      }
    }
  }
`;

const MUTATION = `#graphql
  mutation SetPartialPaymentScheduledRules($metafields: [MetafieldsSetInput!]!) {
    metafieldsSet(metafields: $metafields) {
      metafields { id value }
      userErrors { field message }
    }
  }
`;

function toResourceGid(id, resource) {
  const raw = String(id || "").trim();
  if (!raw) return "";
  if (raw.startsWith("gid://")) return raw;
  const digits = raw.replace(/\D/g, "");
  return digits ? `gid://shopify/${resource}/${digits}` : "";
}

function previewFromNode(node) {
  if (!node?.id) return null;
  return {
    id: node.id,
    title: String(node.title || "").trim(),
    image: String(node.featuredImage?.url || node.image?.url || "").trim(),
    handle: String(node.handle || "").trim(),
  };
}

export async function hydrateRuleTargetPreviews(admin, rules = []) {
  const ids = [];
  for (const rule of rules || []) {
    const resource = rule.targetType === "collection" ? "Collection" : rule.targetType === "product" ? "Product" : "";
    if (!resource) continue;
    for (const id of rule.targetIds || []) {
      const gid = toResourceGid(id, resource);
      if (gid) ids.push(gid);
    }
  }
  const unique = [...new Set(ids)];
  const byId = new Map();
  const byNumeric = new Map();

  if (unique.length) {
    try {
      const response = await admin.graphql(
        `#graphql
          query ScheduledRuleTargets($ids: [ID!]!) {
            nodes(ids: $ids) {
              ... on Product {
                id
                title
                handle
                featuredImage { url }
              }
              ... on Collection {
                id
                title
                handle
                image { url }
              }
            }
          }
        `,
        { variables: { ids: unique } },
      );
      const json = await response.json();
      for (const node of json.data?.nodes || []) {
        const preview = previewFromNode(node);
        if (!preview) continue;
        byId.set(preview.id, preview);
        const digits = preview.id.replace(/\D/g, "");
        if (digits) byNumeric.set(digits, preview);
      }
    } catch {
      // Keep any persisted previews if GraphQL is unavailable.
    }
  }

  return (rules || []).map((rule) => {
    if (rule.targetType === "tag") {
      const name = String(rule.name || "").trim();
      if (name && !/^untitled$/i.test(name)) return rule;
      return { ...rule, name: generateRuleName(rule) };
    }

    const stored = normalizeTargetPreviews(rule.targetPreviews);
    const previews = (rule.targetIds || []).map((id) => {
      const raw = String(id || "").trim();
      const digits = raw.replace(/\D/g, "");
      return (
        byId.get(raw) ||
        byNumeric.get(digits) ||
        stored.find((item) => item.id === raw || item.id.replace(/\D/g, "") === digits) || {
          id: raw,
          title: "",
          image: "",
          handle: "",
        }
      );
    });
    const next = { ...rule, targetPreviews: previews };
    const currentName = String(rule.name || "").trim();
    const genericName = generateRuleName({ ...rule, targetPreviews: [] });
    if (!currentName || /^untitled$/i.test(currentName) || currentName === genericName) {
      next.name = generateRuleName(next);
    }
    return next;
  });
}

export async function loadScheduledRules(admin) {
  const response = await admin.graphql(QUERY);
  const json = await response.json();
  const shopId = json.data?.shop?.id;
  const store = parseScheduledRulesStore(json.data?.shop?.metafield?.value);
  return { shopId, ...store };
}

export async function saveScheduledRules(admin, shopId, payload) {
  const response = await admin.graphql(MUTATION, {
    variables: {
      metafields: [
        {
          ownerId: shopId,
          namespace: SCHEDULED_RULES_METAFIELD.namespace,
          key: SCHEDULED_RULES_METAFIELD.key,
          type: "json",
          value: JSON.stringify(payload),
        },
      ],
    },
  });
  const json = await response.json();
  const errors = json.data?.metafieldsSet?.userErrors || [];
  if (errors.length) {
    throw new Error(errors.map((error) => error.message).join(", "));
  }
  void syncScheduledRuleSnapshots(admin, payload);
  return payload;
}

export async function syncScheduledRules(admin, { now = new Date() } = {}) {
  const { shopId, rules } = await loadScheduledRules(admin);
  const evaluated = evaluateScheduledRules(rules, now);
  const hydrated = await hydrateRuleTargetPreviews(admin, evaluated.rules);
  const payload = {
    rules: hydrated,
    activeScheduleOverrides: evaluated.activeScheduleOverrides,
    evaluatedAt: evaluated.evaluatedAt,
  };
  await saveScheduledRules(admin, shopId, payload);
  return payload;
}

export function buildRuleFromForm(form, existing = null) {
  const targetType = String(form.get("targetType") || "collection");
  const targetIdsRaw = String(form.get("targetIds") || "").trim();
  const targetTagsRaw = String(form.get("targetTags") || "").trim();
  const startAt = istLocalInputToIso(
    String(form.get("startDate") || ""),
    String(form.get("startTime") || ""),
  );
  const endAt = istLocalInputToIso(
    String(form.get("endDate") || ""),
    String(form.get("endTime") || ""),
  );

  let targetIds = [];
  let targetTags = [];
  if (targetType === "tag") {
    targetTags = targetTagsRaw
      .split(",")
      .map((tag) => tag.trim())
      .filter(Boolean);
  } else {
    targetIds = targetIdsRaw
      .split(",")
      .map((id) => id.trim())
      .filter(Boolean);
  }

  let targetPreviews = [];
  try {
    targetPreviews = JSON.parse(String(form.get("targetPreviews") || "[]"));
  } catch {
    targetPreviews = [];
  }

  return normalizeScheduledRule(
    {
      id: String(form.get("id") || existing?.id || ""),
      name: String(form.get("name") || ""),
      targetType,
      targetIds,
      targetTags,
      targetPreviews,
      action: String(form.get("action") || "enable_partial"),
      startAt,
      endAt,
      status: String(form.get("status") || existing?.status || "scheduled"),
      createdAt: existing?.createdAt,
      payRuleType: String(form.get("payRuleType") || existing?.payRuleType || "fixed"),
      payRuleValue: String(form.get("payRuleValue") || ""),
      fixedAmount: 500,
      percent: String(form.get("percent") || ""),
      customAmount: String(form.get("customAmount") || ""),
      fullyCodEnabled: String(form.get("fullyCodEnabled") || ""),
      fullyCodExtra: String(form.get("fullyCodExtra") || form.get("surcharge") || ""),
      surcharge: String(form.get("surcharge") || form.get("fullyCodExtra") || ""),
      useShopPayRule: String(form.get("action") || "enable_partial") === "disable_partial" ? "true" : "false",
    },
    existing,
  );
}

export function validateRuleInput(rule, { existing } = {}) {
  const errors = [];
  if (!ruleWindowValid(rule.startAt, rule.endAt)) {
    errors.push("End date/time must be after start (IST).");
  }
  const startMoved = !existing || String(existing.startAt || "") !== String(rule.startAt || "");
  if (startMoved && startIsInPast(rule.startAt)) {
    errors.push("Start date and time must be now or later (IST). Past times cannot be selected.");
  }
  if (rule.targetType === "tag" && !(rule.targetTags || []).length) {
    errors.push("Enter at least one tag.");
  }
  if (rule.targetType !== "tag" && !(rule.targetIds || []).length) {
    errors.push(rule.targetType === "collection" ? "Select a collection." : "Select a product.");
  }
  return errors;
}

export async function upsertScheduledRule(admin, form, { rules, shopId }) {
  const id = String(form.get("id") || "").trim();
  const existing = id ? rules.find((rule) => rule.id === id) : null;
  const rule = buildRuleFromForm(form, existing);
  const validationErrors = validateRuleInput(rule, { existing });
  if (validationErrors.length) {
    return { error: validationErrors.join(" "), rules };
  }

  const nextRules = existing
    ? rules.map((item) => (item.id === rule.id ? rule : item))
    : [...rules, rule];
  const hydratedRules = await hydrateRuleTargetPreviews(admin, nextRules);

  const evaluated = evaluateScheduledRules(hydratedRules);
  const payload = {
    rules: evaluated.rules,
    activeScheduleOverrides: evaluated.activeScheduleOverrides,
    evaluatedAt: evaluated.evaluatedAt,
  };
  await saveScheduledRules(admin, shopId, payload);
  return { rules: payload.rules, activeScheduleOverrides: payload.activeScheduleOverrides };
}

export async function mutateScheduledRule(admin, form, intent) {
  const { shopId, rules } = await loadScheduledRules(admin);
  const id = String(form.get("id") || "").trim();
  if (!id) return { error: "Rule not found.", rules };

  if (intent === "delete") {
    const next = rules.filter((rule) => rule.id !== id);
    const evaluated = evaluateScheduledRules(next);
    const payload = {
      rules: evaluated.rules,
      activeScheduleOverrides: evaluated.activeScheduleOverrides,
      evaluatedAt: evaluated.evaluatedAt,
    };
    await saveScheduledRules(admin, shopId, payload);
    return { rules: payload.rules };
  }

  const existing = rules.find((rule) => rule.id === id);
  if (!existing) return { error: "Rule not found.", rules };

  let patched = { ...existing, updatedAt: new Date().toISOString() };

  if (intent === "cancel") {
    patched.status = "cancelled";
  } else if (intent === "run-now") {
    const now = new Date();
    patched.startAt = new Date(now.getTime() - 60_000).toISOString();
    if (new Date(patched.endAt).getTime() <= now.getTime()) {
      patched.endAt = new Date(now.getTime() + 3600_000).toISOString();
    }
    patched.status = "active";
  } else if (intent === "end-now") {
    patched.endAt = new Date(Date.now() - 60_000).toISOString();
    patched.status = "ended";
  } else {
    return upsertScheduledRule(admin, form, { rules, shopId });
  }

  patched = normalizeScheduledRule(patched, existing);
  const next = rules.map((rule) => (rule.id === id ? patched : rule));
  const hydrated = await hydrateRuleTargetPreviews(admin, next);
  const evaluated = evaluateScheduledRules(hydrated);
  const payload = {
    rules: evaluated.rules,
    activeScheduleOverrides: evaluated.activeScheduleOverrides,
    evaluatedAt: evaluated.evaluatedAt,
  };
  await saveScheduledRules(admin, shopId, payload);
  return { rules: payload.rules };
}

export async function loadScheduledRulesView(admin) {
  let store;
  try {
    store = await syncScheduledRules(admin);
  } catch {
    store = await loadScheduledRules(admin);
    try {
      store = { ...store, rules: await hydrateRuleTargetPreviews(admin, store.rules) };
    } catch {
      // Keep parsed rules if product lookup fails.
    }
  }

  let collections = [];
  try {
    collections = await listCollections(admin);
  } catch {
    collections = [];
  }

  return {
    rules: store.rules || [],
    activeScheduleOverrides: store.activeScheduleOverrides || {
      enabledTargets: [],
      disabledTargets: [],
    },
    evaluatedAt: store.evaluatedAt || "",
    collections,
  };
}
