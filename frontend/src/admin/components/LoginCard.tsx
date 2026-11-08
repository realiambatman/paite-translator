import { type FormEvent, useState } from "react";
import type { AdminStatus } from "../api";

interface Props {
  status: AdminStatus | null;
  error: string | null;
  busy: boolean;
  onSubmit: (password: string) => void;
}

export function LoginCard({ status, error, busy, onSubmit }: Props) {
  const [password, setPassword] = useState("");

  const handleSubmit = (event: FormEvent) => {
    event.preventDefault();
    if (!password.trim() || busy) return;
    onSubmit(password.trim());
  };

  const missing: string[] = [];
  if (status && !status.auth_configured) missing.push("ADMIN_PASSWORD");
  if (status && !status.firestore_configured) {
    missing.push("FIREBASE_SERVICE_ACCOUNT_JSON (or FIREBASE_SERVICE_ACCOUNT_FILE)");
  }

  return (
    <div className="mx-auto mt-16 w-full max-w-md">
      <div className="overflow-hidden rounded-2xl border border-stone-300/50 bg-zomi-paper/80 shadow-[0_8px_30px_rgb(28_25_23/0.06)] backdrop-blur-sm">
        <div className="zomi-stripe h-1" />
        <form onSubmit={handleSubmit} className="space-y-4 px-6 py-6">
          <div>
            <p className="text-[11px] font-semibold uppercase tracking-[0.2em] text-zomi-gold">
              Zomi Translator
            </p>
            <h1 className="font-serif text-2xl font-bold tracking-tight text-zomi-ink">
              Admin sign in
            </h1>
            <p className="mt-1 text-sm text-zomi-muted">
              Enter the admin password set on the server to browse logged
              translations and uploaded images.
            </p>
          </div>

          {missing.length > 0 && (
            <div className="rounded-xl border border-amber-200/60 bg-amber-50/80 px-3 py-2 text-xs text-amber-900">
              <p className="font-medium">Server setup incomplete.</p>
              <p className="mt-1">Set on the server, then redeploy:</p>
              <ul className="mt-1 list-disc pl-4">
                {missing.map((item) => (
                  <li key={item}>
                    <code className="rounded bg-white/80 px-1">{item}</code>
                  </li>
                ))}
              </ul>
            </div>
          )}

          <label className="block">
            <span className="mb-1 block text-xs font-semibold uppercase tracking-wider text-zomi-muted">
              Password
            </span>
            <input
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              autoFocus
              autoComplete="current-password"
              disabled={busy}
              className="w-full rounded-xl border border-stone-300/60 bg-white px-3 py-2 text-sm text-zomi-ink outline-none transition focus:border-zomi-red/40 focus:ring-2 focus:ring-zomi-red/10 disabled:opacity-60"
            />
          </label>

          {error && (
            <p role="alert" className="text-sm text-zomi-red-dark">
              {error}
            </p>
          )}

          <button
            type="submit"
            disabled={busy || !password.trim()}
            className="inline-flex w-full items-center justify-center gap-2 rounded-full bg-zomi-red px-5 py-2 text-sm font-semibold text-white transition hover:bg-zomi-red-dark disabled:cursor-not-allowed disabled:bg-stone-300"
          >
            {busy && (
              <span
                className="stream-spinner inline-block h-3.5 w-3.5 rounded-full border-2 border-white/30 border-t-white"
                aria-hidden
              />
            )}
            {busy ? "Checking…" : "Open admin panel"}
          </button>

          <p className="text-center text-xs text-zomi-muted">
            <a href="/" className="text-zomi-red hover:underline">
              ← Back to translator
            </a>
          </p>
        </form>
      </div>
    </div>
  );
}
