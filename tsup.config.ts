import { cpSync } from 'node:fs';

import { defineConfig } from 'tsup';

export default defineConfig({
  // Production and package.json execute only this CommonJS entrypoint.
  entry: ['src/main.ts'],
  outDir: 'dist',
  splitting: false,
  sourcemap: true,
  clean: true,
  minify: true,
  format: ['cjs'],
  onSuccess: async () => {
    cpSync('src/utils/translations', 'dist/translations', { recursive: true });
  },
  loader: {
    '.json': 'file',
    '.yml': 'file',
  },
});
