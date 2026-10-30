const namePattern = /^[_A-Za-z][_0-9A-Za-z]*$/;
const tokensOf = (text) => {
  const tokens = []; let index = 0;
  const token = /(?:\s+|#[^\n\r]*|,|\.\.\.|"""[\s\S]*?"""|"(?:\\.|[^"\\])*"|[_A-Za-z][_0-9A-Za-z]*|-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?|[!$():=@[\]{}])/y;
  while (index < text.length) {
    token.lastIndex = index; const match = token.exec(text);
    if (!match) throw new Error(`Invalid field selection at position ${index}`);
    index = token.lastIndex;
    if (!/^(?:\s|#|,)/.test(match[0])) tokens.push(match[0]);
  }
  return tokens;
};
const node = (name, alias = null) => ({ name, alias, suffix: '', selection: new SelectionTree() });

export class SelectionTree {
  constructor() { this.nodes = new Map(); }
  addScalars(fields) { for (const name of fields.trim().split(/\s+/)) { if (!name) continue; if (!namePattern.test(name)) throw new Error(`Invalid field ${name}`); if (!this.nodes.has(name)) this.nodes.set(name, node(name)); } }
  addSelection(text) {
    const tokens = tokensOf(text); let index = 0;
    const name = () => { const value = tokens[index++]; if (!namePattern.test(value || '')) throw new Error('Invalid field selection name'); return value; };
    const balanced = () => {
      const output = []; let depth = 0;
      do { const value = tokens[index++]; if (value === undefined) throw new Error('Unclosed selection arguments'); output.push(value); if (value === '(') depth++; if (value === ')') depth--; } while (depth);
      return output.join(' ');
    };
    const read = (tree, nested = false) => {
      while (index < tokens.length && tokens[index] !== '}') {
        let field;
        if (tokens[index] === '...') {
          index++; const fragment = name();
          field = node(fragment === 'on' ? `... on ${name()}` : `...${fragment}`);
        } else {
          const first = name();
          field = tokens[index] === ':' ? (index++, node(name(), first)) : node(first);
        }
        if (tokens[index] === '(') field.suffix += balanced();
        while (tokens[index] === '@') { index++; field.suffix += ` @${name()}`; if (tokens[index] === '(') field.suffix += balanced(); }
        if (tokens[index] === '{') { index++; read(field.selection, true); }
        const key = field.alias || field.name;
        const previous = tree.nodes.get(key);
        if (previous) {
          if (previous.name !== field.name || previous.suffix !== field.suffix) throw new Error(`Conflicting selections for ${key}`);
          for (const [child, value] of field.selection.nodes) previous.selection.nodes.set(child, value);
        } else tree.nodes.set(key, field);
      }
      if (nested && tokens[index++] !== '}') throw new Error('Unclosed field selection');
    };
    read(this);
    if (index !== tokens.length) throw new Error('Unexpected closing selection brace');
  }
  addNested(path, fields) {
    let tree = this;
    for (const part of path.split('.')) {
      if (!namePattern.test(part)) throw new Error(`Invalid collection path ${path}`);
      if (!tree.nodes.has(part)) tree.nodes.set(part, node(part));
      tree = tree.nodes.get(part).selection;
    }
    tree.addSelection(fields);
  }
  isEmpty() { return this.nodes.size === 0; }
  serialize(context, typeName, prefix = '') {
    const output = [];
    for (const field of this.nodes.values()) {
      const key = field.alias || field.name; const path = prefix ? `${prefix}.${key}` : key;
      const info = context?.types.get(typeName)?.fields.find((f) => f.name === field.name);
      let suffix = field.suffix;
      if (context?.arguments.has(path)) {
        if (!info?.type.isList || info.type.kind !== 'OBJECT') throw new Error(`Not a collection field: ${path}`);
        if (suffix) throw new Error(`Arguments already provided for ${path}`);
        context.used.add(path);
        const provided = context.arguments.get(path); const args = [];
        for (const [name, value] of Object.entries(provided)) {
          if (value === undefined) continue;
          const arg = info.args.find((a) => a.name === name);
          if (!arg) throw new Error(`Unknown collection argument ${path}.${name}`);
          args.push(`${name}: $${context.variable(arg.type, value)}`);
        }
        if (args.length) suffix = `(${args.join(', ')})`;
      }
      const fragmentType = field.name.startsWith('... on ') ? field.name.slice(7) : typeName;
      const children = field.selection.serialize(context, info?.type.name || fragmentType, path);
      output.push(`${field.alias ? `${field.alias}: ` : ''}${field.name}${suffix}${children ? ` { ${children} }` : ''}`);
    }
    return output.join(' ');
  }
}
