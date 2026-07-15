const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

function parseDeliveryDate(value: string): Date | null {
  const trimmed = value.trim();
  const dateOnly = /^(\d{4})-(\d{2})-(\d{2})$/.exec(trimmed);

  if (dateOnly) {
    const year = Number(dateOnly[1]);
    const month = Number(dateOnly[2]) - 1;
    const day = Number(dateOnly[3]);
    const parsed = new Date(year, month, day);
    return parsed.getFullYear() === year &&
      parsed.getMonth() === month &&
      parsed.getDate() === day
      ? parsed
      : null;
  }

  const parsed = new Date(trimmed);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

function isSameCalendarDay(a: Date, b: Date): boolean {
  return a.getFullYear() === b.getFullYear() &&
    a.getMonth() === b.getMonth() &&
    a.getDate() === b.getDate();
}

/** Friendly relative time: "just now", "12 min ago", "3 h ago", "2 d ago". */
export function relativeTime(iso: string, now: number = Date.now()): string {
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return '';
  const diff = now - then;
  if (diff < MINUTE) return 'just now';
  if (diff < HOUR) return `${Math.floor(diff / MINUTE)} min ago`;
  if (diff < DAY) return `${Math.floor(diff / HOUR)} h ago`;
  if (diff < 7 * DAY) return `${Math.floor(diff / DAY)} d ago`;
  return formatDate(iso);
}

/** Swiss-style date: 24.12.2025 */
export function formatDate(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const pad = (x: number) => String(x).padStart(2, '0');
  return `${pad(d.getDate())}.${pad(d.getMonth() + 1)}.${d.getFullYear()}`;
}

/** Swiss-style date and time: 24.12.2025, 14:05 */
export function formatDateTime(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const pad = (x: number) => String(x).padStart(2, '0');
  return `${formatDate(iso)}, ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** Friendly expected-delivery date: "today", "tomorrow", or 24.12.2025. */
export function formatExpectedDelivery(
  value: string,
  now: number = Date.now(),
): string {
  const expected = parseDeliveryDate(value);
  if (!expected) return value;

  const today = new Date(now);
  if (isSameCalendarDay(expected, today)) return 'today';

  const tomorrow = new Date(
    today.getFullYear(),
    today.getMonth(),
    today.getDate() + 1,
  );
  if (isSameCalendarDay(expected, tomorrow)) return 'tomorrow';

  const pad = (x: number) => String(x).padStart(2, '0');
  return `${pad(expected.getDate())}.${pad(expected.getMonth() + 1)}.${expected.getFullYear()}`;
}
