import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "./index.css";
import { App } from "./App";
import { t } from "./i18n";

const root = createRoot(document.getElementById("root")!);

async function start() {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 3000);
  const key = await fetch("/auth/config", { signal: controller.signal })
    .then(async (res) => {
      if (!res.ok) return null;
      const config = await res.json();
      return typeof config.clerkPublishableKey === "string" ? config.clerkPublishableKey : null;
    }).catch(() => null).finally(() => clearTimeout(timer));
  if (!key) {
    root.render(<StrictMode><App /></StrictMode>);
    return;
  }
  try {
    const { OperatorDashboard } = await import("./OperatorDashboard");
    root.render(<StrictMode><OperatorDashboard publishableKey={key} /></StrictMode>);
  } catch {
    root.render(<main className="p-6 text-ink" role="alert">{t("auth.loadFailed")}</main>);
  }
}

void start();
