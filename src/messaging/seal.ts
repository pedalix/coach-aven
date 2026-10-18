// End-to-end encryption between installations (OpenSpec `agent-messaging`, design D6), with
// `node:crypto` only. Each installation has an Ed25519 signing key and an X25519 encryption key
// (`orch hub keygen` → HUB_KEY_PATH, 0600); peers pin each other's public halves in hub.peers.json,
// as a list per peer with `notAfter`, so a rotation has a grace period.
//
// Sealing (version 2, `hub-open-network` design N5): a fresh ephemeral X25519 pair → ECDH with the
// recipient's key → HKDF-SHA256 (info binds the ephemeral key and the recipient's encryption key) →
// AES-256-GCM over the sealed content (agents, method, task, payload) with the clear header — version,
// envelope id, the two installations — as AAD (a ciphertext replayed under a new id does not open) → an
// Ed25519 signature over header + eph + ct. The receiver verifies the signature with the pinned keys of
// `from` before it decrypts. A name that changed hands on the hub is caught here: its new key fails the
// pin, and it cannot open what was sealed to the earlier key. The hub never decrypts and never
// distributes keys: a compromised hub can drop or delay envelopes, not read or forge them.
import { createCipheriv, createDecipheriv, createHash, createPrivateKey, createPublicKey, diffieHellman, generateKeyPairSync, hkdfSync, randomBytes, sign, verify, type KeyObject } from 'node:crypto';
import { challengeText, headerAad, kdfInfo, signingText, type WireEnvelope, type WireHeader } from './protocol.js';

/** A key pair as JWK base64url halves (`x` public, `d` private). */
export interface KeyHalves {
  public: string;
  private: string;
}
/** HUB_KEY_PATH: the installation's own keys, and the previous encryption keys still in their grace period. */
export interface KeyFile {
  v: 1;
  signing: KeyHalves;
  encryption: KeyHalves;
  previous?: { encryption: KeyHalves; notAfter: string }[];
}
/** One pinned key set of a peer (hub.peers.json): public halves, valid until `notAfter` when set. */
export interface PeerKey {
  sign: string;
  box: string;
  notAfter?: string;
}

const b64u = (b: Buffer): string => b.toString('base64url');
const unb64u = (s: string): Buffer => Buffer.from(s, 'base64url');
const pub = (crv: 'Ed25519' | 'X25519', x: string): KeyObject => createPublicKey({ key: { kty: 'OKP', crv, x }, format: 'jwk' });
const priv = (crv: 'Ed25519' | 'X25519', k: KeyHalves): KeyObject => createPrivateKey({ key: { kty: 'OKP', crv, x: k.public, d: k.private }, format: 'jwk' });
const halves = (p: { publicKey: KeyObject; privateKey: KeyObject }): KeyHalves => {
  const jwk = p.privateKey.export({ format: 'jwk' }) as { x: string; d: string };
  return { public: jwk.x, private: jwk.d };
};
const validAt = (notAfter: string | undefined, now: Date): boolean => notAfter === undefined || Date.parse(notAfter) > now.getTime();

/** A new installation key file. */
export function generateKeyFile(): KeyFile {
  return { v: 1, signing: halves(generateKeyPairSync('ed25519')), encryption: halves(generateKeyPairSync('x25519')) };
}

/** Short fingerprint of a public key, for logs and events (never the key itself). */
export const fingerprint = (publicHalf: string): string => createHash('sha256').update(publicHalf).digest('hex').slice(0, 8);

/** Seal `content` for `recipientBox` (the peer's X25519 public half), signed with the own signing key. */
export function seal(header: WireHeader, content: unknown, o: { signing: KeyHalves; recipientBox: string }): WireEnvelope {
  const eph = generateKeyPairSync('x25519');
  const ephPublic = (eph.publicKey.export({ format: 'jwk' }) as { x: string }).x;
  const shared = diffieHellman({ privateKey: eph.privateKey, publicKey: pub('X25519', o.recipientBox) });
  const key = Buffer.from(hkdfSync('sha256', shared, unb64u(ephPublic), Buffer.from(kdfInfo(ephPublic, o.recipientBox)), 32));
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  cipher.setAAD(Buffer.from(headerAad(header)));
  const body = Buffer.concat([cipher.update(JSON.stringify(content), 'utf8'), cipher.final()]);
  const unsigned = { v: header.v, id: header.id, from: header.from, to: header.to, eph: ephPublic, ct: b64u(Buffer.concat([iv, body, cipher.getAuthTag()])) };
  return { ...unsigned, sig: b64u(sign(null, Buffer.from(signingText(unsigned)), priv('Ed25519', o.signing))) };
}

export type Opened = { ok: true; content: unknown; signedBy: string } | { ok: false; reason: 'malformed' | 'bad_signature' | 'decrypt_failed' };

/**
 * Open an envelope: the signature first, against the sender's pinned keys valid at `now`; then the
 * own encryption keys in order (the current one, then the previous ones still in their grace period).
 */
export function open(env: WireEnvelope, o: { senderKeys: readonly PeerKey[]; own: KeyFile; now?: Date }): Opened {
  const now = o.now ?? new Date();
  if (!env.eph || !env.ct || !env.sig) return { ok: false, reason: 'malformed' };
  const data = Buffer.from(signingText(env));
  const sig = unb64u(env.sig);
  const signer = o.senderKeys.find((k) => {
    if (!validAt(k.notAfter, now)) return false;
    try {
      return verify(null, data, pub('Ed25519', k.sign), sig);
    } catch {
      return false;
    }
  });
  if (!signer) return { ok: false, reason: 'bad_signature' };
  const raw = unb64u(env.ct);
  if (raw.length < 12 + 16) return { ok: false, reason: 'malformed' };
  const iv = raw.subarray(0, 12);
  const tag = raw.subarray(raw.length - 16);
  const body = raw.subarray(12, raw.length - 16);
  const boxes = [o.own.encryption, ...(o.own.previous ?? []).filter((p) => validAt(p.notAfter, now)).map((p) => p.encryption)];
  for (const box of boxes) {
    try {
      const shared = diffieHellman({ privateKey: priv('X25519', box), publicKey: pub('X25519', env.eph) });
      const key = Buffer.from(hkdfSync('sha256', shared, unb64u(env.eph), Buffer.from(kdfInfo(env.eph, box.public)), 32));
      const decipher = createDecipheriv('aes-256-gcm', key, iv);
      decipher.setAAD(Buffer.from(headerAad(env)));
      decipher.setAuthTag(tag);
      const text = Buffer.concat([decipher.update(body), decipher.final()]).toString('utf8');
      return { ok: true, content: JSON.parse(text), signedBy: fingerprint(signer.sign) };
    } catch {
      /* the next key */
    }
  }
  return { ok: false, reason: 'decrypt_failed' };
}

/** The hub challenge answer (design D4, N2): Ed25519 over `coach-aven-hub/2|host|name|key|nonce`, with `key` the signer's own public half. */
export const signChallenge = (host: string, name: string, nonce: string, signing: KeyHalves): string =>
  b64u(sign(null, Buffer.from(challengeText(host, name, signing.public, nonce)), priv('Ed25519', signing)));

export const verifyChallenge = (host: string, name: string, nonce: string, sig: string, signPublic: string): boolean => {
  try {
    return verify(null, Buffer.from(challengeText(host, name, signPublic, nonce)), pub('Ed25519', signPublic), unb64u(sig));
  } catch {
    return false;
  }
};
