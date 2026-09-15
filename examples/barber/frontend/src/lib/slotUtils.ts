type BusinessHour = {
  dayOfWeek?: number;
  openTime?: string;
  closeTime?: string;
  isClosed?: boolean;
};

export function computeAvailableSlots(
  businessHours: BusinessHour[],
  slotDurationMinutes: number,
  date: string,
  existingBookings: { startTime?: string; endTime?: string }[],
): { time: string; available: boolean }[] {
  const d = new Date(`${date}T12:00:00`);
  if (Number.isNaN(d.getTime())) return [];
  const dow = d.getDay();
  const dayRow = businessHours.find((h) => h.dayOfWeek === dow);
  if (!dayRow || dayRow.isClosed) return [];

  const parseTime = (t: string): number | null => {
    const m = t.trim().match(/^(\d{1,2}):(\d{2})$/);
    if (!m) return null;
    const h = Number(m[1]);
    const min = Number(m[2]);
    if (h > 23 || min > 59) return null;
    return h * 60 + min;
  };
  const toHHmm = (mins: number) =>
    `${String(Math.floor(mins / 60)).padStart(2, "0")}:${String(mins % 60).padStart(2, "0")}`;

  const openM = parseTime(dayRow.openTime || "09:00");
  const closeM = parseTime(dayRow.closeTime || "18:00");
  if (openM == null || closeM == null || closeM <= openM) return [];

  const busy = existingBookings
    .map((b) => ({ a: parseTime(b.startTime || ""), b: parseTime(b.endTime || "") }))
    .filter((x): x is { a: number; b: number } => x.a != null && x.b != null);

  const slots: { time: string; available: boolean }[] = [];
  for (let t = openM; t + slotDurationMinutes <= closeM; t += slotDurationMinutes) {
    const end = t + slotDurationMinutes;
    const overlap = busy.some((x) => !(end <= x.a || t >= x.b));
    slots.push({ time: toHHmm(t), available: !overlap });
  }
  return slots;
}
