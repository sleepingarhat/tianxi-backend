/**
 * Admin auth helpers.
 *
 * Two accepted credentials, validated by the admin route middleware:
 *   1. Session cookie `admin_session=<base64url(payload)>.<base64url(hmac)>`
 *      issued by the GitHub OAuth callback after verifying the user is in the
 *      ADMIN_GITHUB_USER allowlist. HMAC is keyed with SESSION_HMAC_SECRET.
 *   2. `Authorization: Bearer` matching ADMIN_TOKEN, kept for automation and
 *      emergency access without putting the credential in a URL.
 *
 * No KV / D1 storage required — the cookie is stateless and self-verifying.
 */

export interface SessionPayload {
  user: string;        // GitHub login
  iat: number;         // issued-at unix seconds
  exp: number;         // expiry unix seconds
}

export const ADMIN_AUTH_POLICY = {
  SESSION_OR_BEARER: 'session-or-bearer',
  BEARER_ONLY: 'bearer-only',
} as const;

export type AdminAuthPolicy = typeof ADMIN_AUTH_POLICY[keyof typeof ADMIN_AUTH_POLICY];

export interface AdminAuthEnv {
  ADMIN_TOKEN?: string;
  SESSION_HMAC_SECRET?: string;
  ADMIN_GITHUB_USER?: string;
}

interface AdminAuthRequest {
  header(name: string): string | undefined;
}

const SESSION_TTL_SECONDS = 7 * 24 * 60 * 60; // 7 days
export const SESSION_COOKIE = 'admin_session';

function b64urlEncode(buf: ArrayBuffer | Uint8Array): string {
  const bytes = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
  let bin = '';
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function b64urlDecode(s: string): Uint8Array {
  const pad = s.length % 4 === 0 ? '' : '='.repeat(4 - (s.length % 4));
  const b = atob(s.replace(/-/g, '+').replace(/_/g, '/') + pad);
  const out = new Uint8Array(b.length);
  for (let i = 0; i < b.length; i++) out[i] = b.charCodeAt(i);
  return out;
}

async function hmacKey(secret: string): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign', 'verify'],
  );
}

export async function signSession(payload: SessionPayload, secret: string): Promise<string> {
  const json = JSON.stringify(payload);
  const body = b64urlEncode(new TextEncoder().encode(json));
  const key = await hmacKey(secret);
  const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(body));
  return `${body}.${b64urlEncode(sig)}`;
}

export async function verifySession(token: string, secret: string): Promise<SessionPayload | null> {
  const parts = token.split('.');
  if (parts.length !== 2) return null;
  const [body, sig] = parts;
  const key = await hmacKey(secret);
  let ok = false;
  try {
    ok = await crypto.subtle.verify('HMAC', key, b64urlDecode(sig), new TextEncoder().encode(body));
  } catch { return null; }
  if (!ok) return null;
  let payload: SessionPayload;
  try { payload = JSON.parse(new TextDecoder().decode(b64urlDecode(body))); } catch { return null; }
  if (typeof payload.exp !== 'number' || payload.exp < Math.floor(Date.now() / 1000)) return null;
  return payload;
}

export function buildSessionCookie(value: string, ttlSeconds = SESSION_TTL_SECONDS): string {
  return `${SESSION_COOKIE}=${value}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${ttlSeconds}`;
}

export function clearSessionCookie(): string {
  return `${SESSION_COOKIE}=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0`;
}

export function readCookie(cookieHeader: string | undefined, name: string): string | null {
  if (!cookieHeader) return null;
  const parts = cookieHeader.split(/;\s*/);
  for (const p of parts) {
    const eq = p.indexOf('=');
    if (eq < 0) continue;
    if (p.slice(0, eq) === name) return decodeURIComponent(p.slice(eq + 1));
  }
  return null;
}

export const TOKEN_SESSION_USER = 'admin-token';

export function isAdminAllowlisted(env: AdminAuthEnv, login: string): boolean {
  const allowlist = String(env.ADMIN_GITHUB_USER || '')
    .split(',')
    .map((candidate) => candidate.trim())
    .filter(Boolean);
  return allowlist.includes(login);
}

export function sessionSigningSecret(env: AdminAuthEnv): string | undefined {
  return env.SESSION_HMAC_SECRET || env.ADMIN_TOKEN;
}

