import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import {
  BOOKING_ERRORS,
  BOOKING_FAILED,
  ORIGINAL_KEPT,
  RESCHEDULE_UNAVAILABLE,
  bookingErrorCode,
  bookingErrorMessage,
} from "./bookingErrors";

const locale = (name: string) =>
  JSON.parse(readFileSync(new URL(`../../public/i18n/${name}.json`, import.meta.url), "utf8")) as Record<string, string>;

describe("booking error messages", () => {
  const messages = [...Object.values(BOOKING_ERRORS), BOOKING_FAILED, ORIGINAL_KEPT, RESCHEDULE_UNAVAILABLE];

  it("has every key in both locales, with the Spanish fallback matching es.json", () => {
    const es = locale("es");
    const en = locale("en");
    for (const { key, fallback } of messages) {
      expect(es[`booking.${key}`], key).toBe(fallback);
      expect(en[`booking.${key}`], key).toEqual(expect.any(String));
      expect(en[`booking.${key}`]).not.toBe(fallback);
    }
  });

  it("explains that a stale reschedule cannot move a booking that is no longer confirmed", () => {
    expect(bookingErrorMessage("BAD_REQUEST", true).key).toBe("errors.rescheduleUnavailable");
    expect(bookingErrorMessage("BAD_REQUEST", false)).toBe(BOOKING_FAILED);
  });

  it("maps API codes to messages and falls back to a generic failure", () => {
    const failure = { graphQLErrors: [{ extensions: { code: "BOOKING_SLOT_UNAVAILABLE" } }] };
    expect(bookingErrorCode(failure)).toBe("BOOKING_SLOT_UNAVAILABLE");
    expect(bookingErrorMessage(bookingErrorCode(failure)).key).toBe("errors.slotUnavailable");
    expect(bookingErrorMessage("TRANSACTION_RETRY_EXCEEDED").key).toBe("errors.scheduleBusy");
    for (const error of [new Error("offline"), null, { graphQLErrors: [] }, { graphQLErrors: [{ extensions: { code: 7 } }] }]) {
      expect(bookingErrorCode(error)).toBe("");
    }
    expect(bookingErrorMessage("")).toBe(BOOKING_FAILED);
  });
});
