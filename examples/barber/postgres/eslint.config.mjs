import simfinity from '@simtlix/eslint-plugin-simfinity';

export default [
  simfinity.configs['recommended-3.8'],
  { ignores: ['node_modules/**', 'uploads/**', 'generated/**'] },
];
