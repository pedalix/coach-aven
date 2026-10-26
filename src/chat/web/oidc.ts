// The OIDC round trip over openid-client (web-chat-driver D3): authorization code + PKCE against the
// issuer the installation names, with state and nonce checked on the way back. Discovery runs once,
// lazily, and a failure to reach the issuer is the boot's to report (app.ts warms it up at start).
// The ONLY module that imports openid-client (src/chat/imports.test.ts).

import * as oc from 'openid-client';
import type { Identity, Oidc } from './auth.js';

export interface OidcSettings {
  issuer: string;
  clientId: string;
  clientSecret: string;
  groupsClaim: string; // the claim that lists a person's groups (`cognito:groups`, `groups`, …)
}

export const pkce = {
  verifier: (): string => oc.randomPKCECodeVerifier(),
  challenge: (verifier: string): Promise<string> => oc.calculatePKCECodeChallenge(verifier),
  state: (): string => oc.randomState(),
  nonce: (): string => oc.randomNonce(),
};

export function createOidc(s: OidcSettings): Oidc & { warmup(): Promise<void> } {
  let config: Promise<oc.Configuration> | undefined;
  const configuration = () => (config ??= oc.discovery(new URL(s.issuer), s.clientId, s.clientSecret).catch((e) => {
    config = undefined; // the next request tries discovery again
    throw new Error(`OIDC discovery at ${s.issuer} failed: ${e instanceof Error ? e.message : String(e)}`);
  }));
  return {
    warmup: async () => {
      await configuration();
    },
    async authorizationUrl(p) {
      const c = await configuration();
      return oc.buildAuthorizationUrl(c, {
        redirect_uri: p.redirectUri,
        scope: 'openid email profile',
        state: p.state,
        nonce: p.nonce,
        code_challenge: p.codeChallenge,
        code_challenge_method: 'S256',
      });
    },
    async endSessionUrl({ postLogoutRedirectUri }) {
      const c = await configuration();
      const endpoint = c.serverMetadata().end_session_endpoint;
      if (!endpoint) return undefined;
      const url = new URL(endpoint);
      // Cognito's hosted UI takes `client_id` + `logout_uri` (a registered logout URL); everyone else the
      // RP-initiated-logout names, `post_logout_redirect_uri` with the client id (no id_token_hint: we keep no token).
      if (url.hostname.endsWith('.amazoncognito.com')) {
        url.searchParams.set('client_id', s.clientId);
        url.searchParams.set('logout_uri', postLogoutRedirectUri);
      } else {
        url.searchParams.set('client_id', s.clientId);
        url.searchParams.set('post_logout_redirect_uri', postLogoutRedirectUri);
      }
      return url;
    },
    async callback(currentUrl, checks) {
      const c = await configuration();
      const tokens = await oc.authorizationCodeGrant(c, currentUrl, { pkceCodeVerifier: checks.codeVerifier, expectedState: checks.state, expectedNonce: checks.nonce, idTokenExpected: true });
      const claims = tokens.claims();
      if (!claims?.sub) throw new Error('OIDC: the ID token carries no subject');
      const groups = claims[s.groupsClaim];
      const id: Identity = {
        sub: claims.sub,
        groups: Array.isArray(groups) ? groups.map(String) : typeof groups === 'string' ? groups.split(/[,\s]+/).filter(Boolean) : [],
      };
      if (typeof claims.name === 'string' && claims.name) id.name = claims.name;
      else if (typeof claims.given_name === 'string' || typeof claims.family_name === 'string') id.name = [claims.given_name, claims.family_name].filter((x) => typeof x === 'string' && x).join(' ');
      if (typeof claims.email === 'string' && claims.email) id.email = claims.email;
      return id;
    },
  };
}
