import { useEffect, useState } from "react";
import { useRevalidator } from "react-router";
import AppMark from "./AppMark";

const KOLKATA = "Asia/Kolkata";

function formatIst(date) {
  return date.toLocaleString("en-IN", {
    timeZone: KOLKATA,
    weekday: "short",
    day: "2-digit",
    month: "short",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: true,
  });
}

const clockListeners = new Set();
let clockTimerId = 0;

function subscribeLiveClock(listener) {
  clockListeners.add(listener);
  if (!clockTimerId) {
    clockTimerId = window.setInterval(() => {
      const now = new Date();
      clockListeners.forEach((fn) => fn(now));
    }, 1000);
  }
  return () => {
    clockListeners.delete(listener);
  };
}

function LiveClock() {
  const [now, setNow] = useState(() => new Date());

  useEffect(() => {
    setNow(new Date());
    return subscribeLiveClock(setNow);
  }, []);

  return (
    <time dateTime={now.toISOString()} className="live-time" suppressHydrationWarning>
      {formatIst(now)} IST
    </time>
  );
}

const NAV = [
  { href: "/app", id: "dashboard", label: "Dashboard" },
  { href: "/app/products", id: "products", label: "Products" },
  { href: "/app/settings", id: "settings", label: "Settings" },
];

export default function AppShell({
  title,
  subtitle,
  kicker = "PartialPay",
  active = "dashboard",
  loadedAt,
  children,
}) {
  const revalidator = useRevalidator();
  const refreshing = revalidator.state !== "idle";

  return (
    <div className="pulse-dash">
      <header className="page-head">
        <div className="page-head-copy">
          <div className="kicker">{kicker}</div>
          <div className="page-head-title">
            <AppMark />
            <h1>{title}</h1>
          </div>
          {subtitle ? <p>{subtitle}</p> : null}
        </div>
        <div className="page-head-meta">
          <div className="live-clock" title={loadedAt ? `Data loaded ${loadedAt}` : undefined}>
            <span className="live-dot" aria-hidden="true" />
            <LiveClock />
          </div>
          <button
            type="button"
            className="refresh-btn"
            onClick={() => revalidator.revalidate()}
            disabled={refreshing}
          >
            {refreshing ? "Refreshing…" : "Refresh"}
          </button>
        </div>
      </header>

      <nav className="app-tabs" aria-label="App pages">
        {NAV.map((item) => (
          <a
            key={item.id}
            href={item.href}
            className={item.id === active ? "app-tab is-active" : "app-tab"}
          >
            {item.label}
          </a>
        ))}
      </nav>

      <div className="dash-body">{children}</div>
    </div>
  );
}
