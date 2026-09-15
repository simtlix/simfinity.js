import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { parse, validate } from 'graphql';
import { schema } from '../application.js';
import { closeDatabase } from '../database.js';

try {
  for (const [file, entity] of [['dashboard/page.tsx', 'review'], ['admin/page.tsx', 'barbershop']]) {
    const source = await readFile(new URL(`../../frontend/src/app/${file}`, import.meta.url), 'utf8');
    const expression = new RegExp(`\\.find\\('${entity}'\\)\\s*\\.fields\\('([^']+)'\\)([\\s\\S]*?)\\.exec\\(\\)`, 'g');
    const selections = [...source.matchAll(expression)];
    assert.ok(selections.length, `${file}: actual client field selections found`);
    for (const [, selection, chain] of selections) {
      const queryName = entity === 'review' ? 'reviews' : 'barbershops';
      const errors = validate(schema, parse(`{ ${queryName} { ${selection} } }`));
      assert.deepEqual(errors.map((error) => error.message), [], file);
      for (const [, field] of chain.matchAll(/\.sort\('([^']+)'/g)) {
        assert.ok(schema.getType(entity).getFields()[field], `${file}: sort field ${field} exists`);
      }
    }
  }
  console.log('Both dashboard selections validate against the application GraphQL schema.');
} finally { await closeDatabase(); }
