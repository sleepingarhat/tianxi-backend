#!/usr/bin/env tsx

import assert from 'node:assert/strict';
import { SESSION_COOKIE, signSession } from '../src/lib/admin-auth';
import { adminRoutes } from '../src/routes/admin';
import { hasAdminAccess } from '../src/routes/analyze';
import worker from '../src/index';

const ALLOWED_ADMIN = 'test-admin';
const SESSION_SECRET = 'test-session-secret';
const ADMIN_TOKEN = 'test-emergency-token';

const env = {
  DB: makeDbShim(),
  SESSION_HMAC_SECRET: SESSION_SECRET,
  ADMIN_GITHUB_USER: `other-admin, ${ALLOWED_ADMIN}`,
  ADMIN_TOKEN,
};

function makeDbShim(): D1Database {
  const db = {
    prepare(_sql: string) {
      const statement = {
        bind(..._values: unknown[]) {
          return statement;
        },
        async first<T = unknown>(): Promise<T | null> {
          return null;
        },
        async all<T = unknown>(): Promise<D1Result<T>> {
          return { results: [] } as unknown as D1Result<T>;
        },
        async run(): Promise<D1Result> {
          return { results: [], meta: { changes: 0 } } as unknown as D1Result;
        },
      };
      return statement;
    },
    async batch(statements: unknown[]) {
      return statements.map(() => ({ results: [], meta: { changes: 0 } }));
    },
  };
  return db as unknown as D1Database;
}

function requestPing(headers: HeadersInit = {}, query = ''): Promise<Response> {
  return adminRoutes.request(`/api/ping${query}`, { headers }, env);
}

function requestApp(path: string, init?: RequestInit): Promise<Response> {
  return worker.fetch(
    new Request(`https://tianxi.test${path}`, init),
    env as any,
    { waitUntil() {}, passThroughOnException() {} } as any,
  );
}

function authContext(options: {
  authorization?: string;
  cookie?: string;
  token?: string;
}): any {
  return {
    env,
    req: {
      header(name: string) {
        if (name.toLowerCase() === 'authorization') return options.authorization;
        if (name.toLowerCase() === 'cookie') return options.cookie;
        return undefined;
      },
      query(name: string) {
        return name === 'token' ? options.token : undefined;
      },
    },
  };
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
  const sessionCookie = `${SESSION_COOKIE}=${encodeURIComponent(session)}`;

  await assertAccepted(await requestPing({
    Cookie: sessionCookie,
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

  await assertUnauthorized(await requestPing({
    Accept: 'application/json',
  }, `?token=${encodeURIComponent(ADMIN_TOKEN)}`));

  assert.equal(
    await hasAdminAccess(authContext({ authorization: `Bearer ${ADMIN_TOKEN}` })),
    true,
  );
  assert.equal(await hasAdminAccess(authContext({ cookie: sessionCookie })), true);
  assert.equal(await hasAdminAccess(authContext({ token: ADMIN_TOKEN })), false);

  const accessLogs: string[] = [];
  const originalConsoleLog = console.log;
  console.log = (...values: unknown[]) => {
    accessLogs.push(values.map(String).join(' '));
  };
  let queryResponse: Response;
  try {
    queryResponse = await requestApp(`/admin/api/ping?token=${encodeURIComponent(ADMIN_TOKEN)}`);
  } finally {
    console.log = originalConsoleLog;
  }
  await assertUnauthorized(queryResponse);
  assert.equal(
    accessLogs.some((line) => line.includes(ADMIN_TOKEN) || line.includes('?token=')),
    false,
  );

  const pageResponse = await requestApp('/admin', {
    headers: { Cookie: sessionCookie, Accept: 'text/html' },
  });
  assert.equal(pageResponse.status, 200);
  const pageHtml = await pageResponse.text();
  assert.equal(pageHtml.includes('const TOKEN'), false);
  assert.equal(pageHtml.includes(ADMIN_TOKEN), false);

  const ensembleAlphaQueryResponse = await requestApp(
    `/api/analyze/ensemble-alpha?token=${encodeURIComponent(ADMIN_TOKEN)}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ alpha: 0.5 }),
    },
  );
  await assertUnauthorized(ensembleAlphaQueryResponse);

  const inspectQueryResponse = await requestApp(
    `/api/analyze/d1-inspect?table=app_settings&token=${encodeURIComponent(ADMIN_TOKEN)}`,
  );
  await assertUnauthorized(inspectQueryResponse);

  console.log('Admin auth regression tests passed.');
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});