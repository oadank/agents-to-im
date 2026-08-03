import * as esbuild from 'esbuild';

await esbuild.build({
  entryPoints: ['src/main.ts'],
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node20',
  outfile: 'dist/daemon.mjs',
  external: [
    // discord.js optional native deps
    'bufferutil', 'utf-8-validate', 'zlib-sync', 'erlpack',
    // Node.js built-ins
    'fs', 'path', 'os', 'crypto', 'http', 'https', 'net', 'tls',
    'stream', 'events', 'url', 'util', 'child_process', 'worker_threads',
    'node:*',
  ],
  banner: { js: "import { createRequire as __cr } from 'module'; import { fileURLToPath as __f2p } from 'url'; const require = __cr(import.meta.url); const __filename = __f2p(import.meta.url); const __dirname = __filename.replace(/[\/][^\/]*$/, '');" },
});

console.log('Built dist/daemon.mjs');
