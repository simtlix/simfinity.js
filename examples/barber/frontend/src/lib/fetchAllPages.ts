/** Load every page using a stable server-side order, propagating incomplete reads. */
export async function fetchAllPages<T>(
  load: (page: number, size: number) => Promise<T[]>,
  size = 100,
): Promise<T[]> {
  const rows: T[] = [];
  for (let page = 1; ; page++) {
    const batch = await load(page, size);
    rows.push(...batch);
    if (batch.length < size) return rows;
  }
}
