// The chat drivers this build can run: the run command picks an installation's default one
// (`orch slack`, `orch teams`, `orch web`), `CHAT_SURFACES` adds others beside it (surfaces.ts).

export const CHAT_DRIVERS = ['slack', 'teams', 'web'] as const;
export type ChatDriverName = (typeof CHAT_DRIVERS)[number];

// The CLI's answer to an unknown command: the usual error plus the run modes, so `orch teams`
// on a build without that driver says what IS available instead of a bare "unknown command".
export function unknownCommandText(name: string): string {
  return (
    `error: unknown command '${name}'\n` +
    `Chat drivers in this build: ${CHAT_DRIVERS.map((d) => `${d} (\`orch ${d}\`)`).join(', ')}. See \`orch --help\` for every command.`
  );
}
