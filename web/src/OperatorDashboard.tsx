import { ClerkProvider, OrganizationSwitcher, SignIn, UserButton, useAuth } from "@clerk/clerk-react";
import { useEffect, useState } from "react";
import { App } from "./App";
import { OperatorToken } from "./lib";
import { t } from "./i18n";

const appearance = {
  variables: {
    colorPrimary: "var(--color-docker)",
    colorBackground: "var(--color-paper)",
    colorText: "var(--color-ink)",
    colorTextSecondary: "var(--color-slate)",
    colorInputBackground: "var(--color-sea)",
    colorInputText: "var(--color-ink)",
    fontFamily: "var(--font-sans)",
  },
};

export function OperatorDashboard({ publishableKey }: { publishableKey: string }) {
  return <ClerkProvider publishableKey={publishableKey} appearance={appearance}><Gate /></ClerkProvider>;
}

function Gate() {
  const { isLoaded, isSignedIn, userId, orgId, sessionId, getToken } = useAuth();
  const identity = isSignedIn ? JSON.stringify([userId, orgId, sessionId]) : null;
  const [access, setAccess] = useState<{ identity: string; ok: boolean }>();
  useEffect(() => {
    if (!identity) return;
    const controller = new AbortController();
    void (async () => {
      try {
        const token = await getToken();
        const result = await fetch("/internal/session", {
          signal: controller.signal,
          headers: token ? { authorization: `Bearer ${token}` } : undefined,
        });
        if (!controller.signal.aborted) setAccess({ identity, ok: result.ok });
      } catch {
        if (!controller.signal.aborted) setAccess({ identity, ok: false });
      }
    })();
    return () => controller.abort();
  }, [getToken, identity]);

  if (identity && access?.identity === identity && access.ok) {
    return <OperatorToken.Provider value={getToken}><App operator={<UserButton />} /></OperatorToken.Provider>;
  }
  return (
    <main className="flex min-h-dvh flex-col items-center justify-center gap-5 bg-sea px-4 py-8 text-ink">
      <div className="text-center">
        <h1 className="font-display text-3xl font-semibold">Watchtower</h1>
        <p className="mt-2 text-slate">{!isLoaded || (identity && access?.identity !== identity)
          ? t("auth.checking") : identity ? t("auth.denied") : t("auth.signIn")}</p>
      </div>
      {isLoaded && !isSignedIn && <SignIn routing="hash" fallbackRedirectUrl="/" />}
      {identity && access?.identity === identity && !access.ok && (
        <div className="flex items-center gap-3"><OrganizationSwitcher /><UserButton /></div>
      )}
    </main>
  );
}