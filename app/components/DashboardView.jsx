import { useId, useMemo, useRef, useState } from "react";
import { formatMoney, formatPayRule, formatShopActiveRule } from "../lib/partial-payment";
import {
  buildPeriodTrend,
  COLLECTION_PERIODS,
  formatDashboardDate,
  ORDERS_PAGE_SIZE,
  pageWindow,
  shopifyOrderAdminUrl,
} from "../lib/dashboard";
import {
  clampInvoiceDays,
  formatShortIstDate,
  orderAllowsInvoice,
  scheduleSelectValue,
} from "../lib/invoice-schedule";
import AppShell from "./AppShell";
import Pagination from "./Pagination";

const PAID_COLOR = "#6366f1";
const COD_COLOR = "#f59e0b";
const CHART = { width: 640, height: 276, padL: 64, padR: 22, padT: 24, padB: 40 };

function niceCeiling(value) {
  if (!Number.isFinite(value) || value <= 0) return 1;
  const exp = 10 ** Math.floor(Math.log10(value));
  const n = value / exp;
  const nice = n <= 1 ? 1 : n <= 2 ? 2 : n <= 5 ? 5 : 10;
  return nice * exp;
}

function formatAxisValue(value, symbol) {
  if (!value) return `${symbol}0`;
  const abs = Math.abs(value);
  if (abs >= 1_000_000) {
    const scaled = value / 1_000_000;
    const text = Number.isInteger(scaled) ? String(scaled) : scaled.toFixed(1).replace(/\.0$/, "");
    return `${symbol}${text}M`;
  }
  if (abs >= 10_000) {
    const scaled = value / 1000;
    const text = Number.isInteger(scaled) ? String(scaled) : scaled.toFixed(1).replace(/\.0$/, "");
    return `${symbol}${text}k`;
  }
  return `${symbol}${Math.round(value).toLocaleString("en-IN")}`;
}

function showTickLabel(trend, index, periodId) {
  const last = trend.length - 1;
  if (trend.length <= 10) return true;
  if (index === 0 || index === last) return true;
  if (periodId === "1m") return index % 5 === 0;
  const step = Math.ceil(trend.length / 7);
  return index % step === 0;
}

function roundPath(value) {
  return Math.round(value * 100) / 100;
}

/** Monotone cubic (Fritsch–Carlson) so sparse zeros do not overshoot the baseline. */
function monotoneLinePath(points) {
  const n = points.length;
  if (!n) return "";
  if (n === 1) return `M ${roundPath(points[0].x)} ${roundPath(points[0].y)}`;
  const dx = [];
  const m = [];
  for (let i = 0; i < n - 1; i += 1) {
    dx[i] = points[i + 1].x - points[i].x;
    m[i] = dx[i] ? (points[i + 1].y - points[i].y) / dx[i] : 0;
  }
  const slope = new Array(n);
  slope[0] = m[0];
  slope[n - 1] = m[n - 2];
  for (let i = 1; i < n - 1; i += 1) {
    slope[i] = m[i - 1] * m[i] <= 0 ? 0 : (m[i - 1] + m[i]) / 2;
  }
  for (let i = 0; i < n - 1; i += 1) {
    if (Math.abs(m[i]) < 1e-12) {
      slope[i] = 0;
      slope[i + 1] = 0;
    } else {
      const a = slope[i] / m[i];
      const b = slope[i + 1] / m[i];
      const h = Math.hypot(a, b);
      if (h > 3) {
        const t = 3 / h;
        slope[i] = t * a * m[i];
        slope[i + 1] = t * b * m[i];
      }
    }
  }
  let d = `M ${roundPath(points[0].x)} ${roundPath(points[0].y)}`;
  for (let i = 0; i < n - 1; i += 1) {
    const p0 = points[i];
    const p1 = points[i + 1];
    const c = dx[i] / 3;
    d += ` C ${roundPath(p0.x + c)} ${roundPath(p0.y + slope[i] * c)}, ${roundPath(p1.x - c)} ${roundPath(p1.y - slope[i + 1] * c)}, ${roundPath(p1.x)} ${roundPath(p1.y)}`;
  }
  return d;
}

function areaPathFromLine(lineD, points, baselineY) {
  if (!points.length || !lineD) return "";
  const first = points[0];
  const last = points[points.length - 1];
  return `${lineD} L ${roundPath(last.x)} ${roundPath(baselineY)} L ${roundPath(first.x)} ${roundPath(baselineY)} Z`;
}

function areaChartLayout(trend, periodId) {
  const { width, height, padL, padR, padT, padB } = CHART;
  const innerW = width - padL - padR;
  const innerH = height - padT - padB;
  const maxRaw = Math.max(
    0,
    ...trend.map((row) => Math.max(Number(row.payNow || 0), Number(row.payCod || 0))),
  );
  const max = niceCeiling(maxRaw);
  const n = Math.max(trend.length, 1);
  const step = n === 1 ? 0 : innerW / (n - 1);
  const fractions = maxRaw === 0 ? [0, 1] : [0, 0.25, 0.5, 0.75, 1];
  const ticks = fractions.map((t) => ({
    value: max * t,
    y: padT + innerH * (1 - t),
  }));
  const points = trend.map((row, index) => {
    const payNow = Number(row.payNow || 0);
    const payCod = Number(row.payCod || 0);
    const x = n === 1 ? padL + innerW / 2 : padL + index * step;
    return {
      key: row.date || `${row.label}-${index}`,
      label: row.label,
      x,
      payNow,
      payCod,
      paidY: padT + innerH - (payNow / max) * innerH,
      codY: padT + innerH - (payCod / max) * innerH,
      showLabel: showTickLabel(trend, index, periodId),
    };
  });
  const paidLine = monotoneLinePath(points.map((p) => ({ x: p.x, y: p.paidY })));
  const codLine = monotoneLinePath(points.map((p) => ({ x: p.x, y: p.codY })));
  const axisY = padT + innerH;
  return {
    ticks,
    points,
    paidLine,
    codLine,
    paidArea: areaPathFromLine(paidLine, points, axisY),
    codArea: areaPathFromLine(codLine, points, axisY),
    innerW,
    innerH,
    axisY,
    padL,
    padR,
    padT,
    width,
    height,
    showMarkers: points.length <= 16,
  };
}

