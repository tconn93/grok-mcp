import https from "https";
import http from "http";

// Required: set GOOGLE_CLIENT_ID to enable auth. Unset → all requests pass.
const GOOGLE_CLIENT_ID  = process.env.GOOGLE_CLIENT_ID;
const ALLOWED_EMAILS    = process.env.GOOGLE_ALLOWED_EMAILS?.split(",").map((s) => s.trim()).filter(Boolean);
const ALLOWED_DOMAINS   = process.env.GOOGLE_ALLOWED_DOMAINS?.split(",").map((s) => s.trim()).filter(Boolean);

// Cache tokeninfo responses: token → { valid, expiresAt }
const cache = new Map<string, { valid: boolean; expiresAt: number }>();

interface TokenInfo {
  aud?: string;
  azp?: string;
  email?: string;
  email_verified?: string;
  exp?: string;
  error_description?: string;
}

function fetchTokenInfo(token: string): Promise<TokenInfo> {
  return new Promise((resolve, reject) => {
    const url = `https://www.googleapis.com/oauth2/v3/tokeninfo?access_token=${encodeURIComponent(token)}`;
    https.get(url, (res) => {
      let body = "";
      res.on("data", (chunk) => { body += chunk; });
      res.on("end", () => {
        try { resolve(JSON.parse(body)); }
        catch { reject(new Error("Bad JSON from tokeninfo")); }
      });
    }).on("error", reject);
  });
}

async function verifyGoogleToken(token: string): Promise<boolean> {
  const cached = cache.get(token);
  if (cached) {
    if (Date.now() < cached.expiresAt) return cached.valid;
    cache.delete(token);
  }

  let info: TokenInfo;
  try {
    info = await fetchTokenInfo(token);
  } catch {
    return false;
  }

  if (info.error_description) {
    cache.set(token, { valid: false, expiresAt: Date.now() + 60_000 });
    return false;
  }

  if (GOOGLE_CLIENT_ID && info.aud !== GOOGLE_CLIENT_ID && info.azp !== GOOGLE_CLIENT_ID) {
    cache.set(token, { valid: false, expiresAt: Date.now() + 60_000 });
    return false;
  }

  if (ALLOWED_EMAILS?.length && (!info.email || !ALLOWED_EMAILS.includes(info.email))) {
    cache.set(token, { valid: false, expiresAt: Date.now() + 60_000 });
    return false;
  }

  if (ALLOWED_DOMAINS?.length) {
    const domain = info.email?.split("@")[1];
    if (!domain || !ALLOWED_DOMAINS.includes(domain)) {
      cache.set(token, { valid: false, expiresAt: Date.now() + 60_000 });
      return false;
    }
  }

  const expiresAt = info.exp ? parseInt(info.exp, 10) * 1_000 : Date.now() + 3_600_000;
  cache.set(token, { valid: true, expiresAt });
  return true;
}

// ── Middleware ─────────────────────────────────────────────────────────────────
// Returns true when the request is authorised (or auth is disabled).
export async function authorised(req: http.IncomingMessage): Promise<boolean> {
  if (!GOOGLE_CLIENT_ID) return true;
  const header = req.headers.authorization ?? "";
  if (!header.startsWith("Bearer ")) return false;
  return verifyGoogleToken(header.slice(7));
}

// ── GET /.well-known/oauth-authorization-server ────────────────────────────────
// Points MCP clients at Google's OAuth endpoints.
// Explicitly omits code_challenge_methods_supported → non-PKCE only.
export function handleMetadata(
  _req: http.IncomingMessage,
  res: http.ServerResponse,
  baseUrl: string,
): void {
  res.writeHead(200, { "Content-Type": "application/json" });
  res.end(JSON.stringify({
    issuer:                                    "https://accounts.google.com",
    authorization_endpoint:                    "https://accounts.google.com/o/oauth2/v2/auth",
    token_endpoint:                            "https://oauth2.googleapis.com/token",
    userinfo_endpoint:                         "https://openidconnect.googleapis.com/v1/userinfo",
    jwks_uri:                                  "https://www.googleapis.com/oauth2/v3/certs",
    scopes_supported:                          ["openid", "email", "profile"],
    response_types_supported:                  ["code"],
    grant_types_supported:                     ["authorization_code"],
    token_endpoint_auth_methods_supported:     ["client_secret_basic", "client_secret_post"],
    code_challenge_methods_supported:          [] as string[],
    resource:                                  baseUrl,
    ...(GOOGLE_CLIENT_ID ? { client_id: GOOGLE_CLIENT_ID } : {}),
  }));
}
