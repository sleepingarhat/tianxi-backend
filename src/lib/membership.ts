import type { Env } from '../types';

export const WHOP_OAUTH_CLIENT_ID = 'app_G2CjSxrds7D5Qz';
export const WHOP_DAY_PRODUCT_ID = 'prod_nBYaIgKtoDp2a';
export const WHOP_MONTH_PRODUCT_ID = 'prod_1HBnRTt8zfhtz';
export const WHOP_ACCESS_HUB_URL = 'https://whop.com/hub';

export const CHECKOUT_URLS = {
  day: 'https://whop.com/tianxi-2d70/38-79/',
  month: 'https://whop.com/tianxi-2d70/198/',
} as const;

export const SESSION_COOKIE = 'tx_member';
export const OAUTH_COOKIE = 'tx_member_oauth';
export const SESSION_MAX_AGE_SECONDS = 30 * 24 * 60 * 60;
const DAY_PASS_SECONDS = 24 * 60 * 60;

type JsonRecord = Record<string, any>;

export interface MembershipEntitlement {
  active: boolean;
  plan?: 'day' | 'month';
  productId?: string;
  membershipId?: string;
  validUntil?: string;
  cancelAtPeriodEnd?: boolean;
  reason?: string;
}

function isRecord(value: unknown): value is JsonRecord {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function base64Url(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

function fromBase64Url(value: string): Uint8Array {
  const padded = value.replace(/-/g, '+').replace(/_/g, '/')
    + '='.repeat((4 - value.length % 4) % 4);
  return Uint8Array.from(atob(padded), (char) => char.charCodeAt(0));
}

export function randomToken(bytes = 32): string {
  const data = new Uint8Array(bytes);
  crypto.getRandomValues(data);
  return base64Url(data);
}

export function whopAuthorizationUrl(input: {
  redirectUri: string;
  state: string;
  nonce: string;
  codeChallenge: string;
}): string {
  const authorize = new URL('https://api.whop.com/oauth/authorize');
  authorize.search = new URLSearchParams({
    client_id: WHOP_OAUTH_CLIENT_ID,
    redirect_uri: input.redirectUri,
    response_type: 'code',
    scope: 'openid profile',
    state: input.state,
    nonce: input.nonce,
    code_challenge: input.codeChallenge,
    code_challenge_method: 'S256',
  }).toString();
  return authorize.toString();
}

export async function sha256(value: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
  return base64Url(new Uint8Array(digest));
}

async function aesKey(secret: string): Promise<CryptoKey> {
  const digest = await crypto.subtle.digest(
    'SHA-256',
    new TextEncoder().encode(`tianxi-membership-v1:${secret}`),
  );
  return crypto.subtle.importKey('raw', digest, { name: 'AES-GCM' }, false, ['encrypt', 'decrypt']);
}

export async function encryptToken(value: string, secret: string): Promise<string> {
  const iv = new Uint8Array(12);
  crypto.getRandomValues(iv);
  const ciphertext = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv },
    await aesKey(secret),
    new TextEncoder().encode(value),
  );
  return `v1.${base64Url(iv)}.${base64Url(new Uint8Array(ciphertext))}`;
}

export async function decryptToken(value: string, secret: string): Promise<string> {
  const [version, ivRaw, ciphertextRaw] = value.split('.');
  if (version !== 'v1' || !ivRaw || !ciphertextRaw) throw new Error('invalid encrypted token');
  const plaintext = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: fromBase64Url(ivRaw) },
    await aesKey(secret),
    fromBase64Url(ciphertextRaw),
  );
  return new TextDecoder().decode(plaintext);
}

