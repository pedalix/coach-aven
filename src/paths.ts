// The installation directory (OpenSpec `installation-directory`, container-deploy D1): the ONE place an
// installation's configuration and state live — `.env`, the projects config, the mirror list, and every
// file the bot writes at runtime (state.json, queue.jsonl, usage/, drafts/, facts/, memory/, feedback/,
// events/, shadow/, data/, mirrors/). Named by `AVEN_DIR`; unset = the package root, which is where every
// unit and npm script runs today, so nothing moves until an installation sets it.
//
// Pure: the resolvers take the environment and are evaluated on first use, never at import time, so the
// order in which modules load cannot matter, and a test can point them anywhere. Only the release marker
// (`.release`) and the bot's own assets (fixtures, static files, workers) stay beside the code: they
// describe the code, not the installation — `src/paths.test.ts` guards the distinction.
import { isAbsolute, resolve } from 'node:path';

/** Where the code is: one level up from src/. The default installation directory, and the home of `.release`. */
export const PACKAGE_ROOT = new URL('../', import.meta.url).pathname.replace(/\/$/, '');

type Env = Record<string, string | undefined>;

/**
 * The installation directory: `AVEN_DIR` when set (absolute, or the boot stops in one sentence), else the
 * package root. The setting comes from the PROCESS environment: it says where `.env` is, so `.env` cannot
 * set it (config.ts checks that after loading the file).
 */
export function installDir(env: Env = process.env, packageRoot: string = PACKAGE_ROOT): string {
  const raw = (env.AVEN_DIR ?? '').trim();
  if (!raw) return packageRoot;
  if (!isAbsolute(raw)) throw new Error(`AVEN_DIR must be an absolute path (got '${raw}'): it names the installation directory, which cannot depend on where the process starts`);
  return resolve(raw);
}

/**
 * A path setting's value: an absolute path as it is, a relative one against the installation directory —
 * never against the working directory, which stops mattering (D1). `undefined` or empty → `undefined`.
 */
export function settingPath(value: string | undefined, env: Env = process.env): string | undefined {
  const v = (value ?? '').trim();
  if (!v) return undefined;
  return resolve(installDir(env), v);
}

/** `<installation directory>/<name>`, for the runtime files and directories below. */
export function installPath(name: string, env: Env = process.env): string {
  return resolve(installDir(env), name);
}

// The runtime paths, one resolver each — evaluated when a store is constructed, not when its module loads.
export const statePath = (env?: Env): string => installPath('state.json', env);
export const queuePath = (env?: Env): string => installPath('queue.jsonl', env);
export const usageDir = (env?: Env): string => installPath('usage', env);
export const draftsDir = (env?: Env): string => installPath('drafts', env);
export const factsDir = (env?: Env): string => installPath('facts', env);
export const feedbackDir = (env?: Env): string => installPath('feedback', env);
export const memoryDir = (env?: Env): string => installPath('memory', env);
export const eventsDir = (env?: Env): string => installPath('events', env);
export const shadowDir = (env?: Env): string => installPath('shadow', env);
export const mirrorsCacheDir = (env?: Env): string => installPath('mirrors', env);
/** The projects config default: `projects.config.json` in the installation directory (`PROJECTS_CONFIG_PATH` wins). */
export const projectsConfigDefault = (env?: Env): string => installPath('projects.config.json', env);
/** `data/` in the installation directory unless `AVEN_DATA_DIR` (absolute, or relative to the installation directory) says otherwise. */
export const dataRootDefault = (env: Env = process.env): string => settingPath(env.AVEN_DATA_DIR, env) ?? installPath('data', env);
/** The `.env` the bot loads: always the installation directory's. */
export const dotenvPath = (env?: Env): string => installPath('.env', env);
