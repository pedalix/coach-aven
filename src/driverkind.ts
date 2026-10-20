// Which sandbox driver a setting may name, and what the bot says when one names another (OpenSpec
// retire-daytona-driver). ssh-docker is the only driver since the Daytona driver was removed. A setting
// that still names Daytona — or anything else — is refused wherever it would move a project to another
// sandbox (D3, D4), never followed: a new sandbox starts empty, and the old one's worktrees, memory not
// yet journaled, Sail data and session files stay behind. A leftover that moves nothing only warns (D5).
// Pure and import-free, so the CLI probe, which must not load the bot's configuration module
// (cliprobe/imports.test.ts), refuses from the same words.

const REMOVED = 'but the Daytona sandbox driver was removed and "ssh-docker" is the only driver';
const MOVE_DOC = '(docs/sandbox-drivers.md → Moving a project to ssh-docker)';
const STAY = 'or keep running the last release that has the Daytona driver';

/** "a", "a and b", "a, b and c". */
const andList = (xs: readonly string[]): string => (xs.length < 2 ? xs.join('') : `${xs.slice(0, -1).join(', ')} and ${xs.at(-1)}`);

/**
 * Why `value` cannot be the driver that `setting` names — `SANDBOX_DRIVER`, or `project "<slug>" driver`.
 * For `daytona` it says the driver was removed and names both ways out: move the project by changing the
 * setting, or stay on the last release that has the driver. Anything else is a typo or a driver this
 * build does not have: the one accepted value is named.
 *
 * Only the CLI probe names `SANDBOX_DRIVER` here with `daytona` — the bot records that value as an old
 * default instead (D4) — and the probe requires the setting, so dropping it is no way out there: its
 * one fix is the value.
 */
export function driverRefusal(setting: string, value: unknown): string {
  if (value === 'daytona') {
    const fix = setting === 'SANDBOX_DRIVER' ? 'set SANDBOX_DRIVER=ssh-docker' : `to move the project, change that setting to "ssh-docker" or drop it ${MOVE_DOC}`;
    return `${setting} is "daytona", ${REMOVED} — ${fix}, ${STAY}`;
  }
  return `${setting} must be "ssh-docker", the only sandbox driver; got ${JSON.stringify(value)}`;
}

/**
 * The setting that made Daytona an installation's default driver before the removal (D4):
 * `SANDBOX_DRIVER=daytona`, or a non-empty `DAYTONA_API_URL` with `SANDBOX_DRIVER` unset or empty.
 */
export type DaytonaDefault = 'SANDBOX_DRIVER' | 'DAYTONA_API_URL';

/**
 * Why the projects without a `driver` field cannot load under such a default (D4): they were meant to run
 * on Daytona, and the new default would move them. All of them in one line — the usual fix, setting
 * SANDBOX_DRIVER=ssh-docker, covers them at once. That fix is read at the bot's next start, never by
 * `/aven reload` (it re-reads the projects configuration, not `.env`), so the line says to restart.
 */
export function daytonaDefaultRefusal(slugs: readonly string[], setting: DaytonaDefault): string {
  const one = slugs.length === 1;
  const which = one ? `project "${slugs[0]}" has` : `projects ${andList(slugs.map((s) => `"${s}"`))} have`;
  const how = setting === 'SANDBOX_DRIVER' ? 'SANDBOX_DRIVER=daytona' : 'DAYTONA_API_URL without SANDBOX_DRIVER';
  return `${which} no "driver", and ${how} made Daytona this installation's default, ${REMOVED} — to move ${one ? 'it' : 'them'}, give ${one ? 'it' : 'each'} "driver": "ssh-docker" or set SANDBOX_DRIVER=ssh-docker and restart ${MOVE_DOC}, ${STAY}`;
}

/** Read only by the Daytona driver, besides every DAYTONA_* variable: the snapshot's name and size. */
const DAYTONA_ONLY = ['SNAPSHOT_NAME', 'SANDBOX_CPU', 'SANDBOX_MEMORY', 'SANDBOX_DISK'] as const;

/**
 * The boot warning for leftover Daytona settings (D5), naming every one set to a non-empty value, or
 * undefined: each DAYTONA_* variable — the bot read three, the SDK more straight from the environment,
 * DAYTONA_TARGET among them — SNAPSHOT_NAME, SANDBOX_CPU, SANDBOX_MEMORY, SANDBOX_DISK, and
 * SANDBOX_DRIVER=daytona, whose advice is to set ssh-docker. They change nothing, except the refusal of a
 * project an old default would move (daytonaDefaultRefusal) — which is why the boot logs this line only
 * once the projects configuration has loaded: a refused boot prints the refusal alone, never "changes
 * nothing — remove it" for the setting that caused it (deleting it would move the projects without a
 * word). SANDBOX_AUTOSTOP_MINUTES is not one: since OpenSpec sandbox-idle-stop it sets ssh-docker's idle
 * stop, and the warning never names it.
 */
export function retiredDaytonaWarning(env: Record<string, string | undefined>): string | undefined {
  const driver = env.SANDBOX_DRIVER === 'daytona';
  const remove = [...Object.keys(env).filter((k) => k.startsWith('DAYTONA_') && env[k]).sort(), ...DAYTONA_ONLY.filter((k) => env[k])];
  const named = [...(driver ? ['SANDBOX_DRIVER=daytona'] : []), ...remove];
  if (!named.length) return undefined;
  const one = named.length === 1;
  const advice = driver
    ? `set SANDBOX_DRIVER=ssh-docker${remove.length ? `, and remove ${andList(remove)}` : ''}`
    : `remove ${one ? 'it' : 'them'}`;
  return `config: ${andList(named)} ${one ? 'is' : 'are'} retired with the Daytona sandbox driver and change${one ? 's' : ''} nothing — ${advice}`;
}