function svgPointFromEvent(svg, clientX, clientY) {
  const ctm = svg.getScreenCTM?.();
  if (ctm && typeof svg.createSVGPoint === "function") {
    const point = svg.createSVGPoint();
    point.x = clientX;
    point.y = clientY;
    return point.matrixTransform(ctm.inverse());
  }
  const rect = svg.getBoundingClientRect();
  const vb = svg.viewBox?.baseVal;
  const width = vb?.width || CHART.width;
  const height = vb?.height || CHART.height;
  return {
    x: ((clientX - rect.left) / Math.max(rect.width, 1)) * width,
    y: ((clientY - rect.top) / Math.max(rect.height, 1)) * height,
  };
}

function CollectionsAreaChart({ trend, period, symbol, title }) {
  const rawId = useId();
  const uid = `pp${rawId.replace(/[^a-zA-Z0-9_-]/g, "")}`;
  const [hoverKey, setHoverKey] = useState(null);
  const layout = useMemo(() => areaChartLayout(trend, period.id), [trend, period.id]);
  const hover = layout.points.find((point) => point.key === hoverKey) || null;

  const onPointerMove = (event) => {
    const loc = svgPointFromEvent(event.currentTarget, event.clientX, event.clientY);
    if (!loc || !layout.points.length) return;
    let nearest = layout.points[0];
    let best = Infinity;
    for (const point of layout.points) {
      const dist = Math.abs(point.x - loc.x);
      if (dist < best) {
        best = dist;
        nearest = point;
      }
    }
    setHoverKey((current) => (current === nearest.key ? current : nearest.key));
  };

  const slot =
    layout.points.length > 1 ? layout.innerW / (layout.points.length - 1) : 32;
  const bandW = Math.min(32, Math.max(18, slot * 0.55));
  const bandX = hover
    ? Math.max(
        layout.padL,
        Math.min(hover.x - bandW / 2, layout.padL + layout.innerW - bandW),
      )
    : 0;
  const tooltipShift =
    hover && hover.x / layout.width > 0.78
      ? "translateX(-100%)"
      : hover && hover.x / layout.width < 0.18
        ? "translateX(0)"
        : "translateX(-50%)";

  return (
    <div className="chart-stage">
      <svg
        className="chart-svg"
        viewBox={`0 0 ${layout.width} ${layout.height}`}
        role="img"
        aria-label={title}
        onPointerMove={onPointerMove}
        onPointerLeave={() => setHoverKey(null)}
      >
        <defs>
          <linearGradient id={`${uid}-paid-fill`} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor={PAID_COLOR} stopOpacity="0.38" />
            <stop offset="72%" stopColor={PAID_COLOR} stopOpacity="0.08" />
            <stop offset="100%" stopColor={PAID_COLOR} stopOpacity="0" />
          </linearGradient>
          <linearGradient id={`${uid}-cod-fill`} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor={COD_COLOR} stopOpacity="0.32" />
            <stop offset="72%" stopColor={COD_COLOR} stopOpacity="0.07" />
            <stop offset="100%" stopColor={COD_COLOR} stopOpacity="0" />
          </linearGradient>
          <linearGradient id={`${uid}-plot`} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor={PAID_COLOR} stopOpacity="0.045" />
            <stop offset="100%" stopColor="#ffffff" stopOpacity="0" />
          </linearGradient>
          <filter id={`${uid}-glow`} x="-18%" y="-40%" width="136%" height="180%">
            <feGaussianBlur stdDeviation="2.4" result="blur" />
            <feMerge>
              <feMergeNode in="blur" />
              <feMergeNode in="SourceGraphic" />
            </feMerge>
          </filter>
          <clipPath id={`${uid}-clip`}>
            <rect x={layout.padL} y={layout.padT} width={layout.innerW} height={layout.innerH} />
          </clipPath>
        </defs>
        <rect
          x={layout.padL}
          y={layout.padT}
          width={layout.innerW}
          height={layout.innerH}
          fill={`url(#${uid}-plot)`}
        />
        {layout.ticks.map((tick) => (
          <g key={tick.value}>
            {tick.value !== 0 ? (
              <line
                x1={layout.padL}
                x2={layout.width - layout.padR}
                y1={tick.y}
                y2={tick.y}
                className="chart-grid"
              />
            ) : null}
            <text
              x={layout.padL - 8}
              y={tick.y}
              className="chart-axis-y"
              textAnchor="end"
              dominantBaseline="middle"
            >
              {formatAxisValue(tick.value, symbol)}
            </text>
          </g>
        ))}
        <line
          x1={layout.padL}
          x2={layout.width - layout.padR}
          y1={layout.axisY}
          y2={layout.axisY}
          className="chart-baseline"
        />
        {hover ? (
          <rect
            className="chart-hover-band"
            x={bandX}
            y={layout.padT}
            width={bandW}
            height={layout.innerH}
          />
        ) : null}
        <g clipPath={`url(#${uid}-clip)`}>
          <path className="chart-area-cod" d={layout.codArea} fill={`url(#${uid}-cod-fill)`} />
          <path className="chart-area-paid" d={layout.paidArea} fill={`url(#${uid}-paid-fill)`} />
        </g>
        <path
          className="chart-line-cod"
          d={layout.codLine}
          filter={`url(#${uid}-glow)`}
        />
        <path
          className="chart-line-paid"
          d={layout.paidLine}
          filter={`url(#${uid}-glow)`}
        />
        {hover ? (
          <line
            className="chart-crosshair"
            x1={hover.x}
            x2={hover.x}
            y1={layout.padT}
            y2={layout.axisY}
          />
        ) : null}
        {layout.points.map((point) => (
          <g key={point.key}>
            <line
              x1={point.x}
              x2={point.x}
              y1={layout.axisY}
              y2={layout.axisY + 5}
              className="chart-tick"
            />
            {point.showLabel ? (
              <text x={point.x} y={layout.height - 12} className="chart-axis-x" textAnchor="middle">
                {point.label}
              </text>
            ) : null}
            {(layout.showMarkers && point.payCod > 0) || hoverKey === point.key ? (
              <circle
                className={`chart-marker chart-marker-cod${hoverKey === point.key ? " is-active" : ""}`}
                cx={point.x}
                cy={point.codY}
                r={hoverKey === point.key ? 5 : 3.5}
              />
            ) : null}
            {(layout.showMarkers && point.payNow > 0) || hoverKey === point.key ? (
              <circle
                className={`chart-marker chart-marker-paid${hoverKey === point.key ? " is-active" : ""}`}
                cx={point.x}
                cy={point.paidY}
                r={hoverKey === point.key ? 5 : 3.5}
              />
            ) : null}
          </g>
        ))}
        <rect
          className="chart-hit"
          x={layout.padL}
          y={layout.padT}
          width={layout.innerW}
          height={layout.innerH}
        />
      </svg>
      {hover ? (
        <div
          className="chart-tooltip"
          style={{ left: `${(hover.x / layout.width) * 100}%`, transform: tooltipShift }}
        >
          <strong>{hover.label}</strong>
          <div className="chart-tooltip-row">
            <span><span className="dot" style={{ background: PAID_COLOR }} /> Paid online</span>
            <b>{formatMoney(hover.payNow, symbol)}</b>
          </div>
          <div className="chart-tooltip-row">
            <span><span className="dot" style={{ background: COD_COLOR }} /> Remaining COD</span>
            <b>{formatMoney(hover.payCod, symbol)}</b>
          </div>
        </div>
      ) : null}
    </div>
  );
}

