import {
  doc,
  getDoc,
  runTransaction,
  serverTimestamp,
} from "firebase/firestore";
import { getFirebaseDb, isFirebaseConfigured } from "./firebase";

const COLLECTION =
  import.meta.env.VITE_FIREBASE_GOOGLE_QUOTA_COLLECTION ??
  "google_translate_quota";

export interface StoredGoogleQuota {
  chars_used: number;
  date: string;
}

function todayUtc(): string {
  return new Date().toISOString().slice(0, 10);
}

function quotaDocRef() {
  const db = getFirebaseDb();
  if (!db) return null;
  return doc(db, COLLECTION, todayUtc());
}

export async function fetchGoogleQuota(): Promise<StoredGoogleQuota | null> {
  const ref = quotaDocRef();
  if (!ref) return null;

  try {
    const snap = await getDoc(ref);
    if (!snap.exists()) {
      return { chars_used: 0, date: todayUtc() };
    }
    const data = snap.data();
    return {
      chars_used: Number(data.chars_used ?? 0),
      date: String(data.date ?? todayUtc()),
    };
  } catch (err) {
    console.warn("Failed to read Google quota from Firestore:", err);
    return null;
  }
}

export async function incrementGoogleQuota(chars: number): Promise<void> {
  if (chars <= 0) return;

  const ref = quotaDocRef();
  if (!ref) return;

  const day = todayUtc();

  try {
    await runTransaction(getFirebaseDb()!, async (transaction) => {
      const snap = await transaction.get(ref);
      const current = snap.exists() ? Number(snap.data()?.chars_used ?? 0) : 0;
      transaction.set(
        ref,
        {
          date: day,
          chars_used: current + chars,
          updated_at: serverTimestamp(),
        },
        { merge: true },
      );
    });
  } catch (err) {
    console.warn("Failed to update Google quota in Firestore:", err);
  }
}

export function isGoogleQuotaPersistenceEnabled(): boolean {
  return isFirebaseConfigured();
}
