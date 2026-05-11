/**
 * Custom OAuth 2.1 server — confidential clients only (non-PKCE).
 *
 * Supported grants:
 *   authorization_code  – client_secret_basic / client_secret_post, no PKCE
 *   client_credentials  – client_secret_basic / client_secret_post
 *   refresh_token       – rotates both access and refresh tokens
 *
 * Configure via environment:
 *   OAUTH_CLIENTS          JSON array: [{id,secret,redirectUris[],name?}]
 *   -- OR single-client shorthand --
 *   OAUTH_CLIENT_ID        client identifier
 *   OAUTH_CLIENT_SECRET    client secret
 *   OAUTH_REDIRECT_URIS    comma-separated redirect URIs
 *   OAUTH_CLIENT_NAME      human-readable name (optional)
 *
 *   OAUTH_ACCESS_TOKEN_TTL   seconds (default 3600)
 *   OAUTH_AUTH_CODE_TTL      seconds (default 60)
 *   OAUTH_REFRESH_TOKEN_TTL  seconds (default 2592000 / 30 days)
 *
 * Auth is disabled (all requests pass) when no clients are configured.
 */

import crypto from "crypto";
import http from "http";

// ── Client registry ────────────────────────────────────────────────────────────

interface OAuthClient {
  id: string;
  secret: string;
  redirectUris: string[];
  name: string;
}

function loadClients(): OAuthClient[] {
  if (process.env.OAUTH_CLIENTS) {
    try {
      return JSON.parse(process.env.OAUTH_CLIENTS) as OAuthClient[];
    } catch {
      console.error("[auth] OAUTH_CLIENTS is not valid JSON — ignoring");
    }
  }
  if (process.env.OAUTH_CLIENT_ID && process.env.OAUTH_CLIENT_SECRET) {
    return [{
      id:           process.env.OAUTH_CLIENT_ID,
      secret:       process.env.OAUTH_CLIENT_SECRET,
      redirectUris: (process.env.OAUTH_REDIRECT_URIS ?? "").split(",").map((s) => s.trim()).filter(Boolean),
      name:         process.env.OAUTH_CLIENT_NAME ?? "MCP Client",
    }];
  }
  return [];
}

const clients = loadClients();
const ACCESS_TOKEN_TTL  = parseInt(process.env.OAUTH_ACCESS_TOKEN_TTL  ?? "3600",    10);
const AUTH_CODE_TTL     = parseInt(process.env.OAUTH_AUTH_CODE_TTL     ?? "60",      10);
const REFRESH_TOKEN_TTL = parseInt(process.env.OAUTH_REFRESH_TOKEN_TTL ?? "2592000", 10);

// ── In-memory stores ───────────────────────────────────────────────────────────

interface AuthCode    { clientId: string; redirectUri: string; scope: string; expiresAt: number }
interface TokenEntry  { clientId: string; scope: string;       expiresAt: number }

const authCodes     = new Map<string, AuthCode>();
const accessTokens  = new Map<string, TokenEntry>();
const refreshTokens = new Map<string, TokenEntry>();

const gen = (): string => crypto.randomBytes(32).toString("base64url");

// ── Client helpers ─────────────────────────────────────────────────────────────

function findClient(id: string): OAuthClient | undefined {
  return clients.find((c) => c.id === id);
}

function verifyClient(id: string, secret: string): OAuthClient | undefined {
  const client = findClient(id);
  if (!client) return undefined;
  const a = Buffer.from(client.secret);
  const b = Buffer.from(secret);
  if (a.length !== b.length) return undefined;
  return crypto.timingSafeEqual(a, b) ? client : undefined;
}

function extractCreds(req: http.IncomingMessage, body: URLSearchParams): [string | null, string | null] {
  const basic = req.headers.authorization ?? "";
  if (basic.startsWith("Basic ")) {
    const decoded = Buffer.from(basic.slice(6), "base64").toString();
    const cut = decoded.indexOf(":");
    if (cut !== -1) return [decoded.slice(0, cut), decoded.slice(cut + 1)];
  }
  return [body.get("client_id"), body.get("client_secret")];
}

