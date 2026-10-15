import { GraphQLNonNull } from 'graphql';
import { getFieldStorageName } from './relation-storage.js';

const explicitNullPaths = (gqltype, args) => Object.entries(gqltype.getFields())
  .filter(([name, field]) => args[name] === null && !(field.type instanceof GraphQLNonNull))
  .map(([name, field]) => getFieldStorageName(name, field));

const assignNulls = (modelArgs, paths) => {
  for (const path of paths) modelArgs[path] = null;
};

export const preserveExplicitNulls = (modelArgs, gqltype, args, storage) => {
  if (storage?.nulls !== 'preserve') return;
  assignNulls(modelArgs, explicitNullPaths(gqltype, args));
};

export const applyNullUpdates = (modelArgs, gqltype, args, storage) => {
  const paths = explicitNullPaths(gqltype, args);
  if (storage?.nulls === 'preserve') {
    assignNulls(modelArgs, paths);
    return;
  }
  if (paths.length === 0) return;
  modelArgs.$unset = {
    ...modelArgs.$unset,
    ...Object.fromEntries(paths.map((path) => [path, ''])),
  };
};
