// The declarations a recording is checked against (design D5): `sdk.d.ts` of the Claude Agent SDK
// release that names the probed CLI version (`claudeCodeVersion` in its manifest — present in the full
// registry document only, not the abbreviated one), else the nearest lower release. The package is
// proprietary and lists the CLI's platform binaries as optional dependencies, so it is never installed
// nor committed: `npm pack` fetches the tarball alone into the probe's cache. The message-content types
// it imports come from `@anthropic-ai/sdk` as it stood when that release was published (its peer range is
// open-ended, and the newest API types describe fields a months-old CLI never writes); the report names
// both versions and `check` reuses them.
import { execFile } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { compareVersions, isValidCliVersion } from '../cliversion.js';

export const SDK_PACKAGE = '@anthropic-ai/claude-agent-sdk';
export const API_SDK_PACKAGE = '@anthropic-ai/sdk';
const REGISTRY = 'https://registry.npmjs.org';

export interface SdkChoice {
  release: string;
  claudeCodeVersion: string;
  exact: boolean;
}

interface Packument {
  versions?: Record<string, { claudeCodeVersion?: unknown }>;
  /** Publish time of every release (ISO). */
  time?: Record<string, string>;
}

const plainRelease = (v: string): boolean => /^\d+\.\d+\.\d+$/.test(v);

/** Pure: the release that names `cli`, else the nearest lower one; throws when none is at or below. */
export function chooseSdkRelease(cli: string, doc: Packument): SdkChoice {
  const named: { release: string; ccv: string }[] = [];
  for (const [release, m] of Object.entries(doc.versions ?? {})) {
    const ccv = m?.claudeCodeVersion;
    if (plainRelease(release) && typeof ccv === 'string' && isValidCliVersion(ccv)) named.push({ release, ccv });
  }
  const atOrBelow = named.filter((n) => compareVersions(n.ccv, cli) <= 0);
  if (!atOrBelow.length) throw new Error(`no ${SDK_PACKAGE} release names Claude Code ${cli} or an older version`);
  atOrBelow.sort((a, b) => compareVersions(b.ccv, a.ccv) || compareVersions(b.release, a.release));
  const best = atOrBelow[0]!;
  return { release: best.release, claudeCodeVersion: best.ccv, exact: best.ccv === cli };
}

/** Pure: the newest plain release of a package published at or before `at` (ISO time). */
export function releaseAt(doc: Packument, at: string): string {
  const times = doc.time ?? {};
  const found = Object.keys(doc.versions ?? {})
    .filter((v) => plainRelease(v) && times[v] !== undefined && times[v]! <= at)
    .sort((a, b) => (times[a]! < times[b]! ? -1 : times[a]! > times[b]! ? 1 : compareVersions(a, b)));
  if (!found.length) throw new Error(`no release published at or before ${at}`);
  return found.at(-1)!;
}

/** Pure: when a release was published. */
export function publishedAt(doc: Packument, release: string): string {
  const t = doc.time?.[release];
  if (!t) throw new Error(`the registry document has no publish time for ${release}`);
  return t;
}

const pkgUrl = (name: string): string => `${REGISTRY}/${name.replace('/', '%2f')}`;

/** The FULL registry document (it carries every release's manifest, `claudeCodeVersion` included). */
export async function fetchPackument(name: string, fetchFn: typeof fetch = fetch): Promise<Packument> {
  const res = await fetchFn(pkgUrl(name), { headers: { accept: 'application/json' }, signal: AbortSignal.timeout(60_000) });
  if (!res.ok) throw new Error(`registry ${name}: HTTP ${res.status}`);
  return (await res.json()) as Packument;
}

/** The `latest` dist-tag. */
export async function latestVersion(name: string, fetchFn: typeof fetch = fetch): Promise<string> {
  const res = await fetchFn(`${REGISTRY}/-/package/${name}/dist-tags`, { signal: AbortSignal.timeout(30_000) });
  if (!res.ok) throw new Error(`registry ${name} dist-tags: HTTP ${res.status}`);
  const tags = (await res.json()) as Record<string, string>;
  if (!tags.latest) throw new Error(`registry ${name}: no latest tag`);
  return tags.latest;
}

export type Run = (file: string, args: readonly string[], cwd?: string) => Promise<string>;
const runNode: Run = (file, args, cwd) =>
  new Promise((resolve, reject) =>
    execFile(file, [...args], { cwd, maxBuffer: 64 * 1024 * 1024 }, (err, out, stderr) =>
      err ? reject(new Error(`${file} ${args.join(' ')}: ${String(stderr).slice(-400) || err.message}`)) : resolve(String(out)),
    ),
  );

/** `npm pack` one package version and unpack it at `dest` (no install, no dependencies). */
async function packInto(spec: string, dest: string, run: Run): Promise<void> {
  const tmp = mkdtempSync(join(dest, '..', '.pack-'));
  try {
    const out = await run('npm', ['pack', spec, '--json', '--pack-destination', tmp]);
    const file = (JSON.parse(out) as { filename: string }[])[0]?.filename;
    if (!file) throw new Error(`npm pack ${spec}: no tarball`);
    mkdirSync(dest, { recursive: true });
    await run('tar', ['-xzf', join(tmp, file.replace(/^@/, '').replace(/\//g, '-')), '-C', dest, '--strip-components=1']);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

/**
 * The declarations of `release` (with `@anthropic-ai/sdk` at `apiSdk`) unpacked under the cache, laid out
 * as a node_modules tree so the type imports resolve. Returns the root and the path of sdk.d.ts.
 */
export async function ensureDeclarations(o: { release: string; apiSdk: string; cacheRoot: string; run?: Run }): Promise<{ root: string; sdkDts: string }> {
  const root = join(o.cacheRoot, 'sdk', `${o.release}+${o.apiSdk}`);
  const sdkDir = join(root, 'node_modules', '@anthropic-ai', 'claude-agent-sdk');
  const apiDir = join(root, 'node_modules', '@anthropic-ai', 'sdk');
  const run = o.run ?? runNode;
  mkdirSync(join(root, 'node_modules', '@anthropic-ai'), { recursive: true });
  if (!existsSync(join(sdkDir, 'sdk.d.ts'))) await packInto(`${SDK_PACKAGE}@${o.release}`, sdkDir, run);
  if (!existsSync(join(apiDir, 'package.json'))) await packInto(`${API_SDK_PACKAGE}@${o.apiSdk}`, apiDir, run);
  const sdkDts = join(sdkDir, 'sdk.d.ts');
  if (!existsSync(sdkDts)) throw new Error(`${SDK_PACKAGE}@${o.release} has no sdk.d.ts`);
  return { root, sdkDts };
}
