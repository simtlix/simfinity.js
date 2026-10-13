import { describe, expect, it } from "vitest";

import {
  bundleDurationMinutes,
  isAllowedForBooking,
  isBookable,
  lineReference,
  priceBookingLines,
  storedLineMatcher,
  storedLinePrice,
  toggleServiceSelection,
  type StoredLine,
} from "./catalog";
import { computeAvailableSlots, type BusinessHour } from "./slotUtils";

const service = (durationMinutes: number | null) => ({ service: { durationMinutes } });

describe("bundleDurationMinutes", () => {
  it("sums the bundle's current services, not its stored total, counting a repeated service each time", () => {
    // The owner made one service longer after the bundle was saved: the stored total still says 60.
    expect(bundleDurationMinutes({ totalDurationMinutes: 60, services: [service(30), service(90)] })).toBe(120);
    expect(bundleDurationMinutes({ totalDurationMinutes: 10, services: [service(10), service(10)] })).toBe(20);
  });

  it("counts missing and negative durations as zero, and skips listed services that do not resolve", () => {
    expect(bundleDurationMinutes({ totalDurationMinutes: 99, services: [service(null), service(-15), service(20), { service: null }, null] })).toBe(20);
  });

  it("uses the stored total for a bundle without services, or none that resolve", () => {
    expect(bundleDurationMinutes({ totalDurationMinutes: 45, services: [] })).toBe(45);
    expect(bundleDurationMinutes({ totalDurationMinutes: 45 })).toBe(45);
    expect(bundleDurationMinutes({ totalDurationMinutes: 45, services: [{ service: null }] })).toBe(45);
    expect(bundleDurationMinutes({ totalDurationMinutes: null })).toBe(0);
  });

  it("offers only times that fit the closing hour for the services' current length", () => {
    const businessHours: BusinessHour[] = [{ dayOfWeek: 1, openTime: "09:00", closeTime: "18:00", isClosed: false }];
    const durationMinutes = bundleDurationMinutes({ totalDurationMinutes: 60, services: [service(30), service(90)] });
    const slots = computeAvailableSlots({
      date: "2026-10-05",
      durationMinutes,
      busy: [],
      businessHours,
      slotDurationMinutes: 30,
      now: { date: "2026-10-01", minutes: 9 * 60 },
    }).filter((slot) => slot.available);
    expect(slots.at(-1)?.time).toBe("16:00");
  });
});

describe("isBookable", () => {
  it("accepts items unless they are marked inactive", () => {
    expect(isBookable({ isActive: true })).toBe(true);
    expect(isBookable({ isActive: null })).toBe(true);
    expect(isBookable({})).toBe(true);
    expect(isBookable({ isActive: false })).toBe(false);
    expect(isBookable(undefined)).toBe(false);
  });
});

const serviceLine = (id: string, price?: number | null): StoredLine => ({ service: { id }, bundle: null, price });
const bundleLine = (id: string, price?: number | null): StoredLine => ({ service: null, bundle: { id }, price });

describe("lineReference", () => {
  it("names the service or bundle a line references, ignoring the case of its id", () => {
    expect(lineReference({ service: { id: "A1" } })).toBe("service:a1");
    expect(lineReference({ service: null, bundle: { id: "a1" } })).toBe("bundle:a1");
  });
});

describe("storedLinePrice", () => {
  it("reads a negative stored price as zero and a missing one as no price, as the API does", () => {
    expect(storedLinePrice(serviceLine("a", 90))).toBe(90);
    expect(storedLinePrice(serviceLine("a", -5))).toBe(0);
    expect(storedLinePrice(serviceLine("a", null))).toBeUndefined();
    expect(storedLinePrice(serviceLine("a"))).toBeUndefined();
    expect(storedLinePrice(undefined)).toBeUndefined();
  });
});

describe("storedLineMatcher", () => {
  it("gives each line the first unused stored line with the same service or bundle", () => {
    const take = storedLineMatcher([serviceLine("a", 10), bundleLine("a", 30), serviceLine("A", 20)]);
    expect(take({ service: { id: "a" } })?.price).toBe(10);
    expect(take({ service: { id: "a" } })?.price).toBe(20);
    expect(take({ service: { id: "a" } })).toBeUndefined();
    // A bundle and a service with the same id are different references.
    expect(take({ bundle: { id: "a" } })?.price).toBe(30);
    expect(take({ bundle: { id: "a" } })).toBeUndefined();
  });

  it("matches nothing for a new booking", () => {
    expect(storedLineMatcher([])({ service: { id: "a" } })).toBeUndefined();
    expect(storedLineMatcher(undefined)({ service: { id: "a" } })).toBeUndefined();
  });
});

