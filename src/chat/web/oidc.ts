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

/** The surface's identity from an ID token's claims (exported for the test; the callback above uses it). */
export function identityOf(claims: Record<string, unknown>, groupsClaim: string): Identity {
  const sub = typeof claims.sub === 'string' ? claims.sub : '';
  const groups = claims[groupsClaim];
  const id: Identity = { sub, groups: Array.isArray(groups) ? groups.map(String) : typeof groups === 'string' ? groups.split(/[,\s]+/).filter(Boolean) : [] };
  const str = (k: string) => (typeof claims[k] === 'string' && claims[k] ? (claims[k] as string) : undefined);
  // An address the provider says is unverified is not the person's: the allow-list and the operators list match on
  // e-mails, and a pool that lets people sign up or change their address would let anyone claim one (the security
  // review of 2026-10-30). A provider that sends no `email_verified` at all (e.g. Entra) keeps today's behaviour.
  const unverified = claims.email_verified === false || claims.email_verified === 'false';
  const email = unverified ? undefined : str('email');
  if (email) id.email = email;
  const names = [str('given_name'), str('family_name')].filter((x): x is string => !!x).join(' ');
  // The e-mail before Cognito's username: in a pool that signs people in by e-mail (`username_attributes = ["email"]`)
  // `cognito:username` is the subject's UUID — a person's handle only when it is something else (the staging canary
  // showed the UUID as the display name, 2026-10-26).
  const username = str('cognito:username');
  const name = str('name') ?? (names || undefined) ?? str('preferred_username') ?? email ?? (username && username !== sub ? username : undefined);
  if (name) id.name = name;
  return id;
}

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
      return identityOf(claims as Record<string, unknown>, s.groupsClaim);
    },
  };
}
