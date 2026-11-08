import { type FormEvent, useCallback, useEffect, useState } from "react";
import type { Language } from "../../services/api";
import {
  addGlossaryRule,
  deleteGlossaryRule,
  fetchGlossary,
  previewGlossary,
  updateGlossaryRule,
  type GlossaryRule,
} from "../api";

interface Props {
  token: string;
  languages: Language[];
  onAuthError: (err: unknown) => boolean;
}

const EMPTY = { tgt_lang: "pai_Latn", src_lang: "", find: "", replace: "", note: "" };

export function GlossaryTab({ token, languages, onAuthError }: Props) {
  const [rules, setRules] = useState<GlossaryRule[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [form, setForm] = useState(EMPTY);
  const [saving, setSaving] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [previewText, setPreviewText] = useState("");
  const [previewOut, setPreviewOut] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      setRules((await fetchGlossary(token)).items);
    } catch (err) {
      if (!onAuthError(err)) setError(err instanceof Error ? err.message : "Could not load glossary.");
    } finally {
      setLoading(false);
    }
  }, [token, onAuthError]);

  useEffect(() => {
    void load();
  }, [load]);

  const label = (code: string | null) =>
    code ? (languages.find((l) => l.code === code)?.label ?? code) : "Any";

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (!form.find.trim()) return;
    setSaving(true);
    setError(null);
    try {
      const created = await addGlossaryRule(token, {
        tgt_lang: form.tgt_lang,
        src_lang: form.src_lang || null,
        find: form.find.trim(),
        replace: form.replace,
        enabled: true,
        note: form.note.trim() || null,
      });
      setRules((prev) => [...prev, created]);
      setForm({ ...EMPTY, tgt_lang: form.tgt_lang });
    } catch (err) {
      if (!onAuthError(err)) setError(err instanceof Error ? err.message : "Could not add rule.");
    } finally {
      setSaving(false);
    }
  };

  const toggle = async (rule: GlossaryRule) => {
    setBusyId(rule.id);
    try {
      const updated = await updateGlossaryRule(token, rule.id, { enabled: !rule.enabled });
      setRules((prev) => prev.map((r) => (r.id === rule.id ? updated : r)));
    } catch (err) {
      if (!onAuthError(err)) setError(err instanceof Error ? err.message : "Update failed.");
    } finally {
      setBusyId(null);
    }
  };

  const remove = async (rule: GlossaryRule) => {
    if (!window.confirm(`Delete rule "${rule.find}" → "${rule.replace}"?`)) return;
    setBusyId(rule.id);
    try {
      await deleteGlossaryRule(token, rule.id);
      setRules((prev) => prev.filter((r) => r.id !== rule.id));
    } catch (err) {
      if (!onAuthError(err)) setError(err instanceof Error ? err.message : "Delete failed.");
    } finally {
      setBusyId(null);
    }
  };

  const runPreview = async () => {
    try {
      const result = await previewGlossary(token, previewText, form.src_lang || "eng_Latn", form.tgt_lang);
      setPreviewOut(result.text);
    } catch (err) {
      if (!onAuthError(err)) setError(err instanceof Error ? err.message : "Preview failed.");
    }
  };

  const inputClass =
    "rounded-xl border border-stone-300/60 bg-white px-3 py-1.5 text-sm text-zomi-ink outline-none transition focus:border-zomi-red/40";

  return (
    <div>
      <div className="border-b border-stone-300/40 px-4 py-3 text-xs text-zomi-muted">
        Glossary rules are applied to the model's output right before it is shown:
        whole-word, case-insensitive find and replace, longest match first. Use them for
        names, church terms and fixed phrases the model keeps getting wrong. Changes take
        effect within a minute, no redeploy.
      </div>

      <form onSubmit={submit} className="grid gap-2 border-b border-stone-300/40 px-4 py-3 md:grid-cols-[1fr_1fr_1.5fr_1.5fr_1.5fr_auto]">
        <label className="text-[10px] font-semibold uppercase tracking-wider text-zomi-muted">
          Output language
          <select
            value={form.tgt_lang}
            onChange={(e) => setForm({ ...form, tgt_lang: e.target.value })}
            className={`mt-1 block w-full ${inputClass}`}
          >
            {languages.map((l) => (
              <option key={l.code} value={l.code}>{l.label}</option>
            ))}
          </select>
        </label>
        <label className="text-[10px] font-semibold uppercase tracking-wider text-zomi-muted">
          Only from
          <select
            value={form.src_lang}
            onChange={(e) => setForm({ ...form, src_lang: e.target.value })}
            className={`mt-1 block w-full ${inputClass}`}
          >
            <option value="">Any source</option>
            {languages.map((l) => (
              <option key={l.code} value={l.code}>{l.label}</option>
            ))}
          </select>
        </label>
        <label className="text-[10px] font-semibold uppercase tracking-wider text-zomi-muted">
          Find in output
          <input
            value={form.find}
            onChange={(e) => setForm({ ...form, find: e.target.value })}
            required
            placeholder="e.g. Lord"
            className={`mt-1 block w-full ${inputClass}`}
          />
        </label>
        <label className="text-[10px] font-semibold uppercase tracking-wider text-zomi-muted">
          Replace with
          <input
            value={form.replace}
            onChange={(e) => setForm({ ...form, replace: e.target.value })}
            placeholder="e.g. Topa"
            className={`mt-1 block w-full ${inputClass}`}
          />
        </label>
        <label className="text-[10px] font-semibold uppercase tracking-wider text-zomi-muted">
          Note
          <input
            value={form.note}
            onChange={(e) => setForm({ ...form, note: e.target.value })}
            placeholder="optional"
            className={`mt-1 block w-full ${inputClass}`}
          />
        </label>
        <div className="flex items-end">
          <button
            type="submit"
            disabled={saving || !form.find.trim()}
            className="rounded-full bg-zomi-red px-4 py-2 text-xs font-semibold text-white transition hover:bg-zomi-red-dark disabled:bg-stone-300"
          >
            {saving ? "Adding…" : "Add rule"}
          </button>
        </div>
      </form>

      {error && (
        <div role="alert" className="border-b border-zomi-red/25 bg-zomi-red/5 px-4 py-3 text-sm text-zomi-red-dark">
          {error}
        </div>
      )}

      {loading && rules.length === 0 ? (
        <p className="px-4 py-8 text-center text-sm text-zomi-muted">Loading…</p>
      ) : rules.length === 0 ? (
        <p className="px-4 py-8 text-center text-sm text-zomi-muted">No rules yet.</p>
      ) : (
        <table className="w-full text-sm">
          <thead className="text-left text-[10px] font-semibold uppercase tracking-wider text-zomi-muted">
            <tr className="border-b border-stone-300/40">
              <th className="px-4 py-2">Output</th>
              <th className="px-2 py-2">From</th>
              <th className="px-2 py-2">Find</th>
              <th className="px-2 py-2">Replace</th>
              <th className="px-2 py-2">Note</th>
              <th className="px-2 py-2">On</th>
              <th className="px-4 py-2" />
            </tr>
          </thead>
          <tbody>
            {rules.map((rule) => (
              <tr key={rule.id} className={`border-b border-stone-300/30 ${rule.enabled ? "" : "opacity-50"}`}>
                <td className="px-4 py-2 text-zomi-red-dark">{label(rule.tgt_lang)}</td>
                <td className="px-2 py-2 text-zomi-muted">{label(rule.src_lang)}</td>
                <td className="px-2 py-2 font-medium text-zomi-ink">{rule.find}</td>
                <td className="px-2 py-2 font-serif text-zomi-ink">{rule.replace}</td>
                <td className="px-2 py-2 text-xs text-zomi-muted">{rule.note}</td>
                <td className="px-2 py-2">
                  <input
                    type="checkbox"
                    checked={rule.enabled}
                    disabled={busyId === rule.id}
                    onChange={() => toggle(rule)}
                    className="accent-zomi-red"
                  />
                </td>
                <td className="px-4 py-2 text-right">
                  <button
                    type="button"
                    disabled={busyId === rule.id}
                    onClick={() => remove(rule)}
                    className="text-xs text-zomi-muted hover:text-zomi-red hover:underline"
                  >
                    Delete
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      <div className="border-t border-stone-300/40 px-4 py-3">
        <p className="mb-1 text-[10px] font-semibold uppercase tracking-wider text-zomi-muted">
          Try the rules on sample output ({label(form.tgt_lang)})
        </p>
        <div className="flex flex-wrap gap-2">
          <input
            value={previewText}
            onChange={(e) => setPreviewText(e.target.value)}
            placeholder="Paste model output here…"
            className={`min-w-[240px] flex-1 ${inputClass}`}
          />
          <button
            type="button"
            onClick={runPreview}
            disabled={!previewText.trim()}
            className="rounded-full border border-stone-300/60 bg-zomi-cream px-4 py-1.5 text-xs text-zomi-ink transition hover:bg-white disabled:opacity-60"
          >
            Preview
          </button>
        </div>
        {previewOut != null && (
          <p className="mt-2 whitespace-pre-wrap rounded-xl bg-emerald-50/60 px-3 py-2 font-serif text-sm text-zomi-ink">
            {previewOut}
          </p>
        )}
      </div>
    </div>
  );
}