describe("priceBookingLines", () => {
  it("keeps the price a moved booking was booked at when the service now costs another", () => {
    // The booking was made at 90; the owner then set the service to 40. The API keeps 90.
    expect(priceBookingLines([{ service: { id: "s1" }, catalogPrice: 40 }], [serviceLine("s1", 90)])).toEqual([90]);
  });

  it("keeps a bundle's booked price, discount included, and charges the catalog price for new lines", () => {
    expect(priceBookingLines([{ bundle: { id: "b1" }, catalogPrice: 70 }], [bundleLine("b1", 50)])).toEqual([50]);
    // A service the booking had only inside its bundle is a new line.
    expect(priceBookingLines([{ service: { id: "s1" }, catalogPrice: 30 }, { service: { id: "s2" }, catalogPrice: 25 }], [bundleLine("b1", 50), serviceLine("s2", 20)])).toEqual([30, 20]);
  });

  it("prices one line per stored line, in any order, and the rest at the catalog price", () => {
    const stored = [serviceLine("a", 10), serviceLine("b", 20), serviceLine("a", 15)];
    expect(priceBookingLines([
      { service: { id: "b" }, catalogPrice: 99 },
      { service: { id: "a" }, catalogPrice: 99 },
      { service: { id: "a" }, catalogPrice: 99 },
      { service: { id: "a" }, catalogPrice: 99 },
    ], stored)).toEqual([20, 10, 15, 99]);
  });

  it("counts a negative stored price as zero and takes the catalog price for a line stored without one", () => {
    expect(priceBookingLines([{ service: { id: "a" }, catalogPrice: 40 }, { service: { id: "b" }, catalogPrice: 30 }], [serviceLine("a", -5), serviceLine("b", null)])).toEqual([0, 30]);
  });

  it("charges the catalog price, a negative or missing one as zero, on a new booking", () => {
    expect(priceBookingLines([{ service: { id: "a" }, catalogPrice: 40 }, { bundle: { id: "b" }, catalogPrice: -3 }, { service: { id: "c" }, catalogPrice: Number.NaN }], [])).toEqual([40, 0, 0]);
  });
});

describe("isAllowedForBooking", () => {
  it("allows active items, and inactive ones only as lines of the booking being moved", () => {
    expect(isAllowedForBooking({ isActive: true }, { service: { id: "a" } }, [])).toBe(true);
    expect(isAllowedForBooking({ isActive: false }, { service: { id: "a" } }, [])).toBe(false);
    expect(isAllowedForBooking({ isActive: false }, { service: { id: "a" } }, [serviceLine("A", 10)])).toBe(true);
    expect(isAllowedForBooking({ isActive: false }, { bundle: { id: "b" } }, [bundleLine("b", 10)])).toBe(true);
    expect(isAllowedForBooking(undefined, { service: { id: "a" } }, [serviceLine("a", 10)])).toBe(false);
  });

  it("does not allow an inactive service that the moved booking holds only inside its bundle", () => {
    expect(isAllowedForBooking({ isActive: false }, { service: { id: "a" } }, [bundleLine("k", 15)])).toBe(false);
    expect(isAllowedForBooking({ isActive: false }, { bundle: { id: "a" } }, [serviceLine("a", 15)])).toBe(false);
  });
});

describe("toggleServiceSelection", () => {
  const allowed = (ids: string[]) => (id: string) => ids.includes(id);

  it("adds or removes the toggled service", () => {
    expect([...toggleServiceSelection(new Set(["a"]), "b", allowed(["a", "b"]))]).toEqual(["a", "b"]);
    expect([...toggleServiceSelection(new Set(["a", "b"]), "a", allowed(["a", "b"]))]).toEqual(["b"]);
  });

  it("drops a bundle's services that the booking may not hold on their own when the bundle is taken apart", () => {
    // An active bundle lists inactive service A and active service B; unchecking B leaves nothing to book.
    expect([...toggleServiceSelection(new Set(["a", "b"]), "b", allowed(["b"]))]).toEqual([]);
    expect([...toggleServiceSelection(new Set(["a", "b"]), "c", allowed(["b", "c"]))]).toEqual(["b", "c"]);
  });
});