function parseTimestamp(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value > 1e12 ? value : value * 1000;
  if (typeof value !== 'string' || !value.trim()) return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function productIdOf(membership: JsonRecord): string | undefined {
  return [
    membership.product_id,
    membership.product?.id,
    membership.plan?.product_id,
    membership.plan?.product?.id,
  ].find((value) => typeof value === 'string');
}

function membershipIdOf(membership: JsonRecord): string | undefined {
  return typeof membership.id === 'string' ? membership.id : undefined;
}

function isMembershipUsable(membership: JsonRecord, productId: string): boolean {
  const status = String(membership.status ?? '').toLowerCase();
  if (['canceled', 'cancelled', 'expired', 'revoked', 'inactive'].includes(status)) return false;
  const valid = membership.valid ?? membership.is_valid;
  if (valid === false) return false;
  if (valid === true || ['active', 'trialing'].includes(status)) return true;
  return productId === WHOP_DAY_PRODUCT_ID && status === 'completed';
}

function expiryOf(membership: JsonRecord): number | null {
  for (const value of [
    membership.expires_at,
    membership.expiration_date,
    membership.current_period_end,
    membership.renewal_period_end,
  ]) {
    const parsed = parseTimestamp(value);
    if (parsed !== null) return parsed;
  }
  return null;
}

function createdAtOf(membership: JsonRecord): number | null {
  for (const value of [membership.created_at, membership.createdAt, membership.started_at]) {
    const parsed = parseTimestamp(value);
    if (parsed !== null) return parsed;
  }
  return null;
}

function activeEntitlement(membership: JsonRecord, productId: string, nowMs: number): MembershipEntitlement | null {
  if (!isMembershipUsable(membership, productId)) return null;
  const cancelAtPeriodEnd = Boolean(
    membership.cancel_at_period_end ?? membership.cancelAtPeriodEnd,
  );

  if (productId === WHOP_DAY_PRODUCT_ID) {
    const createdAt = createdAtOf(membership);
    if (createdAt === null) return null;
    const membershipExpiry = expiryOf(membership);
    const cappedExpiry = Math.min(
      createdAt + DAY_PASS_SECONDS * 1000,
      membershipExpiry ?? Number.POSITIVE_INFINITY,
    );
    if (nowMs >= cappedExpiry) return null;
    return {
      active: true,
      plan: 'day',
      productId,
      membershipId: membershipIdOf(membership),
      validUntil: new Date(cappedExpiry).toISOString(),
      cancelAtPeriodEnd,
    };
  }

  const expiry = expiryOf(membership);
  if (expiry !== null && nowMs >= expiry) return null;
  return {
    active: true,
    plan: 'month',
    productId,
    membershipId: membershipIdOf(membership),
    validUntil: expiry === null ? undefined : new Date(expiry).toISOString(),
    cancelAtPeriodEnd,
  };
}

export function deriveEntitlement(rawMemberships: unknown, now = new Date()): MembershipEntitlement {
  const active: MembershipEntitlement[] = [];
  for (const value of Array.isArray(rawMemberships) ? rawMemberships : []) {
    if (!isRecord(value)) continue;
    const productId = productIdOf(value);
    if (productId !== WHOP_DAY_PRODUCT_ID && productId !== WHOP_MONTH_PRODUCT_ID) continue;
    const entitlement = activeEntitlement(value, productId, now.getTime());
    if (entitlement) active.push(entitlement);
  }
  const monthly = active.find((item) => item.plan === 'month');
  if (monthly) return monthly;
  const day = active.filter((item) => item.plan === 'day')
    .sort((a, b) => String(b.validUntil).localeCompare(String(a.validUntil)))[0];
  return day ?? { active: false, reason: 'no active Tianxi membership' };
}

export function membershipSecret(env: Env): string | null {
  return env.MEMBERSHIP_SESSION_SECRET || env.SESSION_HMAC_SECRET || null;
}

export function readCookie(header: string | undefined, name: string): string | null {
  if (!header) return null;
  for (const part of header.split(';')) {
    const [rawName, ...rawValue] = part.trim().split('=');
    if (rawName === name) return decodeURIComponent(rawValue.join('='));
  }
  return null;
}

export function sessionCookie(value: string, maxAge = SESSION_MAX_AGE_SECONDS): string {
  return [
    `${SESSION_COOKIE}=${encodeURIComponent(value)}`,
    'Path=/',
    `Max-Age=${Math.max(0, Math.floor(maxAge))}`,
    'HttpOnly',
    'Secure',
    'SameSite=Lax',
  ].join('; ');
}

export function oauthCookie(value: string, maxAge = 10 * 60): string {
  return [
    `${OAUTH_COOKIE}=${encodeURIComponent(value)}`,
    'Path=/api/membership/oauth/callback',
    `Max-Age=${Math.max(0, Math.floor(maxAge))}`,
    'HttpOnly',
    'Secure',
    'SameSite=Lax',
  ].join('; ');
}

export async function ensureMembershipTables(db: D1Database): Promise<void> {
  const statements = [
    `CREATE TABLE IF NOT EXISTS membership_oauth_states (
      state_hash TEXT PRIMARY KEY,
      verifier_enc TEXT NOT NULL,
      browser_nonce_hash TEXT,
      redirect_uri TEXT NOT NULL,
      expires_at TEXT NOT NULL,
      used_at TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    )`,
    `CREATE TABLE IF NOT EXISTS membership_sessions (
      token_hash TEXT PRIMARY KEY,
      whop_user_id TEXT NOT NULL,
      username TEXT,
      access_token_enc TEXT NOT NULL,
      refresh_token_enc TEXT NOT NULL,
      token_expires_at TEXT NOT NULL,
      expires_at TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      last_seen_at TEXT NOT NULL DEFAULT (datetime('now'))
    )`,
    `CREATE TABLE IF NOT EXISTS membership_entitlements (
      whop_user_id TEXT PRIMARY KEY,
      membership_id TEXT,
      product_id TEXT,
      plan TEXT,
      active INTEGER NOT NULL DEFAULT 0,
      valid_until TEXT,
      cancel_at_period_end INTEGER NOT NULL DEFAULT 0,
      checked_at TEXT NOT NULL DEFAULT (datetime('now'))
    )`,
  ];
  for (const statement of statements) await db.prepare(statement).run();
  await db.prepare(
    `ALTER TABLE membership_oauth_states ADD COLUMN browser_nonce_hash TEXT`,
  ).run().catch(() => {});
  await db.prepare(
    `DELETE FROM membership_oauth_states
     WHERE expires_at <= datetime('now') OR used_at <= datetime('now', '-1 day')`,
  ).run().catch(() => {});
  await db.prepare(`DELETE FROM membership_sessions WHERE expires_at <= datetime('now')`)
    .run().catch(() => {});
}