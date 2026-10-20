"use client";

import { useEffect, useState } from "react";

/** Klein 'Uitloggen'-linkje; alleen zichtbaar als de wachtwoordpoort aan staat. */
export default function LogoutLink({ className = "" }: { className?: string }) {
  const [show, setShow] = useState(false);

  useEffect(() => {
    let cancelled = false;
    fetch("/api/session", { cache: "no-store" })
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => {
        if (!cancelled && d?.authEnabled && d?.authed) setShow(true);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, []);

  if (!show) return null;
  return (
    <a
      href="/api/logout"
      className={`text-xs text-muted underline-offset-2 transition hover:text-foreground hover:underline ${className}`}
    >
      Uitloggen
    </a>
  );
}
