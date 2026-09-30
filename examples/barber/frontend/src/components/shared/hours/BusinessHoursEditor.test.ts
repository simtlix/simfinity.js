import { createElement, isValidElement, type ReactElement, type ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';

import { BusinessHoursEditor, type BusinessHourSlot } from './BusinessHoursEditor';

// The unit project does not inherit the root `@` alias, so point the editor's
// aliased imports at their sources. Labels come from the real Spanish catalog
// without the i18n provider, so the component can be called in Node.
vi.mock('@/lib/cn', () => import('../../../lib/cn'));
vi.mock('@/hooks/useT', async () => {
  const { default: es } = await import('../../../../public/i18n/es.json');
  const labels = es as Record<string, string>;
  return {
    useT: (namespace?: string) => (key: string, fallback?: string) =>
      labels[namespace ? `${namespace}.${key}` : key] ?? fallback ?? key,
  };
});

type Props = Record<string, unknown> & { children?: ReactNode };

// Stored values follow Date#getDay(): 0 = Sunday ... 6 = Saturday.
const SHOP_HOURS: BusinessHourSlot[] = [
  { dayOfWeek: 1, openTime: '09:00', closeTime: '20:00', isClosed: false },
  { dayOfWeek: 2, openTime: '09:00', closeTime: '20:00', isClosed: false },
  { dayOfWeek: 3, openTime: '09:00', closeTime: '20:00', isClosed: false },
  { dayOfWeek: 4, openTime: '09:00', closeTime: '20:00', isClosed: false },
  { dayOfWeek: 5, openTime: '10:00', closeTime: '22:00', isClosed: false },
  { dayOfWeek: 6, openTime: '10:00', closeTime: '18:00', isClosed: false },
  { dayOfWeek: 0, openTime: '09:00', closeTime: '18:00', isClosed: true },
];

function findAll(node: ReactNode, match: (el: ReactElement<Props>) => boolean): ReactElement<Props>[] {
  if (Array.isArray(node)) return node.flatMap((child: ReactNode) => findAll(child, match));
  if (!isValidElement<Props>(node)) return [];
  const own = match(node) ? [node] : [];
  return [...own, ...findAll(node.props.children, match)];
}

/** Calls the editor and returns its rows as label + controls, in display order. */
function renderRows(value: BusinessHourSlot[], onChange: (slots: BusinessHourSlot[]) => void = () => {}) {
  const tree = BusinessHoursEditor({ value, onChange });
  const rows = tree.props.children as ReactElement<Props>[];
  return rows.map((row) => {
    const [label] = findAll(row, (el) => el.type === 'span' && typeof el.props.children === 'string');
    const [toggle] = findAll(row, (el) => el.props.role === 'switch');
    const timeInputs = findAll(row, (el) => el.type === 'input' && el.props.type === 'time');
    return {
      label: label.props.children as string,
      open: toggle.props['aria-checked'] as boolean,
      toggle: toggle.props.onClick as () => void,
      openTime: timeInputs[0]?.props.onChange as ((e: { target: { value: string } }) => void) | undefined,
    };
  });
}

function rowNamed(value: BusinessHourSlot[], label: string, onChange: (slots: BusinessHourSlot[]) => void) {
  const row = renderRows(value, onChange).find((r) => r.label === label);
  if (!row) throw new Error(`No row labeled ${label}`);
  return row;
}

describe('BusinessHoursEditor day mapping', () => {
  it('labels stored dayOfWeek 0 as Domingo and lists the week from Monday to Sunday', () => {
    const rows = renderRows(SHOP_HOURS);

    expect(rows.map((r) => r.label)).toEqual([
      'Lunes',
      'Martes',
      'Miércoles',
      'Jueves',
      'Viernes',
      'Sábado',
      'Domingo',
    ]);
    expect(rows.find((r) => r.label === 'Domingo')?.open).toBe(false);
    expect(rows.find((r) => r.label === 'Sábado')?.open).toBe(true);
  });

  it('renders Sunday closed as Domingo through React', () => {
    const html = renderToStaticMarkup(createElement(BusinessHoursEditor, { value: SHOP_HOURS, onChange: () => {} }));
    const rows = [...html.matchAll(/<span class="w-32[^"]*">([^<]+)<\/span><button[^>]*aria-checked="(true|false)"/g)]
      .map((m) => [m[1], m[2]]);

    expect(rows).toEqual([
      ['Lunes', 'true'],
      ['Martes', 'true'],
      ['Miércoles', 'true'],
      ['Jueves', 'true'],
      ['Viernes', 'true'],
      ['Sábado', 'true'],
      ['Domingo', 'false'],
    ]);
  });

  it('toggling Domingo changes dayOfWeek 0 and leaves Saturday untouched', () => {
    const onChange = vi.fn();
    rowNamed(SHOP_HOURS, 'Domingo', onChange).toggle();

    const saved = onChange.mock.calls[0][0] as BusinessHourSlot[];
    expect(saved.find((s) => s.dayOfWeek === 0)).toMatchObject({ isClosed: false });
    expect(saved.find((s) => s.dayOfWeek === 6)).toEqual(SHOP_HOURS.find((s) => s.dayOfWeek === 6));
  });

  it('editing Sábado changes dayOfWeek 6', () => {
    const onChange = vi.fn();
    rowNamed(SHOP_HOURS, 'Sábado', onChange).openTime?.({ target: { value: '11:00' } });

    const saved = onChange.mock.calls[0][0] as BusinessHourSlot[];
    expect(saved.find((s) => s.dayOfWeek === 6)).toMatchObject({ openTime: '11:00' });
    expect(saved.find((s) => s.dayOfWeek === 0)).toEqual(SHOP_HOURS.find((s) => s.dayOfWeek === 0));
  });

  it('fills missing days with each JavaScript day number exactly once', () => {
    const onChange = vi.fn();
    rowNamed([], 'Domingo', onChange).toggle();

    const saved = onChange.mock.calls[0][0] as BusinessHourSlot[];
    expect(saved.map((s) => s.dayOfWeek).sort()).toEqual([0, 1, 2, 3, 4, 5, 6]);
    expect(saved.filter((s) => s.isClosed).map((s) => s.dayOfWeek)).toEqual([0]);
  });
});
