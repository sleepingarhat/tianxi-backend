#!/usr/bin/env tsx

import assert from 'node:assert/strict';
import { SESSION_COOKIE, signSession } from '../src/lib/admin-auth';
import { adminRoutes } from '../src/routes/admin';

const ALLOWED_ADMIN = 'test-admin';
const SESSION_SECRET = 'test-session-secret';
const ADMIN_TOKEN = 'test-emergency-token';

const env = {
  DB: {} as D1Database,
  SESSION_HMAC_SECRET: SESSION_SECRET,
  ADMIN_GITHUB_USER: `other-admin, ${ALLOWED_ADMIN}`,
  ADMIN_TOKEN,
};

function requestPing(headers: HeadersInit = {}): Promise<Response> {
  return adminRoutes.request('/api/ping', { headers }, env);
}

async function assertAccepted(response: Response): Promise<void> {
  assert.equal(response.status, 200);
  const body = await response.json() as { ok?: boolean; token?: string };
  assert.equal(body.ok, true);
  assert.equal(body.token, 'accepted');
}

async function assertUnauthorized(response: Response): Promise<void> {
  assert.equal(response.status, 401);
  assert.deepEqual(await response.json(), { error: 'unauthorized' });
}

async function main(): Promise<void> {
  const now = Math.floor(Date.now() / 1000);
  const session = await signSession({
    user: ALLOWED_ADMIN,
    iat: now,
    exp: now + 60,
  }, SESSION_SECRET);

  await assertAccepted(await requestPing({
    Cookie: `${SESSION_COOKIE}=${encodeURIComponent(session)}`,
    Accept: 'application/json',
  }));

  await assertAccepted(await requestPing({
    Cookie: `${SESSION_COOKIE}=invalid-session`,
    Authorization: `Bearer ${ADMIN_TOKEN}`,
    Accept: 'application/json',
  }));

  await assertUnauthorized(await requestPing({
    Authorization: 'Bearer invalid-token',
    Accept: 'application/json',
  }));

  await assertUnauthorized(await requestPing({
    Accept: 'application/json',
  }));

  console.log('Admin auth regression tests passed.');
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});