const DONUT = { size: 200, cx: 100, cy: 100, r: 72, stroke: 11 };
const SLICE_TONES = {
  partial_paid: { from: "#FBBF24", to: "#F59E0B", soft: "rgba(245, 158, 11, 0.1)" },
  unpaid_cod: { from: "#F87171", to: "#EF4444", soft: "rgba(239, 68, 68, 0.1)" },
  fully_paid: { from: "#34D399", to: "#10B981", soft: "rgba(16, 185, 129, 0.1)" },
  refunded: { from: "#CBD5E1", to: "#94A3B8", soft: "rgba(148, 163, 184, 0.1)" },
};

function sliceTone(slice) {
  return SLICE_TONES[slice.key] || { from: slice.color, to: slice.color, soft: "rgba(99, 102, 241, 0.1)" };
}

function polarPoint(cx, cy, r, deg) {
  const rad = ((deg - 90) * Math.PI) / 180;
  return {
    x: roundPath(cx + r * Math.cos(rad)),
    y: roundPath(cy + r * Math.sin(rad)),
  };
}

function donutArcPath(cx, cy, r, startDeg, endDeg) {
  const sweep = endDeg - startDeg;
  if (sweep >= 359.2) {
    const a = polarPoint(cx, cy, r, 0);
    const b = polarPoint(cx, cy, r, 180);
    return `M ${a.x} ${a.y} A ${r} ${r} 0 1 1 ${b.x} ${b.y} A ${r} ${r} 0 1 1 ${a.x} ${a.y}`;
  }
  const start = polarPoint(cx, cy, r, startDeg);
  const end = polarPoint(cx, cy, r, endDeg);
  const large = sweep > 180 ? 1 : 0;
  return `M ${start.x} ${start.y} A ${r} ${r} 0 ${large} 1 ${end.x} ${end.y}`;
}

function formatShare(value, total) {
  if (!total || !value) return "0%";
  const pct = (value / total) * 100;
  if (pct > 0 && pct < 1) return "<1%";
  return `${Math.round(pct)}%`;
}

function paymentStatusLayout(slices, total) {
  const rows = (slices || []).map((slice) => ({
    key: slice.key,
    label: slice.label || slice.key,
    value: Number(slice.value || 0),
    color: slice.color,
  }));
  const ringSlices = rows.filter((row) => row.value > 0);
  const gap = ringSlices.length > 1 ? 2.5 : 0;
  const usable = 360 - gap * ringSlices.length;
  let cursor = 0;
  const ringByKey = new Map();
  for (const row of ringSlices) {
    const sweep = total > 0 ? (row.value / total) * usable : 0;
    const start = cursor + gap / 2;
    const end = start + sweep;
    ringByKey.set(row.key, { start, end, mid: (start + end) / 2, sweep });
    cursor = end + gap / 2;
  }
  return rows.map((row) => {
    const ring = ringByKey.get(row.key);
    return {
      ...row,
      tone: sliceTone(row),
      share: formatShare(row.value, total),
      barPct: total > 0 ? Math.min(100, (row.value / total) * 100) : 0,
      onRing: Boolean(ring),
      start: ring?.start ?? 0,
      end: ring?.end ?? 0,
      mid: ring?.mid ?? 0,
      sweep: ring?.sweep ?? 0,
    };
  });
}

