import { describe, expect, it } from 'vitest';

import en from '../../../../public/i18n/en.json';
import es from '../../../../public/i18n/es.json';
import { DAY_KEYS, DEFAULT_BUSINESS_HOURS, WEEK_DISPLAY_ORDER, mondayFirstIndex } from './businessHours';

const esLabels = es as Record<string, string>;
const enLabels = en as Record<string, string>;
const WEEK = [0, 1, 2, 3, 4, 5, 6];
// Sunday 4 and Saturday 3 October 2026, as Date#getDay() and the booking page see them.
const SUNDAY = new Date(2026, 9, 4).getDay();
const SATURDAY = new Date(2026, 9, 3).getDay();

describe('business hours day numbering', () => {
  it('uses JavaScript day numbers for editor labels', () => {
    expect(esLabels[`hours.${DAY_KEYS[SUNDAY]}`]).toBe('Domingo');
    expect(esLabels[`hours.${DAY_KEYS[SATURDAY]}`]).toBe('Sábado');
    // Same label as the public shop profile for every stored day.
    for (const day of WEEK) {
      expect(esLabels[`hours.${DAY_KEYS[day]}`]).toBe(esLabels[`barbershop.dayLong${day}`]);
    }
  });

  it('lists every day once, from Monday to Sunday', () => {
    expect([...WEEK_DISPLAY_ORDER].sort()).toEqual(WEEK);
    expect(WEEK_DISPLAY_ORDER[0]).toBe(1);
    expect(WEEK_DISPLAY_ORDER[6]).toBe(SUNDAY);
    expect(WEEK_DISPLAY_ORDER.map(mondayFirstIndex)).toEqual(WEEK);
  });

  it('maps stored days to the Monday-first admin schedule labels', () => {
    expect(mondayFirstIndex(0)).toBe(6);
    expect(esLabels[`admin.scheduleWeekday${mondayFirstIndex(0)}`]).toBe('Domingo');
    expect(enLabels[`admin.scheduleWeekday${mondayFirstIndex(0)}`]).toBe('Sunday');
    for (const day of WEEK) {
      expect(esLabels[`admin.scheduleWeekday${mondayFirstIndex(day)}`]).toBe(esLabels[`barbershop.dayLong${day}`]);
      expect(enLabels[`admin.scheduleWeekday${mondayFirstIndex(day)}`]).toBe(enLabels[`barbershop.dayLong${day}`]);
    }
  });

  it('defaults to a week closed only on Sunday', () => {
    expect(DEFAULT_BUSINESS_HOURS.map((slot) => slot.dayOfWeek)).toEqual(WEEK);
    expect(DEFAULT_BUSINESS_HOURS.filter((slot) => slot.isClosed).map((slot) => slot.dayOfWeek)).toEqual([SUNDAY]);
    expect(DEFAULT_BUSINESS_HOURS.find((slot) => slot.dayOfWeek === SATURDAY)).toMatchObject({
      openTime: '09:00',
      closeTime: '18:00',
      isClosed: false,
    });
  });
});
