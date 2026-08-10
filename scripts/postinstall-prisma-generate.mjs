#!/usr/bin/env node
/**
 * Generate the Prisma client after install, but only when the schema is there.
 *
 * A fresh clone needs this: `npm ci` alone leaves the client ungenerated and
 * the test suite fails with confusing "property does not exist" errors.
 *
 * The production Docker stage needs the opposite: `runner` installs
 * dependencies from package.json and the lockfile without the source tree, so
 * the schema genuinely is absent and generating there is impossible. Running
 * it unconditionally breaks the image build.
 *
 * Written as a Node script rather than a shell conditional because postinstall
 * also runs on Windows, where `test -f` does not exist.
 */
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { delimiter, join } from 'node:path';

const SCHEMA_PATH = 'packages/prisma/schema.prisma';

if (!existsSync(SCHEMA_PATH)) {
  console.log(`postinstall: ${SCHEMA_PATH} is not present, skipping prisma generate`);
  process.exit(0);
}

const require = createRequire(import.meta.url);

// Resolve Prisma's own entrypoint and run it with this Node binary. Going
// through npx would need a shell on Windows to follow the .cmd shim, and
// argument arrays with shell: true are deprecated for good reason.
const prismaBin = require.resolve('prisma/build/index.js');

// Prisma spawns the custom generators (prisma-kysely, zod-prisma-types) by
// name, and finds them on PATH. npx adds node_modules/.bin for you; invoking
// the entrypoint directly does not, so add it here or generation fails with
// "spawn prisma-kysely ENOENT".
const binDir = join(process.cwd(), 'node_modules', '.bin');

execFileSync(process.execPath, [prismaBin, 'generate', '--schema', SCHEMA_PATH], {
  stdio: 'inherit',
  env: { ...process.env, PATH: `${binDir}${delimiter}${process.env.PATH ?? ''}` },
});
