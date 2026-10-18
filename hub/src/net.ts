// What the claim limit counts in (OpenSpec `hub-open-network`, design N1): an IPv4 address, or an IPv6
// address's /64. A subscriber usually gets a whole /64 and can rotate through it at will, so counting
// full IPv6 addresses would make the limit no limit.
export function claimBucket(ip: string): string {
  const bare = ip.trim().toLowerCase().replace(/%.*$/, ''); // no zone index
  if (!bare.includes(':')) return bare;
  const dotted = /(\d{1,3}(?:\.\d{1,3}){3})$/.exec(bare);
  if (dotted) return dotted[1]!; // IPv4-mapped or -embedded: the IPv4 address it carries
  const halves = bare.split('::');
  if (halves.length > 2) return bare;
  const head = halves[0] ? halves[0].split(':') : [];
  const tail = halves.length === 2 && halves[1] ? halves[1].split(':') : [];
  const missing = 8 - head.length - tail.length;
  if (missing < 0 || (halves.length === 1 && missing !== 0)) return bare;
  const groups = [...head, ...Array<string>(missing).fill('0'), ...tail];
  if (!groups.every((g) => /^[0-9a-f]{1,4}$/.test(g))) return bare;
  return `${groups.slice(0, 4).map((g) => parseInt(g, 16).toString(16)).join(':')}::/64`;
}
