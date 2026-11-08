import { addDoc, collection, serverTimestamp } from "firebase/firestore";
import type { LangCode } from "./api";
import { getFirebaseDb } from "./firebase";

const COLLECTION =
  import.meta.env.VITE_FIREBASE_TRANSLATIONS_COLLECTION ?? "translations";

export async function saveTranslationLog(input: {
  srcLang: LangCode;
  tgtLang: LangCode;
  srcText: string;
  tgtText: string;
  route?: string | null;
  pivotEnglish?: string | null;
  storageUrl?: string | null;
  source?: string | null;
  filename?: string | null;
  alternatives?: string[] | null;
}): Promise<string | null> {
  const db = getFirebaseDb();
  if (!db) return null;

  try {
    const ref = await addDoc(collection(db, COLLECTION), {
      src_lang: input.srcLang,
      tgt_lang: input.tgtLang,
      src_text: input.srcText,
      tgt_text: input.tgtText,
      route: input.route ?? null,
      pivot_english: input.pivotEnglish ?? null,
      storage_url: input.storageUrl ?? null,
      source: input.source ?? null,
      filename: input.filename ?? null,
      alternatives: (input.alternatives ?? []).slice(0, 5),
      created_at: serverTimestamp(),
    });
    return ref.id;
  } catch (err) {
    console.warn("Failed to save translation to Firestore:", err);
    return null;
  }
}
