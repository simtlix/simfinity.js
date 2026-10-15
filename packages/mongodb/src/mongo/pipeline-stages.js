// Order is part of the read contract: sort, page, then project.
const READ_STAGES = [
  ['sort', '$sort'],
  ['skip', '$skip'],
  ['limit', '$limit'],
  ['projection', '$project'],
];

export const buildReadStages = (options) => READ_STAGES
  .filter(([option]) => Boolean(options[option]))
  .map(([option, operator]) => ({ [operator]: options[option] }));
