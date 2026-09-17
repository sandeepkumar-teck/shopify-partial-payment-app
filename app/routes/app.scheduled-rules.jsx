import { Navigate, useLocation, useRouteError } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { authenticate } from "../shopify.server";
import { loadScheduledRulesView, loadScheduledRules, mutateScheduledRule, upsertScheduledRule } from "../lib/scheduled-rules.server";
import { loadSettings } from "../lib/partial-payment.server";

export const loader = async ({ request }) => {
  const { admin } = await authenticate.admin(request);
  const view = await loadScheduledRulesView(admin);

  let settings = {};
  try {
    const loaded = await loadSettings(admin);
    settings = loaded.settings || {};
  } catch {
    settings = {};
  }

  return {
    rules: view.rules || [],
    activeScheduleOverrides: view.activeScheduleOverrides || {
      enabledTargets: [],
      disabledTargets: [],
    },
    evaluatedAt: view.evaluatedAt || "",
    collections: view.collections || [],
    settings,
    loadedAt: new Date().toISOString(),
  };
};

export const action = async ({ request }) => {
  const { admin } = await authenticate.admin(request);
  const form = await request.formData();
  const intent = String(form.get("intent") || "save");

  if (intent === "save") {
    const { shopId, rules } = await loadScheduledRules(admin);
    const result = await upsertScheduledRule(admin, form, { rules, shopId });
    if (result.error) return { error: result.error, rules: result.rules };
    return { rules: result.rules, saved: true };
  }

  const result = await mutateScheduledRule(admin, form, intent);
  if (result.error) return { error: result.error, rules: result.rules };
  return { rules: result.rules, intent };
};

export default function ScheduledRulesRedirect() {
  const location = useLocation();
  return <Navigate to={`/app/settings${location.search}#scheduled-rules`} replace />;
}

export function ErrorBoundary() {
  return boundary.error(useRouteError());
}

export const headers = (headersArgs) => boundary.headers(headersArgs);
