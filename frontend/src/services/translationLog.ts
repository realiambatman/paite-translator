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
}): Promise<void> {
  const db = getFirebaseDb();
  if (!db) return;

  try {
    await addDoc(collection(db, COLLECTION), {
      src_lang: input.srcLang,
      tgt_lang: input.tgtLang,
      src_text: input.srcText,
      tgt_text: input.tgtText,
      route: input.route ?? null,
      pivot_english: input.pivotEnglish ?? null,
      created_at: serverTimestamp(),
    });
  } catch (err) {
    console.warn("Failed to save translation to Firestore:", err);
  }
}