function donutTooltipStyle(row) {
  if (!row?.onRing) {
    return { left: "50%", top: "10%", transform: "translateX(-50%)" };
  }
  const point = polarPoint(DONUT.cx, DONUT.cy, DONUT.r + DONUT.stroke / 2 + 10, row.mid);
  const left = (point.x / DONUT.size) * 100;
  const top = (point.y / DONUT.size) * 100;
  const shiftX = left > 72 ? "-100%" : left < 28 ? "0" : "-50%";
  const shiftY = top > 64 ? "-112%" : "8%";
  return { left: `${left}%`, top: `${top}%`, transform: `translate(${shiftX}, ${shiftY})` };
}

function PaymentStatusChart({ slices, total }) {
  const rawId = useId();
  const uid = `ps${rawId.replace(/[^a-zA-Z0-9_-]/g, "")}`;
  const [hoverKey, setHoverKey] = useState(null);
  const rows = useMemo(() => paymentStatusLayout(slices, total), [slices, total]);
  const hover = rows.find((row) => row.key === hoverKey) || null;
  const { size, cx, cy, r, stroke } = DONUT;

  return (
    <div className="donut-wrap" onPointerLeave={() => setHoverKey(null)}>
      <div className="donut-stage">
        <div className="donut-frame">
          <svg
            className="donut-svg"
            viewBox={`0 0 ${size} ${size}`}
            width={size}
            height={size}
            role="img"
            aria-label="Payment status"
          >
            <defs>
              {rows.map((row) => (
                <linearGradient
                  key={row.key}
                  id={`${uid}-${row.key}`}
                  x1="0"
                  y1="0"
                  x2="1"
                  y2="1"
                >
                  <stop offset="0%" stopColor={row.tone.from} />
                  <stop offset="100%" stopColor={row.tone.to} />
                </linearGradient>
              ))}
            </defs>
            <circle
              className="donut-track"
              cx={cx}
              cy={cy}
              r={r}
              fill="none"
              stroke="#E8EDF5"
              strokeWidth={stroke}
            />
            {rows
              .filter((row) => row.onRing)
              .map((row, index) => {
                const d = donutArcPath(cx, cy, r, row.start, row.end);
                const active = !hover || hover.key === row.key;
                return (
                  <g key={row.key}>
                    <path
                      className={`donut-slice${active ? "" : " is-dim"}${hover?.key === row.key ? " is-hot" : ""}`}
                      d={d}
                      fill="none"
                      stroke={`url(#${uid}-${row.key})`}
                      strokeWidth={hover?.key === row.key ? stroke + 1.5 : stroke}
                      strokeLinecap="butt"
                      strokeLinejoin="round"
                      pathLength={1}
                      style={{ animationDelay: `${index * 80}ms` }}
                    />
                    <path
                      className="donut-hit"
                      d={d}
                      fill="none"
                      stroke="transparent"
                      strokeWidth={stroke + 10}
                      strokeLinecap="butt"
                      onPointerEnter={() => setHoverKey(row.key)}
                    />
                  </g>
                );
              })}
          </svg>
          <div className="donut-center">
            <strong>{total}</strong>
            <span>Orders</span>
          </div>
        </div>
        {hover ? (
          <div className="chart-tooltip donut-tooltip" style={donutTooltipStyle(hover)}>
            <strong>{hover.label}</strong>
            <div className="chart-tooltip-row">
              <span>
                <span className="dot" style={{ background: hover.tone.to }} /> Count
              </span>
              <b>{hover.value}</b>
            </div>
            <div className="chart-tooltip-row">
              <span>Share</span>
              <b>{hover.share}</b>
            </div>
          </div>
        ) : null}
      </div>
      <ul className="legend">
        {rows.map((row) => {
          const active = hoverKey === row.key;
          return (
            <li key={row.key}>
              <button
                type="button"
                className={`legend-row${active ? " is-active" : ""}${hoverKey && !active ? " is-dim" : ""}`}
                style={{ "--legend-soft": row.tone.soft, "--legend-from": row.tone.from, "--legend-to": row.tone.to }}
                onPointerEnter={() => setHoverKey(row.key)}
                onFocus={() => setHoverKey(row.key)}
                onBlur={() => setHoverKey((current) => (current === row.key ? null : current))}
                aria-label={`${row.label}, ${row.value} orders, ${row.share}`}
              >
                <span className="legend-pip" style={{ background: row.tone.to }} />
                <span className="legend-copy">
                  <span className="legend-meta">
                    <span className="legend-label">{row.label}</span>
                    <strong>{row.value}</strong>
                  </span>
                  <span className="legend-bar-row">
                    <span className="legend-bar">
                      <i style={{ "--w": `${row.barPct}%` }} />
                    </span>
                    <em>{row.share}</em>
                  </span>
                </span>
              </button>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

function IconOrders() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
      <rect x="4" y="3" width="16" height="18" rx="2" />
      <path d="M8 8h8M8 12h8M8 16h5" />
    </svg>
  );
}

function IconValue() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
      <path d="M12 3v18" />
      <path d="M16.5 7.5c0-1.9-2-3.5-4.5-3.5S7.5 5.6 7.5 7.5 9.4 11 12 11s4.5 1.4 4.5 3.5-2 3.5-4.5 3.5-4.5-1.6-4.5-3.5" />
    </svg>
  );
}

function IconPaid() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
      <circle cx="12" cy="12" r="9" />
      <path d="M8 12.5l2.5 2.5L16 9.5" />
    </svg>
  );
}

function IconCod() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
      <rect x="2" y="6" width="20" height="12" rx="2" />
      <circle cx="12" cy="12" r="2.5" />
    </svg>
  );
}

function IconCollected() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
      <path d="M4 10h16v9H4z" />
      <path d="M8 10V8a4 4 0 018 0v2" />
      <path d="M12 14v3" />
    </svg>
  );
}

function IconRate() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
      <path d="M4 19V5M4 19h16" />
      <path d="M8 15l4-5 3 3 5-7" />
    </svg>
  );
}

