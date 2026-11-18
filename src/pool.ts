// Run an async step over a list with at most `limit` steps in flight. Every step runs (a failure does not stop the
// others) and the call settles only when all have: a caller that throws never leaves steps running behind it. The
// first failure in LIST order is rethrown, so the error a caller sees does not depend on timing.
//
// Why a cap rather than all at once: each sandbox command over ssh-docker is its own SSH connection, and sshd's
// MaxStartups (default 10:30:100) starts dropping new connections past ten in their handshake — on a host that the
// pollers and other projects use at the same moment.
export async function eachLimit<T>(items: readonly T[], limit: number, step: (item: T, index: number) => Promise<unknown>): Promise<void> {
  const errors: { index: number; error: unknown }[] = [];
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const index = next++;
      try {
        await step(items[index], index);
      } catch (error) {
        errors.push({ index, error });
      }
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, worker));
  if (errors.length > 0) throw errors.sort((a, b) => a.index - b.index)[0].error;
}
