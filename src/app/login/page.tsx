"use client";

import { Suspense, useState } from "react";
import { useSearchParams } from "next/navigation";

export default function LoginPage() {
  return (
    <Suspense>
      <LoginForm />
    </Suspense>
  );
}

function safeNext(next: string | null): string {
  if (!next || !next.startsWith("/") || next.startsWith("//") || next.startsWith("/\\")) {
    return "/";
  }
  return next;
}

const CONFIG_ERROR =
  "Inloggen is nog niet ingesteld: zet APP_PASSWORD in de Vercel-projectinstellingen en deploy opnieuw.";

function LoginForm() {
  const params = useSearchParams();
  const next = safeNext(params.get("next"));
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(
    params.get("fout") === "config"
      ? CONFIG_ERROR
      : params.get("fout")
        ? "Onjuist wachtwoord"
        : "",
  );

  async function onSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (busy) return;
    setBusy(true);
    setError("");
    try {
      const res = await fetch("/api/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ password, next }),
      });
      if (res.ok) {
        const data = await res.json().catch(() => ({}));
        window.location.assign(safeNext(data?.next ?? next));
        return;
      }
      setError(
        res.status === 401
          ? "Onjuist wachtwoord"
          : res.status === 503
            ? CONFIG_ERROR
            : "Er ging iets mis, probeer opnieuw",
      );
    } catch {
      setError("Geen verbinding, probeer opnieuw");
    }
    setBusy(false);
  }

  return (
    <main className="flex min-h-screen items-center justify-center px-4">
      <div className="w-full max-w-sm rounded-2xl border border-border bg-surface p-6 shadow-xl">
        <div className="mb-6 flex items-center gap-2.5">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src="/logo.png" alt="SocialFlow" className="h-10 w-10 rounded-xl" />
          <div>
            <h1 className="text-lg font-bold leading-none">SocialFlow</h1>
            <p className="mt-1 text-xs text-muted">één post · alle kanalen</p>
          </div>
        </div>

        <form method="post" action="/api/login" onSubmit={onSubmit} className="flex flex-col gap-3">
          <input type="hidden" name="next" value={next} />
          <label htmlFor="password" className="text-sm font-medium">
            Wachtwoord
          </label>
          <input
            id="password"
            name="password"
            type="password"
            autoComplete="current-password"
            autoFocus
            required
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            className="rounded-lg border border-border bg-surface-2 px-3 py-2.5 text-sm outline-none transition focus:border-accent"
          />
          {error && (
            <p role="alert" className="text-sm text-red-600">
              {error}
            </p>
          )}
          <button
            type="submit"
            disabled={busy}
            className="mt-1 rounded-lg bg-brand px-4 py-2.5 text-sm font-semibold text-white transition hover:bg-brand/90 disabled:opacity-60"
          >
            {busy ? "Bezig…" : "Inloggen"}
          </button>
        </form>
      </div>
    </main>
  );
}
