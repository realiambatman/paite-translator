import { addDoc, collection, serverTimestamp } from "firebase/firestore";
import type { LangCode } from "./api";
import { getFirebaseDb } from "./firebase";

const COLLECTION =
  import.meta.env.VITE_FIREBASE_CORRECTIONS_COLLECTION ?? "corrections";

export type Rating = "up" | "down";

export interface FeedbackInput {
  translationId?: string | null;
  srcLang: LangCode;
  tgtLang: LangCode;
  srcText: string;
  modelText: string;
  /** User's improved translation. Omit for a plain thumbs rating. */
  correctedText?: string | null;
  rating?: Rating | null;
  comment?: string | null;
  route?: string | null;
  pivotEnglish?: string | null;
}

/**
 * Saves a thumbs rating or a suggested correction. These land in the admin
 * review queue as "pending" and never change the live translation.
 */
export async function saveFeedback(input: FeedbackInput): Promise<boolean> {
  const db = getFirebaseDb();
  if (!db) return false;

  const corrected = input.correctedText?.trim() ?? "";
  try {
    await addDoc(collection(db, COLLECTION), {
      kind: corrected ? "correction" : "rating",
      status: "pending",
      origin: "user",
      translation_id: input.translationId ?? null,
      src_lang: input.srcLang,
      tgt_lang: input.tgtLang,
      src_text: input.srcText.slice(0, 1000),
      model_text: input.modelText.slice(0, 1500),
      corrected_text: corrected ? corrected.slice(0, 1500) : null,
      rating: input.rating ?? null,
      comment: input.comment?.trim().slice(0, 500) || null,
      route: input.route ?? null,
      pivot_english: input.pivotEnglish ?? null,
      created_at: serverTimestamp(),
    });
    return true;
  } catch (err) {
    console.warn("Failed to save feedback:", err);
    return false;
  }
}
