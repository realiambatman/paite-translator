import type { LangCode, Language } from "../services/api";
import { groupLanguages } from "../languages";

interface LanguageSelectProps {
  value: LangCode;
  onChange: (code: LangCode) => void;
  languages: Language[];
  disabled?: boolean;
  id?: string;
}

export function LanguageSelect({
  value,
  onChange,
  languages,
  disabled,
  id,
}: LanguageSelectProps) {
  const { common, more } = groupLanguages(languages);

  return (
    <span className="relative inline-flex min-w-0 flex-1 items-center">
      <select
        id={id}
        value={value}
        onChange={(e) => onChange(e.target.value as LangCode)}
        disabled={disabled}
        className="w-full cursor-pointer appearance-none rounded-xl border border-transparent bg-transparent py-2 pl-3 pr-8 font-serif text-lg font-semibold text-zomi-ink outline-none transition hover:bg-white/70 focus-visible:border-zomi-red/40 focus-visible:ring-2 focus-visible:ring-zomi-red/15 disabled:cursor-default disabled:opacity-60"
      >
      <optgroup label="Common">
        {common.map((lang) => (
          <option key={lang.code} value={lang.code}>
            {lang.label}
          </option>
        ))}
      </optgroup>
      {more.length > 0 && (
        <optgroup label="More languages (A–Z)">
          {more.map((lang) => (
            <option key={lang.code} value={lang.code}>
              {lang.label}
            </option>
          ))}
        </optgroup>
      )}
      </select>
      <svg
        aria-hidden
        viewBox="0 0 20 20"
        className="pointer-events-none absolute right-2.5 h-4 w-4 text-zomi-muted"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.8"
      >
        <path d="M6 8l4 4 4-4" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
    </span>
  );
}
