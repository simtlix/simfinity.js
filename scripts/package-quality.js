import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync, statSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path';

const require = createRequire(import.meta.url);
// The pinned checker exposes its library, but not its executable, via exports.
const packageCheckBin = resolve(dirname(require.resolve('@skypack/package-check')), '../index.bin.js');

/** Validate an extracted npm archive, including the files its metadata names. */
export const checkPackageQuality = (directory) => {
  const root = resolve(directory);
  const manifest = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8'));
  for (const file of ['README.md', 'LICENSE', manifest.main, manifest.types]) {
    assert(typeof file === 'string' && file.length > 0, `${manifest.name}: missing entry point`);
    const target = resolve(root, file);
    const path = relative(root, target);
    assert(path !== '..' && !path.startsWith(`..${sep}`) && !isAbsolute(path), `${manifest.name}: entry point outside archive: ${file}`);
    assert(statSync(target).isFile(), `${manifest.name}: missing file ${file}`);
  }
  try {
    execFileSync(process.execPath, [packageCheckBin, '--cwd', root], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch (error) {
    const detail = [error.stdout, error.stderr].filter(Boolean).join('\n').trim();
    throw new Error(`${manifest.name}: package quality check failed\n${detail}`, { cause: error });
  }
};
