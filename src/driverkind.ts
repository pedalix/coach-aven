// Which sandbox driver a setting may name, and what the bot says when one names another (OpenSpec
// retire-daytona-driver). ssh-docker is the only driver since the Daytona driver was removed. A setting
// that still names Daytona — or anything else — is refused wherever it would move a project to another
// sandbox (D3, D4), never followed: a new sandbox starts empty, and the old one's worktrees, memory not
// yet journaled, Sail data and session files stay behind. Pure and import-free, so the CLI probe, which
// must not load the bot's configuration module (cliprobe/imports.test.ts), refuses in the bot's words.

const REMOVED = 'but the Daytona sandbox driver was removed and "ssh-docker" is the only driver';
const MOVE_DOC = '(docs/sandbox-drivers.md → Moving a project to ssh-docker)';
const STAY = 'or keep running the last release that has the Daytona driver';

/**
 * Why `value` cannot be the driver that `setting` names — `SANDBOX_DRIVER`, or `project "<slug>" driver`.
 * For `daytona` it says the driver was removed and names both ways out: move the project by changing the
 * setting, or stay on the last release that has the driver. Anything else is a typo or a driver this
 * build does not have: the one accepted value is named.
 */
export function driverRefusal(setting: string, value: unknown): string {
  if (value === 'daytona') {
    return `${setting} is "daytona", ${REMOVED} — to move the project, change that setting to "ssh-docker" or drop it ${MOVE_DOC}, ${STAY}`;
  }
  return `${setting} must be "ssh-docker", the only sandbox driver; got ${JSON.stringify(value)}`;
}
