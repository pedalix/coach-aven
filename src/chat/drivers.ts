// The chat drivers this build can run — one per installation, chosen by the run command
// (`orch slack`, `orch teams`). A deferred driver (web) is simply absent until it exists.

export const CHAT_DRIVERS = ['slack', 'teams'] as const;
export type ChatDriverName = (typeof CHAT_DRIVERS)[number];

// The CLI's answer to an unknown command: the usual error plus the run modes, so `orch teams`
// on a build without that driver says what IS available instead of a bare "unknown command".
export function unknownCommandText(name: string): string {
  return (
    `error: unknown command '${name}'\n` +
    `Chat drivers in this build: ${CHAT_DRIVERS.map((d) => `${d} (\`orch ${d}\`)`).join(', ')}. See \`orch --help\` for every command.`
  );
}