function badgeFor(order) {
  if (order.status === "fully_paid") {
    return { className: "badge badge-success", label: "Fully Paid" };
  }
  if (order.status === "unpaid_cod") {
    return { className: "badge badge-alert", label: "Unpaid COD" };
  }
  if (order.status === "refunded") {
    return { className: "badge badge-muted", label: "Refunded" };
  }
  return { className: "badge badge-partial", label: "Partially Paid" };
}

function MetricCard({ tone, icon, title, value, hint }) {
  return (
    <article className={`kpi kpi-${tone}`}>
      <div className="kpi-inner">
        <div className="kpi-icon" aria-hidden="true">
          {icon}
        </div>
        <div className="kpi-copy">
          <small>{title}</small>
          <strong>{value}</strong>
          {hint ? <em>{hint}</em> : null}
        </div>
      </div>
    </article>
  );
}

function formatOrderDate(value) {
  return formatDashboardDate(value);
}

function fetcherBusy(fetcher, intent, orderId) {
  if (!fetcher || !["loading", "submitting"].includes(fetcher.state)) return false;
  if (!fetcher.formData) return false;
  if (intent && String(fetcher.formData.get("intent") || "") !== intent) return false;
  if (orderId && String(fetcher.formData.get("orderId") || "") !== String(orderId)) return false;
  return true;
}

