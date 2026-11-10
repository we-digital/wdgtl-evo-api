import { cpSync } from 'node:fs';

import { defineConfig } from 'tsup';

export default defineConfig({
  // Production and package.json execute main; the recovery tool is an
  // operator-run entrypoint (node dist/chatwoot-inbound-recovery.js).
  entry: {
    main: 'src/main.ts',
    'chatwoot-inbound-recovery': 'src/scripts/chatwoot-inbound-recovery.ts',
  },
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
