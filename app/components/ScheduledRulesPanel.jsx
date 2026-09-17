import { useEffect, useState } from "react";
import { useFetcher } from "react-router";
import { useAppBridge } from "@shopify/app-bridge-react";
import {
  clampScheduleForm,
  customRuleLabel,
  deriveRuleStatus,
  displayRuleName,
  findOverlappingRules,
  formatIstDateTime,
  formatSchedulePayRule,
  isoToIstLocalParts,
  scheduleInputBounds,
  schedulePayFormType,
  statusBadgeClass,
  targetLabel,
} from "../lib/scheduled-rules";

const SCHEDULED_RULES_ACTION = "/app/scheduled-rules";

function emptyForm(settings = {}) {
  return {
    id: "",
    name: "",
    targetType: "collection",
    targetIds: "",
    targetTags: "",
    targetPreviews: "[]",
    action: "enable_partial",
    startDate: "",
    startTime: "",
    endDate: "",
    endTime: "",
    payRuleType: settings.payRuleType || "fixed",
    fixedAmount: "500",
    percent: String(settings.percent ?? 25),
    customAmount: String(settings.customAmount ?? 0),
    surcharge: String(settings.surcharge ?? 500),
    fullyCodEnabled: "false",
  };
}

function pickerImage(product) {
  return (
    product?.images?.[0]?.originalSrc ||
    product?.images?.[0]?.url ||
    product?.featuredImage?.originalSrc ||
    product?.featuredImage?.url ||
    product?.image ||
    ""
  );
}

function patchForm(form, patch, options) {
  return clampScheduleForm({ ...form, ...patch }, new Date(), options);
}

function formFromRule(rule, settings = {}) {
  const start = isoToIstLocalParts(rule.startAt);
  const end = isoToIstLocalParts(rule.endAt);
  const payType = schedulePayFormType(rule);
  return {
    id: rule.id,
    name: customRuleLabel(rule) || "",
    targetType: rule.targetType || "collection",
    targetIds: (rule.targetIds || []).join(","),
    targetTags: (rule.targetTags || []).join(", "),
    targetPreviews: JSON.stringify(rule.targetPreviews || []),
    action: rule.action || "enable_partial",
    startDate: start.date,
    startTime: start.time,
    endDate: end.date,
    endTime: end.time,
    payRuleType: payType === "fully_cod" ? "fully_cod" : payType || settings.payRuleType || "fixed",
    fixedAmount: "500",
    percent: String(rule.percent ?? settings.percent ?? 25),
    customAmount: String(rule.customAmount ?? settings.customAmount ?? 0),
    surcharge: String(rule.fullyCodExtra ?? rule.surcharge ?? settings.surcharge ?? 500),
    fullyCodEnabled: payType === "fully_cod" ? "true" : "false",
  };
}

function RuleProductsCell({ rule }) {
  const label = customRuleLabel(rule);
  if (rule.targetType === "tag") {
    const tags = rule.targetTags || [];
    if (!tags.length) return "—";
    return (
      <div className="rule-products rule-products--stack">
        <div className="rule-tags">
          {tags.map((tag) => (
            <span className="rule-tag-chip" key={tag}>
              {tag}
            </span>
          ))}
        </div>
        {label ? <span className="rule-label-sub">{label}</span> : null}
      </div>
    );
  }

  const previews = Array.isArray(rule.targetPreviews) ? rule.targetPreviews : [];
  const thumbs = previews.slice(0, 3);
  const extra = Math.max(0, previews.length - 3);
  const title = targetLabel(rule);

  return (
    <div className="rule-products rule-products--stack">
      <div className="rule-products-row">
        {thumbs.length ? (
          <div className="rule-thumbs">
            {thumbs.map((item) =>
              item.image ? (
                <img key={item.id} src={item.image} alt="" />
              ) : (
                <span className="thumb" key={item.id} />
              ),
            )}
            {extra > 0 ? <span className="rule-thumbs-more">+{extra}</span> : null}
          </div>
        ) : null}
        <span className="rule-products-title">{title}</span>
      </div>
      {label ? <span className="rule-label-sub">{label}</span> : null}
    </div>
  );
}

