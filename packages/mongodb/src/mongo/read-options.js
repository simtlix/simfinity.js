// Supported execution and projection options for observed generated reads.
const EXECUTION_OPTIONS = [
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
  ...EXECUTION_OPTIONS,
  'projection',
  'sort',
  'skip',
  'limit',
];
