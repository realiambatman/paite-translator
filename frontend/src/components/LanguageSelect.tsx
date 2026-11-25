import type { LangCode, Language } from "../services/api";
import { groupLanguages } from "../languages";
import { LanguagePicker } from "./LanguagePicker";

interface LanguageSelectProps {
  value: LangCode;
  onChange: (code: LangCode) => void;
  languages: Language[];
  disabled?: boolean;
  ariaLabel: string;
  align?: "left" | "right";
}

/** The language choice of the Paite tab: the common languages first, the rest by name. */
export function LanguageSelect({ value, onChange, languages, disabled, ariaLabel, align }: LanguageSelectProps) {
  const { common, more } = groupLanguages(languages);
  const options = [
    ...common.map((l) => ({ code: l.code, label: l.label, group: "Common" })),
    ...more.map((l) => ({ code: l.code, label: l.label, group: "More languages" })),
  ];
  return (
    <LanguagePicker
      value={value}
      onChange={(code) => onChange(code as LangCode)}
      options={options}
      disabled={disabled}
      ariaLabel={ariaLabel}
      align={align}
      className="flex-1"
    />
  );
}
