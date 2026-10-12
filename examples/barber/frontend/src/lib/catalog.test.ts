import { describe, expect, it } from "vitest";

import { bundleDurationMinutes, isBookable } from "./catalog";
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