// ── Helpers ────────────────────────────────────────────────────────────────────

function readBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let data = "";
    req.on("data", (chunk) => { data += chunk; });
    req.on("end",  () => resolve(data));
    req.on("error", reject);
  });
}

function errJson(res: http.ServerResponse, status: number, error: string, description?: string): void {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ error, ...(description ? { error_description: description } : {}) }));
}

// ── GET /.well-known/oauth-authorization-server ────────────────────────────────

export function handleMetadata(_req: http.IncomingMessage, res: http.ServerResponse, baseUrl: string): void {
  res.writeHead(200, { "Content-Type": "application/json" });
  res.end(JSON.stringify({
    issuer:                                baseUrl,
    authorization_endpoint:                `${baseUrl}/authorize`,
    token_endpoint:                        `${baseUrl}/token`,
    revocation_endpoint:                   `${baseUrl}/revoke`,
    token_endpoint_auth_methods_supported: ["client_secret_basic", "client_secret_post"],
    grant_types_supported:                 ["authorization_code", "client_credentials", "refresh_token"],
    response_types_supported:              ["code"],
    scopes_supported:                      ["mcp"],
    // Non-PKCE: explicitly empty — PKCE parameters are rejected
    code_challenge_methods_supported:      [] as string[],
  }));
}

// ── GET /authorize ─────────────────────────────────────────────────────────────
// Validates the client + redirect URI, then immediately issues an auth code
// (confidential clients are pre-trusted; no interactive consent page needed).

export function handleAuthorize(req: http.IncomingMessage, res: http.ServerResponse): void {
  const url = new URL(req.url ?? "/", "http://localhost");
  const p   = url.searchParams;

  // PKCE rejection
  if (p.has("code_challenge")) {
    errJson(res, 400, "invalid_request", "PKCE (code_challenge) is not supported — use a confidential client with client_secret");
    return;
  }

  if (p.get("response_type") !== "code") {
    errJson(res, 400, "unsupported_response_type", "Only response_type=code is supported");
    return;
  }

  const clientId    = p.get("client_id");
  const redirectUri = p.get("redirect_uri");
  const state       = p.get("state") ?? "";
  const scope       = p.get("scope") ?? "mcp";

  if (!clientId) { errJson(res, 400, "invalid_request", "client_id is required"); return; }

  const client = findClient(clientId);
  if (!client)  { errJson(res, 400, "invalid_client",  "Unknown client_id");      return; }

  const effectiveRedirect = redirectUri ?? client.redirectUris[0];
  if (!effectiveRedirect || !client.redirectUris.includes(effectiveRedirect)) {
    errJson(res, 400, "invalid_request", "redirect_uri is not registered for this client");
    return;
  }

  const code = gen();
  authCodes.set(code, { clientId, redirectUri: effectiveRedirect, scope, expiresAt: Date.now() + AUTH_CODE_TTL * 1_000 });

  const dest = new URL(effectiveRedirect);
  dest.searchParams.set("code", code);
  if (state) dest.searchParams.set("state", state);

  res.writeHead(302, { Location: dest.toString() });
  res.end();
}

// ── POST /token ────────────────────────────────────────────────────────────────