export async function issueAdminTokenSession(
  env: AdminAuthEnv,
  presented: string,
): Promise<string | null> {
  const expected = env.ADMIN_TOKEN;
  if (!expected || !presented || presented !== expected) return null;
  const secret = sessionSigningSecret(env);
  if (!secret) return null;
  return signSession(newSessionPayload(TOKEN_SESSION_USER), secret);
}

export async function readPresentedAdminSecret(request: Request): Promise<string> {
  const ct = request.headers.get('content-type') || '';
  if (ct.includes('application/x-www-form-urlencoded') || ct.includes('multipart/form-data')) {
    const form = await request.formData();
    return String(form.get('credential') || form.get('secret') || form.get('password') || '').trim();
  }
  if (ct.includes('application/json')) {
    const body = await request.json().catch(() => null) as Record<string, unknown> | null;
    const value = body?.credential ?? body?.secret ?? body?.password ?? '';
    return String(value || '').trim();
  }
  return '';
}

/**
 * The single credential guard for every admin surface.
 *
 * URL query parameters are deliberately not part of AdminAuthRequest, so neither
 * policy can ever treat a URL value as a credential.
 */
export async function hasAdminAccess(
  c: { env: AdminAuthEnv; req: AdminAuthRequest },
  policy: AdminAuthPolicy,
): Promise<boolean> {
  if (policy === ADMIN_AUTH_POLICY.SESSION_OR_BEARER) {
    const cookie = readCookie(c.req.header('cookie'), SESSION_COOKIE);
    const secret = sessionSigningSecret(c.env);
    if (cookie && secret) {
      const payload = await verifySession(cookie, secret);
      if (payload && (payload.user === TOKEN_SESSION_USER || isAdminAllowlisted(c.env, payload.user))) {
        return true;
      }
    }
  }

  const expected = c.env.ADMIN_TOKEN;
  if (!expected) return false;
  const header = c.req.header('authorization') || '';
  const bearer = header.startsWith('Bearer ') ? header.slice(7) : '';
  return bearer === expected;
}

export function buildAdminBearerHeaders(env: AdminAuthEnv): { authorization: string } | undefined {
  return env.ADMIN_TOKEN
    ? { authorization: `Bearer ${env.ADMIN_TOKEN}` }
    : undefined;
}

export function newSessionPayload(user: string): SessionPayload {
  const now = Math.floor(Date.now() / 1000);
  return { user, iat: now, exp: now + SESSION_TTL_SECONDS };
}

// === GitHub OAuth helpers ===

export function buildAuthorizeUrl(opts: { clientId: string; redirectUri: string; state: string }): string {
  const u = new URL('https://github.com/login/oauth/authorize');
  u.searchParams.set('client_id', opts.clientId);
  u.searchParams.set('redirect_uri', opts.redirectUri);
  u.searchParams.set('scope', 'read:user');
  u.searchParams.set('state', opts.state);
  u.searchParams.set('allow_signup', 'false');
  return u.toString();
}

export async function exchangeCodeForToken(opts: {
  clientId: string;
  clientSecret: string;
  code: string;
  redirectUri: string;
}): Promise<string> {
  const r = await fetch('https://github.com/login/oauth/access_token', {
    method: 'POST',
    headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
    body: JSON.stringify({
      client_id: opts.clientId,
      client_secret: opts.clientSecret,
      code: opts.code,
      redirect_uri: opts.redirectUri,
    }),
  });
  if (!r.ok) throw new Error(`github token exchange failed: ${r.status}`);
  const j = await r.json() as { access_token?: string; error?: string };
  if (!j.access_token) throw new Error(`github token exchange: ${j.error || 'no token'}`);
  return j.access_token;
}

export async function fetchGithubLogin(accessToken: string): Promise<string> {
  const r = await fetch('https://api.github.com/user', {
    headers: { Authorization: `Bearer ${accessToken}`, 'User-Agent': 'tianxi-admin', Accept: 'application/vnd.github+json' },
  });
  if (!r.ok) throw new Error(`github /user failed: ${r.status}`);
  const j = await r.json() as { login?: string };
  if (!j.login) throw new Error('github /user: no login');
  return j.login;
}
