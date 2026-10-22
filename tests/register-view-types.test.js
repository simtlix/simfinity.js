import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

// The packed TypeScript check in scripts/test-packages.js compiles these declarations against each
// published archive; this reads their text without packing.
const read = (path) => readFileSync(new URL(`../packages/${path}/types/index.d.ts`, import.meta.url), 'utf8');
const core = read('core');
const mongo = read('mongodb');
const postgres = read('postgres');
const sql = read('sql');

// Names of the `export type { ... } from '@simtlix/simfinity-core'` lists.
const reexportedCoreTypes = (text) => [...text.matchAll(/^export type \{([^}]*)\} from '@simtlix\/simfinity-core';/gm)]
  .flatMap(([, list]) => list.split(',').map((name) => name.trim()));

describe('registerView declarations', () => {
  it('declares registerView on the core Runtime with its option types', () => {
    const runtime = core.match(/^export interface Runtime<Model = any, Session = any> \{\n([\s\S]*?)^\}/m)?.[1];
    expect(runtime).toBeTypeOf('string');
    expect(runtime).toContain('  registerView(name: string, options: ViewOptions): void;');
    expect(core).toMatch(/^export interface ViewOptions \{$/m);
    expect(core).toMatch(/^export interface FilterGroup \{$/m);
  });

  it('declares the MongoDB facade function', () => {
    expect(mongo).toMatch(/^export function registerView\(/m);
  });

  it('declares the PostgreSQL default-instance member', () => {
    expect(postgres).toMatch(/^export const registerView: PostgresRuntime\['registerView'\];$/m);
  });

  it.each([
    ['mongodb', mongo],
    ['postgres', postgres],
    ['sql', sql],
  ])('re-exports the view option types from %s', (name, text) => {
    expect(reexportedCoreTypes(text)).toEqual(expect.arrayContaining(
      ['FilterCondition', 'FilterGroup', 'ViewOptions', 'ViewParam', 'ViewParamType'],
    ));
  });
});
