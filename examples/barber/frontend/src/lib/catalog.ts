/** A bundle read with `totalDurationMinutes services { service { durationMinutes } }`. */
export type BundleDurationSource = {
  totalDurationMinutes?: number | null;
  services?: ({ service?: { durationMinutes?: number | null } | null } | null)[] | null;
};

/**
 * How long a booking of the bundle lasts, computed as the API does (bundleServiceTotals and
 * catalogDuration in the backends): the sum of the durations of its listed services, a service listed
 * twice counting twice, a missing or negative duration counting as zero, and a listed service that does
 * not resolve counting nothing. A bundle none of whose services resolve lasts its own
 * `totalDurationMinutes`. The stored total can lag behind a service edit made by an earlier version of
 * the API, so the booking page offers times for this value, not the stored one.
 */
export function bundleDurationMinutes(bundle: BundleDurationSource): number {
  let minutes = 0;
  let resolved = 0;
  for (const item of bundle.services ?? []) {
    if (!item?.service) continue;
    resolved += 1;
    minutes += Math.max(0, Number(item.service.durationMinutes) || 0);
  }
  return resolved ? minutes : Math.max(0, Number(bundle.totalDurationMinutes) || 0);
}

/** Clients book a service or bundle unless it is marked inactive, as the API checks (INVALID_BOOKING_LINE). */
export function isBookable(item: { isActive?: boolean | null } | null | undefined): boolean {
  return item != null && item.isActive !== false;
}
