import { realpathSync } from 'node:fs';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Whether a module is the script Node was started with. Node runs the real path of the
 * entry it resolves (symlinks followed, `.js` found when omitted) but leaves argv[1] as
 * typed, so both sides are resolved before comparing. A relative entry is resolved
 * against the working directory, as Node does for a main script; under `-e`, `-p` or
 * stdin argv[1] is a plain argument and must not match a sibling of the module.
 * A missing or unresolvable entry means the module was imported.
 */
export const isEntryPoint = (moduleUrl, entry = process.argv[1]) => {
  if (!entry) return false;
  try {
    return realpathSync(createRequire(moduleUrl).resolve(resolve(entry))) === realpathSync(fileURLToPath(moduleUrl));
  } catch {
    return false;
  }
};
