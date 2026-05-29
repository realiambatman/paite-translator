import type { Language } from "./services/api";

export const FALLBACK_LANGUAGES: Language[] = [
  { code: "eng_Latn", label: "English", provider: "hf", common: true },
  { code: "pai_Latn", label: "Paite", provider: "hf", common: true },
  { code: "lus_Latn", label: "Mizo", provider: "google", common: true },
  { code: "mni_Beng", label: "Meitei", provider: "google", common: true },
  { code: "mya_Mymr", label: "Burmese", provider: "google", common: true },
  { code: "hin_Deva", label: "Hindi", provider: "google", common: true },
  { code: "asm_Beng", label: "Assamese", provider: "google", common: false },
  { code: "ben_Beng", label: "Bengali", provider: "google", common: false },
  { code: "brx_Deva", label: "Bodo", provider: "google", common: false },
  { code: "zho_Hans", label: "Chinese", provider: "google", common: false },
  { code: "fra_Latn", label: "French", provider: "google", common: false },
  { code: "ind_Latn", label: "Indonesian", provider: "google", common: false },
  { code: "kha_Latn", label: "Khasi", provider: "google", common: false },
  { code: "trp_Latn", label: "Kokborok", provider: "google", common: false },
  { code: "rus_Cyrl", label: "Russian", provider: "google", common: false },
  { code: "spa_Latn", label: "Spanish", provider: "google", common: false },
];

export function groupLanguages(languages: Language[]) {
  const common = languages.filter((lang) => lang.common);
  const more = languages
    .filter((lang) => !lang.common)
    .sort((a, b) => a.label.localeCompare(b.label));
  return { common, more };
}
