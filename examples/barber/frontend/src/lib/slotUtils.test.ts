import { describe, expect, it } from "vitest";

import { computeAvailableSlots, hoursForDay, parseEndClock, shopNow, type BusinessHour, type SlotRequest } from "./slotUtils";

// 2026-10-05 is a Monday; the shop opens 09:00-18:00 with a 13:00-14:00 break and closes on Sunday.
const businessHours: BusinessHour[] = [0, 1, 2, 3, 4, 5, 6].map((dayOfWeek) => ({
  dayOfWeek,
  openTime: "09:00",
  closeTime: "18:00",
  isClosed: dayOfWeek === 0,
  breakStartTime: "13:00",
  breakEndTime: "14:00",
}));
const base: SlotRequest = {
  date: "2026-10-05",
  durationMinutes: 30,
  busy: [],
  businessHours,
  slotDurationMinutes: 30,
  now: { date: "2026-10-01", minutes: 9 * 60 },
};
const availability = (overrides: Partial<SlotRequest>) =>
  Object.fromEntries(computeAvailableSlots({ ...base, ...overrides }).map((slot) => [slot.time, slot.available]));

describe("computeAvailableSlots", () => {
  it("blocks another client's booking for the chosen professional and for no preference", () => {
    const busy = [{ startTime: "10:00", endTime: "10:30", professionalId: "p1" }];
    expect(availability({ busy, professionalId: "p1" })["10:00"]).toBe(false);
    expect(availability({ busy, professionalId: null })["10:00"]).toBe(false);
    expect(availability({ busy, professionalId: "p2" })["10:00"]).toBe(true);
  });

  it("treats bookings without a professional as holding every professional", () => {
    const busy = [{ startTime: "10:00", endTime: "10:30", professionalId: null }];
    expect(availability({ busy, professionalId: "p2" })["10:00"]).toBe(false);
  });

  it("checks the whole selected duration against bookings, the break and closing time", () => {
    const slots = availability({ durationMinutes: 90, busy: [{ startTime: "10:30", endTime: "11:00", professionalId: "p1" }], professionalId: "p1" });
    expect(slots["09:00"]).toBe(true);
    expect(slots["10:00"]).toBe(false);
    expect(slots["11:00"]).toBe(true);
    expect(slots["12:00"]).toBe(false);
    expect(slots["16:30"]).toBe(true);
    expect(slots["17:00"]).toBeUndefined();
    expect(slots["17:30"]).toBeUndefined();
  });

  it("marks times inside the break as unavailable", () => {
    const slots = availability({});
    expect(slots["12:30"]).toBe(true);
    expect(slots["13:00"]).toBe(false);
    expect(slots["13:30"]).toBe(false);
    expect(slots["14:00"]).toBe(true);
  });

  it("keeps bufferMinutes after every booking, including before the break and closing", () => {
    const busy = [{ startTime: "10:00", endTime: "10:30", professionalId: "p1" }];
    const slots = availability({ busy, professionalId: "p1", bufferMinutes: 10, slotDurationMinutes: 10 });
    expect(slots["09:20"]).toBe(true);
    expect(slots["09:30"]).toBe(false);
    expect(slots["10:30"]).toBe(false);
    expect(slots["10:40"]).toBe(true);
    expect(slots["12:20"]).toBe(true);
    expect(slots["12:30"]).toBe(false);
    expect(slots["17:20"]).toBe(true);
    expect(slots["17:30"]).toBeUndefined();
  });

  it("offers nothing before now + minAdvanceHours", () => {
    const slots = availability({ date: "2026-10-01", minAdvanceHours: 2 });
    expect(slots["10:30"]).toBe(false);
    expect(slots["11:00"]).toBe(true);
    expect(computeAvailableSlots({ ...base, date: "2026-09-30" })).toEqual([]);
  });

  it("offers nothing beyond maxAdvanceDays, on closed days or without hours", () => {
    expect(computeAvailableSlots({ ...base, maxAdvanceDays: 3 })).toEqual([]);
    expect(computeAvailableSlots({ ...base, maxAdvanceDays: 4 }).length).toBeGreaterThan(0);
    expect(computeAvailableSlots({ ...base, date: "2026-10-04" })).toEqual([]);
    expect(computeAvailableSlots({ ...base, businessHours: [] })).toEqual([]);
  });

  it("narrows the shop's hours with the professional's own row for the weekday", () => {
    const professionalHours = [{ dayOfWeek: 1, openTime: "07:00", closeTime: "10:00", isClosed: false }];
    expect(Object.keys(availability({ professionalHours }))).toEqual(["09:00", "09:30"]);
    expect(availability({ professionalHours, date: "2026-10-06" })["15:00"]).toBe(true);
    expect(hoursForDay(businessHours, professionalHours, 1)).toEqual({ open: 540, close: 600, breaks: [[780, 840]] });
  });

  it.each([
    { label: "absent times", times: {} },
    { label: "null times", times: { openTime: null, closeTime: null } },
    { label: "only an opening time", times: { openTime: "19:00" } },
    { label: "only a closing time", times: { closeTime: "21:00" } },
    { label: "an invalid opening time", times: { openTime: "invalid", closeTime: "21:00" } },
    { label: "an invalid closing time", times: { openTime: "19:00", closeTime: "25:00" } },
  ])("inherits the shop's hours when the professional has $label", ({ times }) => {
    const eveningHours = [{ dayOfWeek: 1, openTime: "18:00", closeTime: "22:00" }];
    const professionalHours = [{ dayOfWeek: 1, isClosed: false, breakStartTime: "20:00", breakEndTime: "20:30", ...times }];
    const slots = availability({ businessHours: eveningHours, professionalHours });
    expect(slots).toEqual({
      "18:00": true,
      "18:30": true,
      "19:00": true,
      "19:30": true,
      "20:00": false,
      "20:30": true,
      "21:00": true,
      "21:30": true,
    });
  });

  it("uses the professional's complete window when the shop only supplies a break", () => {
    const slots = availability({
      businessHours: [{ dayOfWeek: 1, breakStartTime: "20:00", breakEndTime: "20:30" }],
      professionalHours: [{ dayOfWeek: 1, openTime: "18:00", closeTime: "22:00" }],
    });
    expect(slots["18:00"]).toBe(true);
    expect(slots["20:00"]).toBe(false);
    expect(slots["21:30"]).toBe(true);
    expect(slots["17:30"]).toBeUndefined();
  });

  it("retains the display fallback when neither row supplies a complete window", () => {
    const slots = availability({
      businessHours: [{ dayOfWeek: 1, openTime: "20:00" }],
      professionalHours: [{ dayOfWeek: 1, closeTime: "08:00", breakStartTime: "13:00", breakEndTime: "14:00" }],
    });
    expect(slots["09:00"]).toBe(true);
    expect(slots["13:00"]).toBe(false);
    expect(slots["17:30"]).toBe(true);
    expect(slots["18:00"]).toBeUndefined();
  });

  it("keeps a day closed when the shop or the professional closes it", () => {
    // 2026-10-04 is a Sunday: the shop is closed although the professional's default hours open it.
    const openEveryDay = [0, 1, 2, 3, 4, 5, 6].map((dayOfWeek) => ({ dayOfWeek, openTime: "09:00", closeTime: "18:00", isClosed: false }));
    expect(computeAvailableSlots({ ...base, date: "2026-10-04", professionalHours: openEveryDay })).toEqual([]);
    expect(computeAvailableSlots({ ...base, professionalHours: openEveryDay }).length).toBeGreaterThan(0);
    expect(computeAvailableSlots({ ...base, professionalHours: [{ dayOfWeek: 1, isClosed: true }] })).toEqual([]);
    expect(computeAvailableSlots({ ...base, professionalHours: [{ dayOfWeek: 1, openTime: "06:00", closeTime: "08:00" }] })).toEqual([]);
  });

  it("applies both the shop's and the professional's breaks", () => {
    const professionalHours = [{ dayOfWeek: 1, openTime: "09:00", closeTime: "18:00", breakStartTime: "10:00", breakEndTime: "10:30" }];
    const slots = availability({ professionalHours });
    expect(slots["10:00"]).toBe(false);
    expect(slots["11:00"]).toBe(true);
    expect(slots["13:00"]).toBe(false);
  });

  it("uses the professional's row alone when the shop has none for the weekday", () => {
    const professionalHours = [{ dayOfWeek: 1, openTime: "10:00", closeTime: "12:00" }];
    expect(Object.keys(availability({ businessHours: [], professionalHours }))).toEqual(["10:00", "10:30", "11:00", "11:30"]);
  });

  it("accepts 24:00 as a closing time and as the end of a booking", () => {
    expect(parseEndClock("24:00")).toBe(1440);
    const lateHours = [{ dayOfWeek: 1, openTime: "22:00", closeTime: "24:00", isClosed: false }];
    expect(Object.keys(availability({ businessHours: lateHours }))).toEqual(["22:00", "22:30", "23:00", "23:30"]);
    const busy = [{ startTime: "23:30", endTime: "24:00", professionalId: "p1" }];
    const slots = availability({ businessHours: lateHours, busy, professionalId: "p1", durationMinutes: 20, slotDurationMinutes: 10 });
    expect(slots["23:10"]).toBe(true);
    expect(slots["23:20"]).toBe(false);
    expect(slots["23:40"]).toBe(false);
  });
});

describe("shopNow", () => {
  it("reads the wall clock in the shop timezone and falls back to UTC", () => {
    const now = new Date("2026-10-01T02:30:00Z");
    expect(shopNow("America/Argentina/Buenos_Aires", now)).toEqual({ date: "2026-09-30", minutes: 23 * 60 + 30 });
    expect(shopNow(null, now)).toEqual({ date: "2026-10-01", minutes: 2 * 60 + 30 });
    expect(shopNow("Not/AZone", now)).toEqual({ date: "2026-10-01", minutes: 2 * 60 + 30 });
  });
});
