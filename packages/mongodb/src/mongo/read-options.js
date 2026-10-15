// Server queries own their shape. Only cursor/execution controls may accompany
// a compiled plan; storage projections may additionally supply shaping options.
export const SERVER_READ_OPTION_NAMES = [
  'batchSize',
  'collation',
  'hint',
  'maxTimeMS',
  'timeoutMS',
  'timeoutMode',
  'signal',
  'allowDiskUse',
  'readConcern',
];
export const READ_OPTION_NAMES = [
  ...SERVER_READ_OPTION_NAMES,
  'projection',
  'sort',
  'skip',
  'limit',
];
