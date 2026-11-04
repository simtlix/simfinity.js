import { describe, expect, it } from 'vitest';
import { fetchAllPages } from './fetchAllPages';

describe('fetchAllPages', () => {
  it('collects 250 rows from pages of 100 without truncation or duplicates', async () => {
    const rows = Array.from({ length: 250 }, (_, id) => ({ id }));
    const calls: number[][] = [];
    const result = await fetchAllPages(async (page, size) => {
      calls.push([page, size]);
      return rows.slice((page - 1) * size, page * size);
    });
    expect(result).toEqual(rows);
    expect(calls).toEqual([[1, 100], [2, 100], [3, 100]]);
  });

  it('stops on an empty first page', async () => {
    const calls: number[][] = [];
    expect(await fetchAllPages(async (page, size) => {
      calls.push([page, size]);
      return [];
    })).toEqual([]);
    expect(calls).toEqual([[1, 100]]);
  });

  it('checks the next page after an exactly full page', async () => {
    const calls: number[] = [];
    expect(await fetchAllPages(async (page) => {
      calls.push(page);
      return page === 1 ? [1, 2] : [];
    }, 2)).toEqual([1, 2]);
    expect(calls).toEqual([1, 2]);
  });

  it('propagates a failed page instead of returning incomplete totals', async () => {
    await expect(fetchAllPages(async (page) => {
      if (page === 2) throw new Error('Page unavailable');
      return [1, 2];
    }, 2)).rejects.toThrow('Page unavailable');
  });
});
