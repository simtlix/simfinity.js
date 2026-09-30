import type { BusinessHourSlot } from "./BusinessHoursEditor";

/*
 * Stored `dayOfWeek` values use JavaScript day numbers, as `Date#getDay()`,
 * both backends and the seed data do: 0 = Sunday, 1 = Monday ... 6 = Saturday.
 * Screens list the week from Monday, so display position and stored value
 * differ for every day.
 */

/** `hours.*` translation keys indexed by `dayOfWeek` (0 = Sunday). */
export const DAY_KEYS = [
  "sunday",
  "monday",
  "tuesday",
  "wednesday",
  "thursday",
  "friday",
  "saturday",
] as const;

/** `dayOfWeek` values in display order: Monday first, Sunday last. */
export const WEEK_DISPLAY_ORDER = [1, 2, 3, 4, 5, 6, 0] as const;

/** Position of a `dayOfWeek` in the Monday-first week: Monday = 0 ... Sunday = 6. */
export function mondayFirstIndex(dayOfWeek: number): number {
  return (((dayOfWeek + 6) % 7) + 7) % 7;
}

/** Initial hours for new shops and professionals: 09:00-18:00, closed on Sunday. */
export const DEFAULT_BUSINESS_HOURS: BusinessHourSlot[] = Array.from({ length: 7 }, (_, dayOfWeek) => ({
  dayOfWeek,
  openTime: "09:00",
  closeTime: "18:00",
  isClosed: dayOfWeek === 0,
}));