export default function ScheduledRulesPanel({
  rules: initialRules = [],
  collections = [],
  settings = {},
}) {
  const fetcher = useFetcher();
  const shopify = useAppBridge();
  const rules = fetcher.data?.rules || initialRules || [];
  const [form, setForm] = useState(() => emptyForm(settings));
  const [editing, setEditing] = useState(false);
  const [selectedProducts, setSelectedProducts] = useState([]);
  const [nowTick, setNowTick] = useState(() => Date.now());
  const busy = ["submitting", "loading"].includes(fetcher.state) && fetcher.formMethod === "POST";
  const symbol = settings.currencySymbol || "₹";

  useEffect(() => {
    if (fetcher.data?.saved) shopify.toast.show("Scheduled rule saved");
    if (fetcher.data?.intent === "delete") shopify.toast.show("Rule deleted");
    if (fetcher.data?.intent === "cancel") shopify.toast.show("Rule cancelled");
    if (fetcher.data?.intent === "run-now") shopify.toast.show("Rule started now");
    if (fetcher.data?.intent === "end-now") shopify.toast.show("Rule ended now");
    if (fetcher.data?.error) shopify.toast.show(fetcher.data.error, { duration: 8000 });
  }, [fetcher.data, shopify]);

  useEffect(() => {
    const timer = window.setInterval(() => {
      if (document.visibilityState === "visible") {
        fetcher.load(SCHEDULED_RULES_ACTION);
      }
    }, 30_000);
    return () => window.clearInterval(timer);
  }, [fetcher]);

  useEffect(() => {
    const timer = window.setInterval(() => {
      if (document.visibilityState === "visible") setNowTick(Date.now());
    }, 15_000);
    return () => window.clearInterval(timer);
  }, []);

  useEffect(() => {
    if (editing) return;
    setForm((current) => {
      const next = clampScheduleForm(current, new Date(nowTick), { creating: true });
      if (
        next.startDate === current.startDate &&
        next.startTime === current.startTime &&
        next.endDate === current.endDate &&
        next.endTime === current.endTime
      ) {
        return current;
      }
      return next;
    });
  }, [nowTick, editing]);

  function resetForm() {
    setForm(emptyForm(settings));
    setSelectedProducts([]);
    setEditing(false);
  }

  function startEdit(rule) {
    setForm(formFromRule(rule, settings));
    setEditing(true);
    if (rule.targetType === "product") {
      const previews = Array.isArray(rule.targetPreviews) ? rule.targetPreviews : [];
      setSelectedProducts(
        previews.length
          ? previews
          : (rule.targetIds || []).map((id) => ({ id, title: id.split("/").pop(), image: "" })),
      );
    } else {
      setSelectedProducts([]);
    }
  }

  async function pickProducts() {
    const selected = await shopify.resourcePicker({
      type: "product",
      multiple: true,
      action: "select",
      selectionIds: selectedProducts.map((p) => ({ id: p.id })),
    });
    if (!selected?.length) return;
    const mapped = selected.map((product) => ({
      id: product.id,
      title: product.title || "",
      image: pickerImage(product),
      handle: product.handle || "",
    }));
    setSelectedProducts(mapped);
    setForm((prev) => ({
      ...prev,
      targetIds: mapped.map((p) => p.id).join(","),
      targetPreviews: JSON.stringify(mapped),
    }));
  }

  function submitForm(event) {
    event.preventDefault();
    const body = new FormData();
    body.set("intent", "save");
    const fullyCod = form.action === "enable_partial" && form.payRuleType === "fully_cod";
    Object.entries(form).forEach(([key, value]) => body.set(key, value));
    body.set("fullyCodEnabled", fullyCod ? "true" : "false");
    body.set("fullyCodExtra", form.surcharge || "");
    body.set("useShopPayRule", form.action === "disable_partial" ? "true" : "false");
    if (form.payRuleType === "percent") body.set("payRuleValue", form.percent || "");
    else if (form.payRuleType === "custom") body.set("payRuleValue", form.customAmount || "");
    else if (fullyCod) body.set("payRuleValue", form.surcharge || "");
    else body.set("payRuleValue", form.fixedAmount || "");
    if (form.targetType === "product" && selectedProducts.length) {
      body.set("targetIds", selectedProducts.map((product) => product.id).join(","));
      body.set(
        "targetPreviews",
        JSON.stringify(
          selectedProducts.map((product) => ({
            id: product.id,
            title: product.title || "",
            image: product.image || pickerImage(product),
            handle: product.handle || "",
          })),
        ),
      );
    }
    fetcher.submit(body, { method: "POST", action: SCHEDULED_RULES_ACTION });
    resetForm();
  }

  function ruleAction(id, intent) {
    const body = new FormData();
    body.set("intent", intent);
    body.set("id", id);
    fetcher.submit(body, { method: "POST", action: SCHEDULED_RULES_ACTION });
  }

  const draftRule = {
    id: form.id,
    targetType: form.targetType,
    targetIds: form.targetIds.split(",").map((s) => s.trim()).filter(Boolean),
    targetTags: form.targetTags.split(",").map((s) => s.trim()).filter(Boolean),
    startAt: form.startDate && form.startTime ? `${form.startDate}T${form.startTime}` : "",
    endAt: form.endDate && form.endTime ? `${form.endDate}T${form.endTime}` : "",
    status: "scheduled",
  };
  const overlaps = editing || form.targetIds || form.targetTags ? findOverlappingRules(rules, draftRule) : [];
  const dateBounds = scheduleInputBounds(form, new Date(nowTick), { creating: !editing });

  return (
    <>
      <section className="panel settings-card">
        <h2>{editing ? "Edit sale window" : "Create sale window"}</h2>
        <div className="panel-body">
          <p className="line-note">Runs on its own dates. Does not replace the Products rule.</p>
          <fetcher.Form
            method="POST"
            action={SCHEDULED_RULES_ACTION}
            className="settings-form"
            onSubmit={submitForm}
          >
            <input type="hidden" name="id" value={form.id} />
            <input type="hidden" name="targetPreviews" value={form.targetPreviews} />
            <div className="settings-grid">
              <label className="settings-field">
                <span>Label</span>
                <input
                  type="text"
                  name="name"
                  value={form.name}
                  onChange={(e) => setForm({ ...form, name: e.target.value })}
                  placeholder="Diwali sale"
                />
              </label>
              <label className="settings-field">
                <span>Target</span>
                <select
                  name="targetType"
                  value={form.targetType}
                  onChange={(e) => {
                    setSelectedProducts([]);
                    setForm({
                      ...form,
                      targetType: e.target.value,
                      targetIds: "",
                      targetTags: "",
                      targetPreviews: "[]",
                    });
                  }}
                >
                  <option value="collection">Collection</option>
                  <option value="product">Product</option>
                  <option value="tag">Tag</option>
                </select>
              </label>
              <label className="settings-field">
                <span>Action</span>
                <select
                  name="action"
                  value={form.action}
                  onChange={(e) => setForm({ ...form, action: e.target.value })}
                >
                  <option value="enable_partial">Enable partial payment</option>
                  <option value="disable_partial">Disable partial payment</option>
                </select>
              </label>
            </div>

            {form.targetType === "collection" ? (
              <label className="settings-field">
                <span>Collection</span>
                <select
                  name="targetIds"
                  value={form.targetIds.split(",")[0] || ""}
                  onChange={(e) => {
                    const selected = collections.find((col) => col.id === e.target.value);
                    setForm({
                      ...form,
                      targetIds: e.target.value,
                      targetPreviews: selected
                        ? JSON.stringify([
                            {
                              id: selected.id,
                              title: selected.title,
                              image: selected.image || "",
                              handle: selected.handle || "",
                            },
                          ])
                        : "[]",
                    });
                  }}
                >
                  <option value="">Select collection</option>
                  {collections.map((col) => (
                    <option key={col.id} value={col.id}>
                      {col.title}
                    </option>
                  ))}
                </select>
                {(() => {
                  const selectedId = form.targetIds.split(",")[0] || "";
                  const selected = collections.find((col) => col.id === selectedId);
                  if (!selected) return null;
                  return (
                    <div className="scheduled-rules-pick-list">
                      <span className="rule-pick-chip">
                        {selected.image ? <img src={selected.image} alt="" /> : <span className="thumb" />}
                        {selected.title}
                      </span>
                    </div>
                  );
                })()}
              </label>
            ) : null}

            {form.targetType === "product" ? (
              <div className="settings-field">
                <span>Products</span>
                <div className="scheduled-rules-pick">
                  <button type="button" className="btn-secondary" onClick={pickProducts}>
                    {selectedProducts.length ? "Change products" : "Pick products"}
                  </button>
                  {selectedProducts.length ? (
                    <div className="scheduled-rules-pick-list">
                      {selectedProducts.map((product) => (
                        <span className="rule-pick-chip" key={product.id}>
                          {product.image ? <img src={product.image} alt="" /> : <span className="thumb" />}
                          {product.title || product.id.split("/").pop()}
                        </span>
                      ))}
                    </div>
                  ) : (
                    <em>No products selected</em>
                  )}
                </div>
                <input type="hidden" name="targetIds" value={form.targetIds} />
              </div>
            ) : null}

            {form.targetType === "tag" ? (
              <label className="settings-field">
                <span>Tags</span>
                <input
                  type="text"
                  name="targetTags"
                  value={form.targetTags}
                  onChange={(e) => setForm({ ...form, targetTags: e.target.value })}
                  placeholder="sale, diwali"
                />
              </label>
            ) : null}

            <div className="settings-grid">
              <label className="settings-field">
                <span>Start date (IST)</span>
                <input
                  type="date"
                  name="startDate"
                  value={form.startDate}
                  min={dateBounds.minStartDate}
                  onChange={(e) => setForm(patchForm(form, { startDate: e.target.value }, { creating: !editing }))}
                  required
                />
              </label>
              <label className="settings-field">
                <span>Start time (IST)</span>
                <input
                  type="time"
                  name="startTime"
                  value={form.startTime}
                  min={dateBounds.minStartTime || undefined}
                  onChange={(e) => setForm(patchForm(form, { startTime: e.target.value }, { creating: !editing }))}
                  required
                />
              </label>
              <label className="settings-field">
                <span>End date (IST)</span>
                <input
                  type="date"
                  name="endDate"
                  value={form.endDate}
                  min={dateBounds.minEndDate}
                  onChange={(e) => setForm(patchForm(form, { endDate: e.target.value }, { creating: !editing }))}
                  required
                />
              </label>
              <label className="settings-field">
                <span>End time (IST)</span>
                <input
                  type="time"
                  name="endTime"
                  value={form.endTime}
                  min={dateBounds.minEndTime || undefined}
                  onChange={(e) => setForm(patchForm(form, { endTime: e.target.value }, { creating: !editing }))}
                  required
                />
              </label>
            </div>

            {form.action === "enable_partial" ? (
              <div className="schedule-pay-fields">
                <p className="line-note">Only these targets use this pay rule until the end time.</p>
                <div className="settings-grid">
                  <label className="settings-field">
                    <span>Pay now</span>
                    <select
                      name="payRuleType"
                      value={form.payRuleType}
                      onChange={(e) => {
                        const next = e.target.value;
                        setForm({
                          ...form,
                          payRuleType: next,
                          fullyCodEnabled: next === "fully_cod" ? "true" : "false",
                        });
                      }}
                    >
                      <option value="fixed">Fixed amount</option>
                      <option value="percent">Percent of cart total</option>
                      <option value="custom">Custom amount</option>
                      <option value="fully_cod">Fully COD</option>
                    </select>
                  </label>
                  {form.payRuleType === "fixed" ? (
                    <label className="settings-field">
                      <span>Fixed amount</span>
                      <input
                        type="number"
                        name="fixedAmount"
                        value="500"
                        readOnly
                        aria-readonly="true"
                        title="Fixed amount is always ₹500. Use Custom amount for another value."
                      />
                    </label>
                  ) : null}
                  {form.payRuleType === "percent" ? (
                    <label className="settings-field">
                      <span>Percent</span>
                      <input
                        type="number"
                        name="percent"
                        min={0}
                        max={100}
                        step="1"
                        value={form.percent}
                        onChange={(e) => setForm({ ...form, percent: e.target.value })}
                      />
                    </label>
                  ) : null}
                  {form.payRuleType === "custom" ? (
                    <label className="settings-field">
                      <span>Custom amount</span>
                      <input
                        type="number"
                        name="customAmount"
                        min={0}
                        step="1"
                        value={form.customAmount}
                        onChange={(e) => setForm({ ...form, customAmount: e.target.value })}
                      />
                    </label>
                  ) : null}
                  {form.payRuleType === "fully_cod" ? (
                    <label className="settings-field">
                      <span>COD extra</span>
                      <input
                        type="number"
                        name="surcharge"
                        min={0}
                        step="1"
                        value={form.surcharge}
                        onChange={(e) => setForm({ ...form, surcharge: e.target.value })}
                      />
                    </label>
                  ) : null}
                </div>
                <input type="hidden" name="fullyCodEnabled" value={form.fullyCodEnabled} />
                {form.payRuleType !== "fully_cod" ? (
                  <input type="hidden" name="surcharge" value={form.surcharge} />
                ) : null}
                {form.payRuleType !== "fixed" ? (
                  <input type="hidden" name="fixedAmount" value="500" />
                ) : null}
                {form.payRuleType !== "percent" ? (
                  <input type="hidden" name="percent" value={form.percent} />
                ) : null}
                {form.payRuleType !== "custom" ? (
                  <input type="hidden" name="customAmount" value={form.customAmount} />
                ) : null}
              </div>
            ) : (
              <p className="line-note">Turns partial off for these targets during the window.</p>
            )}

            {overlaps.length ? (
              <div className="dash-banner">
                Overlapping rule on the same target: &ldquo;{customRuleLabel(overlaps[0]) || displayRuleName(overlaps[0])}
                &rdquo;. Matching either Enable target still gets that schedule&rsquo;s pay rule. A Disable
                rule on the same product turns partial off.
              </div>
            ) : null}

            <div className="scheduled-rules-form-actions">
              <button type="submit" className="btn-primary settings-save" disabled={busy}>
                {busy ? "Saving…" : editing ? "Update rule" : "Create rule"}
              </button>
              {editing ? (
                <button type="button" className="btn-secondary" onClick={resetForm}>
                  Cancel edit
                </button>
              ) : null}
            </div>
          </fetcher.Form>
        </div>
      </section>

      <section className="panel orders settings-card">
        <h2>Rules</h2>
        <div className="panel-body">
          {!rules.length ? (
            <div className="empty">No sale windows yet.</div>
          ) : (
            <div className="table-scroll">
              <table className="data-table scheduled-rules-table">
                <thead>
                  <tr>
                    <th>Products</th>
                    <th>Start (IST)</th>
                    <th>End (IST)</th>
                    <th>Pay rule</th>
                    <th>Status</th>
                    <th className="col-action">Manage</th>
                  </tr>
                </thead>
                <tbody>
                  {rules.map((rule) => {
                    const status = deriveRuleStatus(rule);
                    return (
                      <tr key={rule.id}>
                        <td>
                          <RuleProductsCell rule={rule} />
                        </td>
                        <td className="col-date">{formatIstDateTime(rule.startAt)}</td>
                        <td className="col-date">{formatIstDateTime(rule.endAt)}</td>
                        <td className="col-pay-rule">{formatSchedulePayRule(rule, symbol)}</td>
                        <td>
                          <span className={statusBadgeClass(status)}>{status}</span>
                        </td>
                        <td className="col-action scheduled-rules-manage">
                          <button
                            type="button"
                            className="btn-cod"
                            onClick={() => startEdit(rule)}
                          >
                            Edit
                          </button>
                          {status !== "cancelled" && status !== "ended" ? (
                            <button
                              type="button"
                              className="btn-cod"
                              onClick={() => ruleAction(rule.id, "run-now")}
                              disabled={busy}
                            >
                              Run now
                            </button>
                          ) : null}
                          {status === "active" ? (
                            <button
                              type="button"
                              className="btn-cod"
                              onClick={() => ruleAction(rule.id, "end-now")}
                              disabled={busy}
                            >
                              End now
                            </button>
                          ) : null}
                          {status !== "cancelled" && status !== "ended" ? (
                            <button
                              type="button"
                              className="btn-cod"
                              onClick={() => ruleAction(rule.id, "cancel")}
                              disabled={busy}
                            >
                              Cancel
                            </button>
                          ) : null}
                          <button
                            type="button"
                            className="btn-cod btn-link--danger"
                            onClick={() => ruleAction(rule.id, "delete")}
                            disabled={busy}
                          >
                            Delete
                          </button>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </section>
    </>
  );
}
