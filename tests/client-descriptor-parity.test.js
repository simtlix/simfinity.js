import { readFileSync } from 'node:fs';
import { expect, test } from 'vitest';
import { graphql } from 'graphql';
import { buildClientDescriptor } from '../packages/descriptor/src/index.js';
import { generateMCPTools } from '../packages/mcp/src/index.js';
import { descriptorModel } from './fixtures/descriptor-model.js';

test('matches every legacy metadata key while adding unique and root input hints', async () => {
  const { schema } = descriptorModel(); const descriptor = buildClientDescriptor(schema);
  for (const name of ['Serie', 'Season', 'Episode', 'Details']) {
    const result = await graphql({ schema, source: `query($name: String!) {
      __type(name: $name) { fields { name extensions { relation { embedded connectionField displayField } readOnly stateMachine } } }
    }`, variableValues: { name } });
    expect(result.errors).toBeUndefined();
    for (const legacy of result.data.__type.fields) {
      const field = descriptor.types[name].fields.find((item) => item.name === legacy.name);
      expect(field.readOnly).toBe(!!legacy.extensions.readOnly);
      expect(field.stateMachine).toBe(!!legacy.extensions.stateMachine);
      expect(!!field.relation).toBe(!!legacy.extensions.relation);
      if (field.relation) expect(field.relation).toMatchObject({
        embedded: !!legacy.extensions.relation.embedded,
        connectionField: legacy.extensions.relation.connectionField,
        displayField: legacy.extensions.relation.displayField,
      });
    }
  }
  const serie = Object.fromEntries(descriptor.types.Serie.fields.map((f) => [f.name, f]));
  expect(serie.name.unique).toBe(true); expect(serie.id.unique).toBe(false);
  expect(serie.name.rootInputUsage).toEqual({ add: 'required', update: 'optional' });
  expect(serie.state.rootInputUsage).toEqual({});
  expect(serie.seasons.relation.inverseField).toBe('serie');
  expect(descriptor.types.Episode.fields.find((f) => f.name === 'season').relation).toEqual({
    target: 'Season', embedded: false, connectionField: null, inverseField: 'episodes', displayField: 'number',
  });
  const before = schema.getMutationType().getFields().addserie.args[0].type;
  expect(buildClientDescriptor(schema)).toBe(descriptor);
  expect(schema.getMutationType().getFields().addserie.args[0].type).toBe(before);
});

test('keeps MCP observable classification aligned without a new public classifier', () => {
  const { schema } = descriptorModel(); const descriptor = buildClientDescriptor(schema);
  const { tools } = generateMCPTools(schema);
  for (const [root, operations] of Object.entries(descriptor.operations)) {
    for (const [name, operation] of Object.entries(operations)) {
      const tool = tools.find((item) => item.name === name);
      expect(tool.kind).toBe(root);
      expect(tool.annotations.readOnlyHint).toBe(root === 'query');
      if (operation.operation === 'delete') {
        expect(tool.annotations.destructiveHint).toBe(true);
        expect(tool.annotations.idempotentHint).toBe(true);
      }
      if (operation.operation === 'add') expect(tool.annotations.idempotentHint).toBeUndefined();
      if (operation.operation === 'customMutation') expect(tool.annotations.destructiveHint).toBeUndefined();
      if (operation.operation === 'transition') expect(tool.description).toContain('Publish');
      if (operation.view) expect(tool.title).toBe(name);
      if (operation.operation === 'get') expect(tool.inputSchema.properties).toHaveProperty('id');
      if (operation.operation === 'aggregate') expect(tool.inputSchema.properties).toHaveProperty('aggregation');
      if (operation.operation === 'list') expect(tool.inputSchema.properties).toHaveProperty('pagination');
    }
  }
});

test('pins the abridged public JSON example to the synthetic schema', () => {
  const page = readFileSync(new URL('../docs/reference/client-descriptor.md', import.meta.url), 'utf8');
  const sample = page.match(/<!-- descriptor-example -->\s*```json\n([\s\S]*?)\n```/);
  expect(sample, 'The reference must contain the tested descriptor example').not.toBeNull();
  const expected = JSON.parse(sample[1]);
  const descriptor = buildClientDescriptor(descriptorModel().schema);
  for (const [name, type] of Object.entries(expected.types)) {
    for (const field of type.fields || []) {
      expect(descriptor.types[name].fields.find((item) => item.name === field.name)).toMatchObject(field);
    }
    delete type.fields; // The abridged example intentionally selects fields by name, not position.
  }
  expect(descriptor).toMatchObject(expected);
});
