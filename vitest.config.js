import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // Keep agent worktrees under .claude/ from being collected as duplicates.
    exclude: ['**/node_modules/**', '.claude/**'],
  },
});