function matchesOrderSearch(order, query) {
  const raw = String(query || "").trim().toLowerCase();
  if (!raw) return true;
  const needle = raw.replace(/^#/, "");
  const name = String(order.name || "").toLowerCase();
  const nameBare = name.replace(/^#/, "");
  const numeric = String(order.numericId || "").toLowerCase();
  return name.includes(raw) || name.includes(needle) || nameBare.includes(needle) || numeric.includes(needle);
}

function isRemainingOrder(order) {
  if (!order || order.status === "refunded") return false;
  if (order.status === "fully_paid") return Number(order.payCod || 0) > 0;
  return (
    order.status === "partial_paid" ||
    order.status === "unpaid_cod" ||
    Number(order.payCod || 0) > 0
  );
}

function isPaidOrder(order) {
  if (!order || order.status === "refunded") return false;
  return !isRemainingOrder(order);
}

function sumVisibleOrderStats(orders = []) {
  return orders.reduce(
    (acc, order) => {
      acc.orders += 1;
      acc.fullPrice += Number(order.fullPrice || 0);
      acc.payNow += Number(order.payNow || 0);
      acc.payCod += Number(order.payCod || 0);
      acc.collectedCod += Number(order.collectedCod || 0);
      return acc;
    },
    { orders: 0, fullPrice: 0, payNow: 0, payCod: 0, collectedCod: 0 },
  );
}

function InvoiceCell({ order, fetcher }) {
  const initialSchedule = scheduleSelectValue(order);
  const [customOpen, setCustomOpen] = useState(false);
  const [customDays, setCustomDays] = useState(String(order.invoiceDays || 7));
  const customInputRef = useRef(null);
  const allows = Boolean(fetcher) && orderAllowsInvoice(order);
  const sending = fetcherBusy(fetcher, "send-invoice", order.id);
  const scheduling = fetcherBusy(fetcher, "schedule-invoice", order.id);
  const sentLabel = order.invoiceSentAt ? formatShortIstDate(order.invoiceSentAt) : "";
  const dueDate =
    order.invoiceScheduled && order.invoiceMode !== "off" && order.invoiceDueAt
      ? formatShortIstDate(order.invoiceDueAt)
      : "";
  const invoiceError =
    fetcher?.data?.invoice?.error && fetcher.data.invoice.orderId === order.id
      ? fetcher.data.invoice.error
      : "";
  const scheduleError =
    fetcher?.data?.schedule?.error && fetcher.data.schedule.orderId === order.id
      ? fetcher.data.schedule.error
      : "";
  const showCustom = customOpen || initialSchedule === "custom";

  if (!allows) {
    return (
      <div className="invoice-cell">
        <span className="invoice-paid">No invoice due</span>
      </div>
    );
  }

  function onScheduleChange(event) {
    const value = event.target.value;
    if (value === "custom") {
      setCustomOpen(true);
      queueMicrotask(() => customInputRef.current?.focus());
      return;
    }
    setCustomOpen(false);
    event.target.form?.requestSubmit();
  }

  function saveCustomDays(event) {
    const form = event.target.form;
    if (!form || scheduling) return;
    const days = clampInvoiceDays(customDays);
    if (String(days) !== String(customDays)) setCustomDays(String(days));
    if (initialSchedule === "custom" && Number(days) === Number(order.invoiceDays || 7)) {
      setCustomOpen(false);
      return;
    }
    form.requestSubmit();
  }

  function onCustomBlur(event) {
    const form = event.target.form;
    requestAnimationFrame(() => {
      if (form && form.contains(document.activeElement)) return;
      saveCustomDays(event);
    });
  }

  function onCustomKeyDown(event) {
    if (event.key !== "Enter") return;
    event.preventDefault();
    saveCustomDays(event);
  }

  return (
    <div className="invoice-cell">
      <div className="invoice-cell-row">
        {order.invoiceSentAt ? (
          <div className="invoice-sent-wrap">
            <span className="invoice-sent" title={sentLabel ? `Sent ${sentLabel}` : undefined}>
              Invoice sent
            </span>
            <fetcher.Form method="POST" className="invoice-again-form">
              <input type="hidden" name="intent" value="send-invoice" />
              <input type="hidden" name="orderId" value={order.id} />
              <button type="submit" className="btn-link invoice-again" disabled={sending}>
                {sending ? "Sending…" : "Send again"}
              </button>
            </fetcher.Form>
          </div>
        ) : (
          <fetcher.Form method="POST" className="invoice-send-form">
            <input type="hidden" name="intent" value="send-invoice" />
            <input type="hidden" name="orderId" value={order.id} />
            <button type="submit" className="btn-primary btn-cod btn-invoice" disabled={sending}>
              {sending ? "Sending…" : "Send invoice"}
            </button>
          </fetcher.Form>
        )}
        <fetcher.Form method="POST" className={`invoice-auto-form${showCustom ? " is-custom" : ""}`}>
          <input type="hidden" name="intent" value="schedule-invoice" />
          <input type="hidden" name="orderId" value={order.id} />
          <label className="invoice-auto">
            <span>Auto</span>
            <select
              name="schedule"
              defaultValue={initialSchedule}
              disabled={scheduling}
              onChange={onScheduleChange}
              aria-label="Auto invoice schedule"
              title="Monthly sends on the same calendar date as the order. The 28th–31st use the last day in shorter months."
            >
              <option value="off">Off</option>
              <option value="7">7d</option>
              <option value="10">10d</option>
              <option value="15">15d</option>
              <option value="custom">Custom</option>
              <option value="monthly">Monthly</option>
            </select>
          </label>
          {initialSchedule === "custom" ? (
            <button
              type="button"
              className="invoice-custom-chip"
              onClick={() => {
                if (customOpen) {
                  setCustomOpen(false);
                  return;
                }
                setCustomOpen(true);
                queueMicrotask(() => customInputRef.current?.focus());
              }}
              aria-label="Edit custom invoice days"
              title="Edit custom invoice days"
            >
              {order.invoiceDays || 7}d
            </button>
          ) : null}
          {customOpen ? (
            <div className="invoice-custom" role="group" aria-label="Custom invoice days">
              <input
                ref={customInputRef}
                type="number"
                name="invoiceDays"
                min="1"
                max="365"
                value={customDays}
                onChange={(event) => setCustomDays(event.target.value)}
                onBlur={onCustomBlur}
                onKeyDown={onCustomKeyDown}
                disabled={scheduling}
                aria-label="Custom invoice days"
                title="Days until auto invoice. Saves on Enter or when you leave the field."
              />
              <span className="invoice-custom-suffix">d</span>
            </div>
          ) : null}
        </fetcher.Form>
      </div>
      {dueDate ? <small className="invoice-sub">{dueDate}</small> : null}
      {invoiceError ? <small className="invoice-error">{invoiceError}</small> : null}
      {scheduleError ? <small className="invoice-error">{scheduleError}</small> : null}
    </div>
  );
}

export default function DashboardView({ shop, settings, stats, fetcher, loadedAt }) {
  const [periodId, setPeriodId] = useState("7d");
  const [ordersTab, setOrdersTab] = useState("all");
  const [orderQuery, setOrderQuery] = useState("");
  const [ordersPage, setOrdersPage] = useState(1);
  const periodView = useMemo(
    () => buildPeriodTrend(stats.recent || [], periodId),
    [stats.recent, periodId],
  );
  const trend = periodView.trend || [];
  const period = periodView.period || COLLECTION_PERIODS[0];
  const counts = stats.counts || {};
  const analytics = stats.analytics || {
    totalPartialOrders: 0,
    totalPaid: 0,
    totalCodOutstanding: 0,
    fullyPaid: 0,
    partiallyPaid: 0,
    codCollected: 0,
  };
  const donut =
    stats.statusBreakdown ||
    [
      { key: "partial_paid", label: "Partially Paid", value: counts.partial_paid || 0, color: "#F59E0B" },
      { key: "unpaid_cod", label: "Unpaid COD", value: counts.unpaid_cod || 0, color: "#EF4444" },
      { key: "fully_paid", label: "Fully Paid", value: counts.fully_paid || 0, color: "#10B981" },
      { key: "refunded", label: "Refunded", value: counts.refunded || 0, color: "#94A3B8" },
    ];
  const totalStatus = donut.reduce((sum, slice) => sum + Number(slice.value || 0), 0);
  const symbol = settings.currencySymbol || "₹";
  const recent = stats.recent || [];
  const searchedOrders = useMemo(
    () => recent.filter((order) => matchesOrderSearch(order, orderQuery)),
    [recent, orderQuery],
  );
  const tabCounts = useMemo(
    () => ({
      all: searchedOrders.length,
      paid: searchedOrders.filter(isPaidOrder).length,
      remaining: searchedOrders.filter(isRemainingOrder).length,
    }),
    [searchedOrders],
  );
  const visibleOrders = useMemo(() => {
    if (ordersTab === "paid") return searchedOrders.filter(isPaidOrder);
    if (ordersTab === "remaining") return searchedOrders.filter(isRemainingOrder);
    return searchedOrders;
  }, [searchedOrders, ordersTab]);
  const visibleStats = useMemo(() => sumVisibleOrderStats(visibleOrders), [visibleOrders]);
  const orderTotalPages = Math.max(1, Math.ceil(visibleOrders.length / ORDERS_PAGE_SIZE));
  const safeOrdersPage = Math.min(ordersPage, orderTotalPages);
  const pagedOrders = useMemo(() => {
    const start = (safeOrdersPage - 1) * ORDERS_PAGE_SIZE;
    return visibleOrders.slice(start, start + ORDERS_PAGE_SIZE);
  }, [visibleOrders, safeOrdersPage]);
  const orderPages = pageWindow(safeOrdersPage, orderTotalPages);
  const showOrderPager = visibleOrders.length > ORDERS_PAGE_SIZE || safeOrdersPage > 1;
  const ruleCounts = stats.ruleCounts || settings?.ruleCounts || null;
  const activeRule = formatShopActiveRule(settings, symbol);
  const scopeLabel = activeRule.scope;
  const orderValue = Number(stats.totals?.fullPrice) || 0;
  const paidOnline = Number(analytics.totalPaid ?? stats.totals?.collected) || 0;
  const collectionRate =
    Number(analytics.collectionRate ?? stats.totals?.collectionRate) ||
    (orderValue > 0 ? Math.round((paidOnline / orderValue) * 100) : 0);

  function orderUrl(order) {
    return shopifyOrderAdminUrl(shop, order);
  }

  return (
    <AppShell
      kicker="PartialPay · COD & deposits"
      title="PartialPay overview"
      subtitle="Customers pay a deposit at checkout. Remaining COD is collected on delivery. Theme embed must stay on."
      active="dashboard"
      loadedAt={loadedAt}
    >
      <div className="kpis">
        <MetricCard
          tone="purple"
          icon={<IconOrders />}
          title="Total Orders"
          value={analytics.totalPartialOrders}
          hint="Partial / unpaid / fully paid"
        />
        <MetricCard
          tone="blue"
          icon={<IconValue />}
          title="Order Value"
          value={stats.formatted?.orderValue || stats.formatted?.fullPrice || formatMoney(0, symbol)}
          hint="Partial / unpaid / fully paid / refunded"
        />
        <MetricCard
          tone="green"
          icon={<IconPaid />}
          title="Paid Online"
          value={stats.formatted?.totalPaid || stats.formatted?.collected || formatMoney(0, symbol)}
          hint="Sum of pay now"
        />
        <MetricCard
          tone="orange"
          icon={<IconCod />}
          title="COD Outstanding"
          value={stats.formatted?.totalCodOutstanding || stats.formatted?.remaining || formatMoney(0, symbol)}
          hint="Due where not fully paid"
        />
        <MetricCard
          tone="mint"
          icon={<IconCollected />}
          title="COD Collected"
          value={stats.formatted?.codCollected || formatMoney(0, symbol)}
          hint={`${analytics.codCollected || 0} fully paid`}
        />
        <MetricCard
          tone="violet"
          icon={<IconRate />}
          title="Collection Rate"
          value={`${collectionRate}%`}
          hint="Paid online vs order value"
        />
      </div>

      <div className="charts">
        <section className="panel chart-panel">
          <div className="panel-toolbar">
            <h2>{period.title}</h2>
            <label className="period-field">
              <span>Date range</span>
              <select
                value={periodId}
                onChange={(event) => setPeriodId(event.target.value)}
                aria-label="Collections date range"
              >
                {COLLECTION_PERIODS.map((option) => (
                  <option key={option.id} value={option.id}>
                    {option.label}
                  </option>
                ))}
              </select>
            </label>
          </div>
          <div className="panel-body chart-body">
            <p className="chart-window">
              {formatMoney(periodView.window?.payNow || 0, symbol)} paid online ·{" "}
              {formatMoney(periodView.window?.payCod || 0, symbol)} remaining COD ·{" "}
              {periodView.window?.orders || 0} orders in this range
            </p>
            <CollectionsAreaChart
              trend={trend}
              period={period}
              symbol={symbol}
              title={period.title}
            />
            <div className="chart-legend">
              <span><span className="dot" style={{ background: PAID_COLOR }} /> Paid online</span>
              <span><span className="dot" style={{ background: COD_COLOR }} /> Remaining COD</span>
            </div>
          </div>
        </section>

        <section className="panel">
          <h2>Payment status</h2>
          <div className="panel-body chart-body">
            <PaymentStatusChart slices={donut} total={totalStatus} />
          </div>
        </section>
      </div>

      {settings ? (
        <section className="panel sku-panel rules-panel">
          <h2>Payment rules</h2>
          <div className="panel-body">
            <div className="shop-rule-callout">
              <span>Selected rule</span>
              <strong>{activeRule.headline}</strong>
              <em>{activeRule.meta}</em>
              <p className="rule-banner-note">{activeRule.detail}</p>
            </div>
            {ruleCounts ? (
              <div className="rules-grid">
                <div className="rule-chip">
                  <span>Fixed</span>
                  <strong>{ruleCounts.fixed || 0}</strong>
                </div>
                <div className="rule-chip">
                  <span>25%</span>
                  <strong>{ruleCounts.percent25 || 0}</strong>
                </div>
                <div className="rule-chip">
                  <span>50%</span>
                  <strong>{ruleCounts.percent50 || 0}</strong>
                </div>
                <div className="rule-chip">
                  <span>Custom</span>
                  <strong>{ruleCounts.custom || 0}</strong>
                </div>
                <div className="rule-chip">
                  <span>Disabled</span>
                  <strong>{ruleCounts.disabled || 0}</strong>
                </div>
              </div>
            ) : (
              <div className="rules-grid">
                <div className="rule-chip">
                  <span>Pay now</span>
                  <strong>{formatPayRule(settings, symbol)}</strong>
                </div>
                <div className="rule-chip">
                  <span>Product scope</span>
                  <strong>{scopeLabel}</strong>
                </div>
                <div className="rule-chip">
                  <span>COD extra</span>
                  <strong>{formatMoney(settings.surcharge, symbol)}</strong>
                </div>
                <div className="rule-chip">
                  <span>Fully / partial / collected</span>
                  <strong>
                    {analytics.fullyPaid} · {analytics.partiallyPaid} · {analytics.codCollected}
                  </strong>
                </div>
              </div>
            )}
            <div className="hero-actions">
              <a className="dash-link" href="/app/products">Change who this rule applies to</a>
              <a className="dash-link" href="/app/settings">Change deposit amount</a>
            </div>
          </div>
        </section>
      ) : null}

      <section className="panel orders" id="orders">
        <h2>Recent orders</h2>
        <div className="panel-body">
          <div className="orders-toolbar">
            <div className="orders-tabs" role="tablist" aria-label="Filter recent orders">
              {[
                { id: "all", label: "All", count: tabCounts.all },
                { id: "paid", label: "Paid", count: tabCounts.paid },
                { id: "remaining", label: "Remaining", count: tabCounts.remaining },
              ].map((tab) => (
                <button
                  key={tab.id}
                  type="button"
                  role="tab"
                  aria-selected={ordersTab === tab.id}
                  className={ordersTab === tab.id ? "orders-tab is-active" : "orders-tab"}
                  onClick={() => {
                    setOrdersTab(tab.id);
                    setOrdersPage(1);
                  }}
                >
                  {tab.label}
                  <span className="orders-tab-count">{tab.count}</span>
                </button>
              ))}
            </div>
            <label className="orders-search">
              <span className="visually-hidden">Search order</span>
              <input
                type="search"
                value={orderQuery}
                onChange={(event) => {
                  setOrderQuery(event.target.value);
                  setOrdersPage(1);
                }}
                placeholder="Search order #1062"
                aria-label="Search order number"
              />
            </label>
          </div>
          <div className="orders-stats" aria-label="Totals for visible orders">
            <article className="orders-stat kpi-blue">
              <small>Orders</small>
              <strong>{visibleStats.orders}</strong>
            </article>
            <article className="orders-stat kpi-purple">
              <small>Order value</small>
              <strong>{formatMoney(visibleStats.fullPrice, symbol)}</strong>
            </article>
            <article className="orders-stat kpi-green">
              <small>Paid online</small>
              <strong>{formatMoney(visibleStats.payNow, symbol)}</strong>
            </article>
            <article className="orders-stat kpi-orange">
              <small>Remaining COD</small>
              <strong>{formatMoney(visibleStats.payCod, symbol)}</strong>
            </article>
            <article className="orders-stat kpi-mint">
              <small>COD collected</small>
              <strong>{formatMoney(visibleStats.collectedCod, symbol)}</strong>
            </article>
          </div>
          {fetcher?.data?.mark?.error ? (
            <div className="empty">{fetcher.data.mark.error}</div>
          ) : null}
          {!recent.length ? (
            <div className="empty">
              No partial payment orders yet. Checkout with Partial Payment after saving the shop
              rule.
            </div>
          ) : !visibleOrders.length ? (
            <div className="empty">
              {orderQuery.trim()
                ? `No orders match ${orderQuery.trim()}.`
                : ordersTab === "paid"
                  ? "No fully paid orders in this list."
                  : ordersTab === "remaining"
                    ? "No orders with remaining COD."
                    : "No orders to show."}
            </div>
          ) : (
            <div className="table-scroll">
              <table className="data-table orders-table">
                <thead>
                  <tr>
                    <th>Order</th>
                    <th className="col-date">Date</th>
                    <th>Customer</th>
                    <th>Total</th>
                    <th>Paid Online</th>
                    <th>COD Due</th>
                    <th>Status</th>
                    <th className="col-action">Action</th>
                    <th className="col-invoice">Invoice</th>
                  </tr>
                </thead>
                <tbody>
                  {pagedOrders.map((order) => {
                    const badge = badgeFor(order);
                    const dueRemaining =
                      order.status !== "fully_paid" &&
                      order.status !== "refunded" &&
                      order.payCod > 0 &&
                      !order.cancelledAt;
                    const canCollect = Boolean(fetcher) && dueRemaining;
                    const actionLabel = order.cancelledAt
                      ? "Cancelled"
                      : order.status === "refunded"
                        ? "Refunded"
                        : "Fully paid";
                    return (
                      <tr key={order.id}>
                        <td>
                          <a className="order-link" href={orderUrl(order)} target="_top">
                            {order.name}
                          </a>
                        </td>
                        <td className="col-date">{formatOrderDate(order.createdAt)}</td>
                        <td>{order.customer || "—"}</td>
                        <td>{formatMoney(order.fullPrice, symbol)}</td>
                        <td>{formatMoney(order.payNow, symbol)}</td>
                        <td>{formatMoney(order.payCod, symbol)}</td>
                        <td>
                          <span className={badge.className}>{badge.label}</span>
                        </td>
                        <td className="col-action">
                          {canCollect ? (
                            <fetcher.Form method="POST">
                              <input type="hidden" name="intent" value="mark-cod" />
                              <input type="hidden" name="orderId" value={order.id} />
                              <button
                                type="submit"
                                className="btn-primary btn-cod"
                                title="Mark remaining COD as collected"
                                disabled={fetcherBusy(fetcher, "mark-cod", order.id)}
                              >
                                Mark collected
                              </button>
                            </fetcher.Form>
                          ) : (
                            <span className="action-paid">{actionLabel}</span>
                          )}
                        </td>
                        <td className="col-invoice">
                          <InvoiceCell
                            key={`${order.id}-${order.invoiceMode}-${order.invoiceDays}-${order.invoiceScheduled}-${order.invoiceSentAt || ""}`}
                            order={order}
                            fetcher={fetcher}
                          />
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
          {visibleOrders.length > 0 && showOrderPager ? (
            <Pagination
              label="Order pages"
              pages={orderPages}
              current={safeOrdersPage}
              total={orderTotalPages}
              canPrev={safeOrdersPage > 1}
              canNext={safeOrdersPage < orderTotalPages}
              summary={`${Math.min((safeOrdersPage - 1) * ORDERS_PAGE_SIZE + 1, visibleOrders.length)}–${Math.min(safeOrdersPage * ORDERS_PAGE_SIZE, visibleOrders.length)} of ${visibleOrders.length}`}
              onPrev={() => setOrdersPage(safeOrdersPage - 1)}
              onNext={() => setOrdersPage(safeOrdersPage + 1)}
              onPage={setOrdersPage}
            />
          ) : null}
        </div>
      </section>
    </AppShell>
  );
}