export async function handleToken(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
  const body = await readBody(req);
  const p    = new URLSearchParams(body);

  // PKCE rejection
  if (p.has("code_verifier")) {
    errJson(res, 400, "invalid_request", "PKCE (code_verifier) is not supported");
    return;
  }

  const [clientId, clientSecret] = extractCreds(req, p);
  if (!clientId || !clientSecret) {
    errJson(res, 401, "invalid_client", "Client credentials are required (client_secret_basic or client_secret_post)");
    return;
  }

  const client = verifyClient(clientId, clientSecret);
  if (!client) { errJson(res, 401, "invalid_client", "Invalid client credentials"); return; }

  const grantType = p.get("grant_type");
  const noStore   = { "Content-Type": "application/json", "Cache-Control": "no-store" };

  // ── authorization_code ──────────────────────────────────────────────────────
  if (grantType === "authorization_code") {
    const code        = p.get("code");
    const redirectUri = p.get("redirect_uri");
    if (!code) { errJson(res, 400, "invalid_request", "code is required"); return; }

    const stored = authCodes.get(code);
    authCodes.delete(code);                                    // single-use

    if (!stored || Date.now() > stored.expiresAt) {
      errJson(res, 400, "invalid_grant", "Authorization code is invalid or expired"); return;
    }
    if (stored.clientId !== clientId) {
      errJson(res, 400, "invalid_grant", "Code was not issued to this client"); return;
    }
    if (redirectUri && redirectUri !== stored.redirectUri) {
      errJson(res, 400, "invalid_grant", "redirect_uri mismatch"); return;
    }

    const at = gen(), rt = gen();
    accessTokens.set(at,  { clientId, scope: stored.scope, expiresAt: Date.now() + ACCESS_TOKEN_TTL  * 1_000 });
    refreshTokens.set(rt, { clientId, scope: stored.scope, expiresAt: Date.now() + REFRESH_TOKEN_TTL * 1_000 });

    res.writeHead(200, noStore);
    res.end(JSON.stringify({ access_token: at, token_type: "Bearer", expires_in: ACCESS_TOKEN_TTL, refresh_token: rt, scope: stored.scope }));
    return;
  }

  // ── client_credentials ──────────────────────────────────────────────────────
  if (grantType === "client_credentials") {
    const scope = p.get("scope") ?? "mcp";
    const at    = gen();
    accessTokens.set(at, { clientId, scope, expiresAt: Date.now() + ACCESS_TOKEN_TTL * 1_000 });

    res.writeHead(200, noStore);
    res.end(JSON.stringify({ access_token: at, token_type: "Bearer", expires_in: ACCESS_TOKEN_TTL, scope }));
    return;
  }

  // ── refresh_token ───────────────────────────────────────────────────────────
  if (grantType === "refresh_token") {
    const rtValue = p.get("refresh_token");
    if (!rtValue) { errJson(res, 400, "invalid_request", "refresh_token is required"); return; }

    const stored = refreshTokens.get(rtValue);
    refreshTokens.delete(rtValue);                             // rotate on use

    if (!stored || Date.now() > stored.expiresAt) {
      errJson(res, 400, "invalid_grant", "Refresh token is invalid or expired"); return;
    }
    if (stored.clientId !== clientId) {
      errJson(res, 400, "invalid_grant", "Refresh token was not issued to this client"); return;
    }

    const at = gen(), rt = gen();
    accessTokens.set(at,  { clientId, scope: stored.scope, expiresAt: Date.now() + ACCESS_TOKEN_TTL  * 1_000 });
    refreshTokens.set(rt, { clientId, scope: stored.scope, expiresAt: Date.now() + REFRESH_TOKEN_TTL * 1_000 });

    res.writeHead(200, noStore);
    res.end(JSON.stringify({ access_token: at, token_type: "Bearer", expires_in: ACCESS_TOKEN_TTL, refresh_token: rt, scope: stored.scope }));
    return;
  }

  errJson(res, 400, "unsupported_grant_type");
}

// ── POST /revoke (RFC 7009) ────────────────────────────────────────────────────

export async function handleRevoke(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
  const body  = await readBody(req);
  const token = new URLSearchParams(body).get("token");
  if (token) { accessTokens.delete(token); refreshTokens.delete(token); }
  res.writeHead(200, { "Content-Type": "application/json" });
  res.end("{}");
}

// ── Bearer token middleware ────────────────────────────────────────────────────
// Returns true when the request carries a valid access token, or when no
// clients are configured (auth disabled).

export function authorised(req: http.IncomingMessage): boolean {
  if (clients.length === 0) return true;
  const header = req.headers.authorization ?? "";
  if (!header.startsWith("Bearer ")) return false;
  const token  = header.slice(7);
  const stored = accessTokens.get(token);
  if (!stored) return false;
  if (Date.now() > stored.expiresAt) { accessTokens.delete(token); return false; }
  return true;
}
