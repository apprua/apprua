// The version of Apprua, read from package.json (in the image, /app/package.json): the one place where it is written.
// Release numbers are set for every package at once with: npm version <x.y.z> --workspaces --include-workspace-root --no-git-tag-version
import { readFileSync } from 'node:fs';

function read(): string {
  try {
    return JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8')).version ?? '0.0.0';
  } catch { return '0.0.0'; }
}

export const VERSION: string = process.env.APPRUA_VERSION ?? read();

/** The version of Coolify this Apprua was tested with ("apprua.coolify" in the root package.json), passed by the
 *  installer; empty when unknown. */
export const COOLIFY_TESTED: string = process.env.APPRUA_COOLIFY_TESTED ?? '';
