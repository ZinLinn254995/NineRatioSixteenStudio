import type { Timestamp } from "firebase/firestore";
import type { UiLanguage } from "../firebase";

const DATE_ONLY_REGEX = /^(\d{4})-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/;

/**
 * Validates a strict date-only string ("YYYY-MM-DD") including real Gregorian
 * calendar day validity (e.g. rejects "2026-02-30" or "2025-02-29").
 */
export function isValidDateOnly(value: string): boolean {
  const trimmed = value.trim();
  const match = DATE_ONLY_REGEX.exec(trimmed);
  if (!match) return false;

  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);

  // Construct at UTC noon to verify calendar rollover without DST/timezone drift
  const check = new Date(Date.UTC(year, month - 1, day, 12, 0, 0));
  return (
    check.getUTCFullYear() === year &&
    check.getUTCMonth() === month - 1 &&
    check.getUTCDate() === day
  );
}

/**
 * Returns the device's local calendar date as "YYYY-MM-DD".
 * Avoids `toISOString().slice(0, 10)` which shifts backward by 1 day in
 * Thailand (Asia/Bangkok, UTC+7) between 00:00 and 06:59 local time.
 */
export function getLocalTodayDateOnly(now: Date = new Date()): string {
  const year = now.getFullYear();
  const month = String(now.getMonth() + 1).padStart(2, "0");
  const day = String(now.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

/**
 * Timezone-immune lexicographical comparison of validated "YYYY-MM-DD" strings.
 */
export function compareDateOnly(a: string, b: string): number {
  if (a === b) return 0;
  return a < b ? -1 : 1;
}

/**
 * Checks that optional startDate/endDate are valid YYYY-MM-DD strings and that
 * endDate is not earlier than startDate.
 */
export function isDateRangeValid(
  startDate?: string,
  endDate?: string
): { valid: true } | { valid: false; errorKey: "invalidStart" | "invalidEnd" | "endBeforeStart" } {
  const start = (startDate || "").trim();
  const end = (endDate || "").trim();

  if (start && !isValidDateOnly(start)) {
    return { valid: false, errorKey: "invalidStart" };
  }
  if (end && !isValidDateOnly(end)) {
    return { valid: false, errorKey: "invalidEnd" };
  }
  if (start && end && compareDateOnly(end, start) < 0) {
    return { valid: false, errorKey: "endBeforeStart" };
  }
  return { valid: true };
}

/**
 * Formats a date-only "YYYY-MM-DD" string without UTC midnight parsing.
 * Splits integer parts and constructs local noon so the displayed day never
 * shifts across timezones (including Android devices in Thailand UTC+7).
 */
export function formatDateOnlyDisplay(ymd: string | undefined, uiLang: UiLanguage): string {
  if (!ymd) return "";
  const trimmed = ymd.trim();
  if (!isValidDateOnly(trimmed)) return trimmed;

  const [y, m, d] = trimmed.split("-").map(Number);
  const localNoon = new Date(y, m - 1, d, 12, 0, 0);

  const locale = uiLang === "th" ? "th-TH-u-ca-gregory" : uiLang === "my" ? "en-GB" : "en-GB";
  try {
    return new Intl.DateTimeFormat(locale, {
      day: "numeric",
      month: "short",
      year: "numeric",
    }).format(localNoon);
  } catch {
    return trimmed;
  }
}

/**
 * Formats a Firestore server Timestamp (createdAt / updatedAt) in the device's
 * local timezone. Distinct from date-only campaign schedule fields.
 */
export function formatSystemTimestamp(
  ts: Timestamp | { toDate?: () => Date; seconds?: number } | null | undefined,
  uiLang: UiLanguage
): string {
  if (!ts) return "—";
  let date: Date | null = null;
  if (typeof (ts as { toDate?: () => Date }).toDate === "function") {
    date = (ts as { toDate: () => Date }).toDate();
  } else if (typeof (ts as { seconds?: number }).seconds === "number") {
    date = new Date((ts as { seconds: number }).seconds * 1000);
  }
  if (!date || Number.isNaN(date.getTime())) return "—";

  const locale = uiLang === "th" ? "th-TH-u-ca-gregory" : "en-GB";
  try {
    return new Intl.DateTimeFormat(locale, {
      day: "numeric",
      month: "short",
      hour: "2-digit",
      minute: "2-digit",
    }).format(date);
  } catch {
    return date.toLocaleString();
  }
}

export function getTimestampMillis(
  ts: Timestamp | { toMillis?: () => number; seconds?: number } | null | undefined
): number {
  if (!ts) return 0;
  if (typeof (ts as { toMillis?: () => number }).toMillis === "function") {
    return (ts as { toMillis: () => number }).toMillis();
  }
  if (typeof (ts as { seconds?: number }).seconds === "number") {
    return (ts as { seconds: number }).seconds * 1000;
  }
  return 0;
}
