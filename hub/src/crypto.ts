// The hub's only crypto: Ed25519 verification of the challenge (WebCrypto, as workerd provides it). It
// never decrypts an envelope and never holds a private key.
export const b64uToBytes = (s: string): Uint8Array => {
  const b64 = s.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((s.length + 3) % 4);
  return Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
};
export const bytesToB64u = (b: Uint8Array): string => btoa(String.fromCharCode(...b)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

/** A fresh challenge nonce: 32 random bytes. */
export const randomNonce = (): string => bytesToB64u(crypto.getRandomValues(new Uint8Array(32)));

export async function verifyEd25519(publicKey: string, data: string, signature: string): Promise<boolean> {
  try {
    const key = await crypto.subtle.importKey('raw', b64uToBytes(publicKey), { name: 'Ed25519' }, false, ['verify']);
    return await crypto.subtle.verify('Ed25519', key, b64uToBytes(signature), new TextEncoder().encode(data));
  } catch {
    return false;
  }
}
