// What the claim limit counts in (net.ts): IPv4 addresses as they are, IPv6 per /64.
import { describe, expect, it } from 'vitest';
import { claimBucket } from '../src/net.js';

describe('claimBucket', () => {
  it('IPv4 as it is; IPv6 per /64, however it is written; IPv4-mapped as its IPv4; anything else as it is', () => {
    expect(claimBucket('203.0.113.9')).toBe('203.0.113.9');
    expect(claimBucket('2001:db8:aa:bb::1')).toBe('2001:db8:aa:bb::/64');
    expect(claimBucket('2001:0DB8:00aa:00bb:ffff:ffff:ffff:9')).toBe('2001:db8:aa:bb::/64');
    expect(claimBucket('2001:db8::1')).toBe('2001:db8:0:0::/64');
    expect(claimBucket('::1')).toBe('0:0:0:0::/64');
    expect(claimBucket('fe80::1%eth0')).toBe('fe80:0:0:0::/64');
    expect(claimBucket('::ffff:198.51.100.7')).toBe('198.51.100.7');
    expect(claimBucket('unknown')).toBe('unknown');
    expect(claimBucket('1:2:3:4:5:6:7:8:9')).toBe('1:2:3:4:5:6:7:8:9');
  });
});
