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

/** What a booking line references: a service or a bundle, by id. */
export type LineReference = {
  service?: { id?: string | null } | null;
  bundle?: { id?: string | null } | null;
};

/** A line of a stored booking: what it references and the price it was booked at. */
export type StoredLine = LineReference & { price?: number | null };

const idKey = (id: string | null | undefined) => (id == null ? "null" : String(id).toLowerCase());

/** The catalog item a line references, as `service:<id>` or `bundle:<id>` (lineReference in the backends). */
export function lineReference(line: LineReference): string {
  return line.service ? `service:${idKey(line.service.id)}` : `bundle:${idKey(line.bundle?.id)}`;
}

/** A stored line's price: a negative one stored by an earlier version counts as zero, a missing one as none (storedPrice in the backends). */
export function storedLinePrice(line: StoredLine | null | undefined): number | undefined {
  if (line?.price == null || !Number.isFinite(Number(line.price))) return undefined;
  return Math.max(0, Number(line.price));
}

/**
 * Matches lines to the stored lines of the booking being moved as the API does (storedLineMatcher in the
 * backends): each call takes the first unused stored line with the same service or bundle.
 */
export function storedLineMatcher(storedLines: readonly StoredLine[] | null | undefined): (line: LineReference) => StoredLine | undefined {
  const byReference = new Map<string, StoredLine[]>();
  for (const line of storedLines ?? []) {
    const key = lineReference(line);
    byReference.set(key, [...(byReference.get(key) ?? []), line]);
  }
  return (line) => byReference.get(lineReference(line))?.shift();
}

/**
 * The price the API stores for each line a client sends (applyCatalogLineValues in the backends): a line
 * whose service or bundle the booking being moved already had keeps that stored line's price, so a
 * reschedule keeps what was booked after a catalog change; any other line takes the catalog price, a
 * negative or missing one counting as zero. A new booking has no stored lines.
 */
export function priceBookingLines(
  lines: readonly (LineReference & { catalogPrice: number })[],
  storedLines: readonly StoredLine[] | null | undefined,
): number[] {
  const takeStoredLine = storedLineMatcher(storedLines);
  return lines.map((line) => storedLinePrice(takeStoredLine(line)) ?? Math.max(0, Number(line.catalogPrice) || 0));
}

/**
 * Whether a client may book the service or bundle on this booking: while it is active, or, when it is no
 * longer offered, only as a line of the booking being moved, which the API keeps (INVALID_BOOKING_LINE
 * otherwise). A service that the moved booking holds only inside its bundle is not one of its lines.
 */
export function isAllowedForBooking(
  item: { isActive?: boolean | null } | null | undefined,
  reference: LineReference,
  storedLines: readonly StoredLine[] | null | undefined,
): boolean {
  if (item == null) return false;
  if (isBookable(item)) return true;
  const key = lineReference(reference);
  return (storedLines ?? []).some((line) => lineReference(line) === key);
}

/**
 * The services selected after the client toggles one. Toggling a service takes a selected bundle apart,
 * and its services stay selected as separate lines only where `isAllowed` (isAllowedForBooking): a bundle
 * can list a service that is no longer offered on its own.
 */
export function toggleServiceSelection(selected: Iterable<string>, id: string, isAllowed: (id: string) => boolean): Set<string> {
  const next = new Set(selected);
  if (next.has(id)) next.delete(id);
  else next.add(id);
  return new Set([...next].filter(isAllowed));
}
