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
    <select
      id={id}
      value={value}
      onChange={(e) => onChange(e.target.value as LangCode)}
      disabled={disabled}
      className="rounded-lg border border-stone-300/60 bg-zomi-cream px-3 py-1.5 text-sm font-medium text-zomi-ink outline-none focus:border-zomi-red/50 disabled:opacity-60"
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
  );
}
