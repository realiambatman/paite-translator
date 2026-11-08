export function parseDate(value: string | null | undefined): Date | null {
  if (!value) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

function pad(n: number): string {
  return n < 10 ? `0${n}` : String(n);
}

/** Local-day bucket key, e.g. "2026-11-08". */
export function dayKey(date: Date | null): string {
  if (!date) return "undated";
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

function startOfDay(date: Date): Date {
  const copy = new Date(date);
  copy.setHours(0, 0, 0, 0);
  return copy;
}

const DAY_MS = 24 * 60 * 60 * 1000;

export function relativeDayLabel(date: Date, now = new Date()): string | null {
  const diffDays = Math.round(
    (startOfDay(now).getTime() - startOfDay(date).getTime()) / DAY_MS,
  );
  if (diffDays === 0) return "Today";
  if (diffDays === 1) return "Yesterday";
  if (diffDays > 1 && diffDays < 7) return `${diffDays} days ago`;
  return null;
}

const dayFormatter = new Intl.DateTimeFormat(undefined, {
  weekday: "long",
  day: "numeric",
  month: "long",
  year: "numeric",
});

const timeFormatter = new Intl.DateTimeFormat(undefined, {
  hour: "2-digit",
  minute: "2-digit",
});

const fullFormatter = new Intl.DateTimeFormat(undefined, {
  day: "numeric",
  month: "short",
  year: "numeric",
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
  timeZoneName: "short",
});

export function formatDayHeading(date: Date | null): string {
  if (!date) return "No date recorded";
  const relative = relativeDayLabel(date);
  const absolute = dayFormatter.format(date);
  return relative ? `${relative} · ${absolute}` : absolute;
}

export function formatTime(date: Date | null): string {
  return date ? timeFormatter.format(date) : "—";
}

export function formatFull(date: Date | null): string {
  return date ? fullFormatter.format(date) : "No date recorded";
}

export function timeAgo(date: Date | null, now = new Date()): string {
  if (!date) return "";
  const seconds = Math.max(0, Math.floor((now.getTime() - date.getTime()) / 1000));
  if (seconds < 60) return "just now";
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} hr ago`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days} day${days === 1 ? "" : "s"} ago`;
  const months = Math.floor(days / 30);
  if (months < 12) return `${months} month${months === 1 ? "" : "s"} ago`;
  const years = Math.floor(days / 365);
  return `${years} year${years === 1 ? "" : "s"} ago`;
}

export function formatNumber(value: number | null | undefined): string {
  return value == null ? "—" : value.toLocaleString();
}
