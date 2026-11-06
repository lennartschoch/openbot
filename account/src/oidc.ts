// Authelia OIDC relying-party helpers. Authorization code + PKCE, then verify the ID token.

import { createRemoteJWKSet, jwtVerify, type JWTPayload } from "jose";

export interface OidcMetadata {
  issuer: string;
  authorizationEndpoint: string;
  tokenEndpoint: string;
  jwksUri: string;
}

const discovered = new Map<string, Promise<OidcMetadata>>();

export async function discover(issuer: string): Promise<OidcMetadata> {
  const cached = discovered.get(issuer);
  if (cached) return await cached;
  const promise = (async () => {
    const url = new URL("/.well-known/openid-configuration", issuer);
    const response = await fetch(url, {
      headers: { Accept: "application/json" },
      signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) throw new Error(`OIDC discovery failed (${response.status}) at ${url}.`);
    const doc = (await response.json()) as Record<string, unknown>;
    const issuerValue = doc.issuer;
    const authorizationEndpoint = doc.authorization_endpoint;
    const tokenEndpoint = doc.token_endpoint;
    const jwksUri = doc.jwks_uri;
    if (
      typeof issuerValue !== "string" ||
      typeof authorizationEndpoint !== "string" ||
      typeof tokenEndpoint !== "string" ||
      typeof jwksUri !== "string"
    ) {
      throw new Error("OIDC discovery document is incomplete.");
    }
    return { issuer: issuerValue, authorizationEndpoint, tokenEndpoint, jwksUri };
  })();
  discovered.set(issuer, promise);
  promise.catch(() => discovered.delete(issuer));
  return await promise;
}

export function authorizationUrl(
  metadata: OidcMetadata,
  input: {
    clientId: string;
    redirectUri: string;
    state: string;
    nonce: string;
    codeChallenge: string;
    loginHint?: string;
  },
): string {
  const url = new URL(metadata.authorizationEndpoint);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("client_id", input.clientId);
  url.searchParams.set("redirect_uri", input.redirectUri);
  url.searchParams.set("scope", "openid email profile");
  url.searchParams.set("state", input.state);
  url.searchParams.set("nonce", input.nonce);
  url.searchParams.set("code_challenge", input.codeChallenge);
  url.searchParams.set("code_challenge_method", "S256");
  if (input.loginHint) url.searchParams.set("login_hint", input.loginHint);
  return url.toString();
}

export interface OidcIdentity {
  subject: string;
  email: string;
  emailVerified: boolean;
  name: string | null;
}

export async function redeemCode(
  metadata: OidcMetadata,
  input: {
    clientId: string;
    clientSecret: string;
    code: string;
    codeVerifier: string;
    redirectUri: string;
    nonce: string;
  },
): Promise<OidcIdentity> {
  const body = new URLSearchParams({
    grant_type: "authorization_code",
    code: input.code,
    redirect_uri: input.redirectUri,
    code_verifier: input.codeVerifier,
    client_id: input.clientId,
  });
  const headers: Record<string, string> = {
    "Content-Type": "application/x-www-form-urlencoded",
    Accept: "application/json",
  };
  if (input.clientSecret) {
    headers.Authorization = `Basic ${Buffer.from(`${input.clientId}:${input.clientSecret}`).toString("base64")}`;
  }
  const response = await fetch(metadata.tokenEndpoint, {
    method: "POST",
    headers,
    body,
    signal: AbortSignal.timeout(10_000),
  });
  if (!response.ok) throw new Error(`OIDC token exchange failed (${response.status}).`);
  const tokens = (await response.json()) as Record<string, unknown>;
  const idToken = tokens.id_token;
  if (typeof idToken !== "string") throw new Error("OIDC token response has no id_token.");

  const jwks = createRemoteJWKSet(new URL(metadata.jwksUri));
  const { payload } = await jwtVerify(idToken, jwks, {
    issuer: metadata.issuer,
    audience: input.clientId,
  });
  return readIdentity(payload, input.nonce);
}

function readIdentity(payload: JWTPayload, nonce: string): OidcIdentity {
  if (typeof payload.nonce === "string" && payload.nonce !== nonce) {
    throw new Error("OIDC ID token nonce does not match.");
  }
  const email = typeof payload.email === "string" ? payload.email.trim().toLowerCase() : "";
  if (!email) throw new Error("OIDC ID token has no email claim.");
  const emailVerified = payload.email_verified !== false;
  const subject = typeof payload.sub === "string" ? payload.sub : "";
  if (!subject) throw new Error("OIDC ID token has no subject.");
  const name = typeof payload.name === "string" ? payload.name : null;
  return { subject, email, emailVerified, name };
}
