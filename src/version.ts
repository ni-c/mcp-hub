import { createRequire } from 'node:module';

// Single source of truth for the hub's version. dist/version.js, the npm
// tarball and the Docker image all resolve ../package.json to the package
// root, so the literal only lives in package.json.
export const VERSION: string = (
  createRequire(import.meta.url)('../package.json') as { version: string }
).version;
