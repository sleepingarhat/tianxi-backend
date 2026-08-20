#!/usr/bin/env tsx

import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import ts from 'typescript';
import {
  ADMIN_AUTH_POLICY,
  SESSION_COOKIE,
  type AdminAuthPolicy,
  hasAdminAccess,
  signSession,
} from '../src/lib/admin-auth';
import { adminRoutes } from '../src/routes/admin';
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
}): any {
  return {
    env,
    req: {
      header(name: string) {
        if (name.toLowerCase() === 'authorization') return options.authorization;
        if (name.toLowerCase() === 'cookie') return options.cookie;
        return undefined;
      },
    },
  };
}

type HttpMethod = 'GET' | 'POST' | 'PUT' | 'DELETE' | 'PATCH' | 'OPTIONS' | 'HEAD' | 'ALL';

type EndpointCase = {
  name: string;
  method: HttpMethod;
  path: string;
  policy: AdminAuthPolicy;
  access: 'private' | 'dual';
};

function withQueryToken(path: string): string {
  const url = new URL(path, 'https://tianxi.test');
  url.searchParams.set('token', ADMIN_TOKEN);
  return `${url.pathname}${url.search}`;
}

function requestEndpoint(endpoint: EndpointCase, headers: HeadersInit = {}): Promise<Response> {
  const hasBody = endpoint.method !== 'GET' && endpoint.method !== 'HEAD';
  return requestApp(endpoint.path, {
    method: endpoint.method,
    headers: {
      Accept: 'application/json',
      ...(hasBody ? { 'Content-Type': 'application/json' } : {}),
      ...headers,
    },
    ...(hasBody ? { body: '{}' } : {}),
  });
}

const BEARER_ONLY_ADMIN_PATHS = new Set([
  '/api/set-alpha',
  '/api/fix-dividend-pool-swap',
  '/api/refresh-race-dividends',
]);

const SESSION_OR_BEARER_ADMIN_PATHS = new Set([
  '/api/ping',
  '/api/status',
  '/api/gaps',
  '/api/coverage',
  '/api/feature-audit',
  '/api/lgb-predictions',
  '/api/d1-maintenance',
  '/api/entries-upcoming-export',
  '/api/alerts',
  '/api/dispatch',
  '/api/runs',
  '/api/meetings',
  '/api/seed-missing-jockey-elo',
  '/api/elo-backfill-from-results',
  '/api/migrate-prediction-log-lgb',
  '/api/migrate-entries-post-time',
  '/api/sql-read',
  '/api/cleanup-duplicate-meetings',
  '/api/data-housekeeping',
  '/api/jockey-elo-debug',
  '/',
]);

function discoverProtectedAdminEndpoints(): EndpointCase[] {
  const source = readFileSync('src/routes/admin.ts', 'utf8');
  const endpoints: EndpointCase[] = [];
  const publicPaths = new Set(['/login', '/callback', '/logout']);
  const routePattern = /adminRoutes\.(get|post)\(\s*['"]([^'"]+)['"]/g;
  for (const match of source.matchAll(routePattern)) {
    const routePath = match[2];
    if (publicPaths.has(routePath)) continue;
    assert.equal(
      BEARER_ONLY_ADMIN_PATHS.has(routePath) || SESSION_OR_BEARER_ADMIN_PATHS.has(routePath),
      true,
      `${match[1].toUpperCase()} /admin${routePath} needs an explicit auth policy`,
    );
    endpoints.push({
      name: `admin ${match[1].toUpperCase()} ${routePath}`,
      method: match[1].toUpperCase() as 'GET' | 'POST',
      path: routePath === '/' ? '/admin' : `/admin${routePath}`,
      policy: BEARER_ONLY_ADMIN_PATHS.has(routePath)
        ? ADMIN_AUTH_POLICY.BEARER_ONLY
        : ADMIN_AUTH_POLICY.SESSION_OR_BEARER,
      access: 'private',
    });
  }
  return endpoints;
}

function listTypeScriptFiles(dir: string): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) files.push(...listTypeScriptFiles(path));
    else if (entry.isFile() && entry.name.endsWith('.ts')) files.push(path);
  }
  return files;
}

function credentialPolicyViolations(file: string, source: string): string[] {
  const sourceFile = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true);
  const violations: string[] = [];
  const constantInitializers = new Map<string, ts.Expression>();
  const sensitiveRouteFile = new Set([
    join('src', 'routes', 'admin.ts'),
    join('src', 'routes', 'analyze.ts'),
    join('src', 'index.ts'),
  ]).has(file);

  function collectConstants(node: ts.Node): void {
    if (
      ts.isVariableDeclaration(node)
      && ts.isIdentifier(node.name)
      && node.initializer
    ) {
      constantInitializers.set(node.name.text, node.initializer);
    }
    ts.forEachChild(node, collectConstants);
  }

  function staticText(node: ts.Expression | undefined, seen = new Set<string>()): string | null {
    if (!node) return null;
    if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) return node.text;
    if (ts.isParenthesizedExpression(node)) return staticText(node.expression, seen);
    if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.PlusToken) {
      const left = staticText(node.left, seen);
      const right = staticText(node.right, seen);
      return left === null || right === null ? null : left + right;
    }
    if (ts.isIdentifier(node) && !seen.has(node.text)) {
      const initializer = constantInitializers.get(node.text);
      if (!initializer) return null;
      const nextSeen = new Set(seen);
      nextSeen.add(node.text);
      return staticText(initializer, nextSeen);
    }
    return null;
  }

  function isPropertyName(node: ts.Identifier): boolean {
    return (
      (ts.isPropertyAssignment(node.parent) && node.parent.name === node)
      || (ts.isPropertySignature(node.parent) && node.parent.name === node)
      || (ts.isMethodDeclaration(node.parent) && node.parent.name === node)
    );
  }

  collectConstants(sourceFile);

  function visit(node: ts.Node): void {
    if (
      ts.isIdentifier(node)
      && node.text === 'ADMIN_TOKEN'
      && !ts.isPropertySignature(node.parent)
    ) {
      violations.push('references ADMIN_TOKEN outside the shared auth module');
    }
    if (
      sensitiveRouteFile
      && ts.isIdentifier(node)
      && node.text.toLowerCase() === 'token'
      && !isPropertyName(node)
    ) {
      violations.push('uses a generic token value inside a sensitive route module');
    }
    if (ts.isPropertyAccessExpression(node) && node.name.text === 'ADMIN_TOKEN') {
      violations.push('reads ADMIN_TOKEN outside the shared auth module');
    }
    if (ts.isBindingElement(node) && staticText(node.propertyName as ts.Expression | undefined)?.toLowerCase() === 'token') {
      violations.push('destructures a token value inside a sensitive route module');
    }
    if (ts.isElementAccessExpression(node)) {
      const property = staticText(node.argumentExpression);
      if (property === 'ADMIN_TOKEN') {
        violations.push('reads ADMIN_TOKEN outside the shared auth module');
      }
      if (sensitiveRouteFile && property?.toLowerCase() === 'token') {
        violations.push('reads a token property inside a sensitive route module');
      }
      if (
        property === null
        && ts.isPropertyAccessExpression(node.expression)
        && ts.isIdentifier(node.expression.expression)
        && node.expression.expression.text === 'c'
        && node.expression.name.text === 'env'
      ) {
        violations.push('uses an unverifiable computed c.env credential lookup');
      }
    }
    if (ts.isCallExpression(node)) {
      const property = ts.isPropertyAccessExpression(node.expression)
        ? node.expression.name.text
        : null;
      const firstArg = staticText(node.arguments[0]);
      if (
        (property === 'query' || property === 'queries')
        && (node.arguments.length === 0 || firstArg === null || firstArg.toLowerCase() === 'token')
      ) {
        violations.push('uses an unsafe or unverifiable request query lookup');
      }
      if (property === 'get' && firstArg?.toLowerCase() === 'token') {
        violations.push('reads a credential from a token URL parameter');
      }
      if (
        property === 'header'
        && (node.arguments.length === 0 || firstArg === null || firstArg.toLowerCase() === 'authorization')
      ) {
        violations.push('reads inbound Authorization outside the shared auth module');
      }
      if (property === 'get' && firstArg?.toLowerCase() === 'authorization') {
        violations.push('reads inbound Authorization outside the shared auth module');
      }
      if (ts.isIdentifier(node.expression) && node.expression.text === 'hasAdminAccess') {
        const contextArg = node.arguments[0];
        const policyArg = node.arguments[1];
        if (!contextArg || !ts.isIdentifier(contextArg) || contextArg.text !== 'c') {
          violations.push('adapts a non-route context into the shared admin guard');
        }
        if (
          !policyArg
          || !ts.isPropertyAccessExpression(policyArg)
          || !ts.isIdentifier(policyArg.expression)
          || policyArg.expression.text !== 'ADMIN_AUTH_POLICY'
        ) {
          violations.push('calls the shared admin guard without an explicit policy');
        }
      }
    }
    ts.forEachChild(node, visit);
  }

  visit(sourceFile);
  return [...new Set(violations)];
}

function assertNoCredentialPolicyDrift(): void {
  const guardFile = join('src', 'lib', 'admin-auth.ts');
  for (const file of listTypeScriptFiles('src')) {
    if (file === guardFile) continue;
    const violations = credentialPolicyViolations(file, readFileSync(file, 'utf8'));
    assert.deepEqual(violations, [], `${file} contains credential-policy drift`);
  }
}

type ResponseSnapshot = {
  status: number;
  error: string | null;
  keys: string[];
};

async function responseSnapshot(response: Response): Promise<ResponseSnapshot> {
  const body = await response.json().catch(() => null) as Record<string, unknown> | null;
  return {
    status: response.status,
    error: body && typeof body.error === 'string' ? body.error : null,
    keys: body ? Object.keys(body).sort() : [],
  };
}

function isAuthRejected(snapshot: ResponseSnapshot): boolean {
  return snapshot.error === 'unauthorized'
    || snapshot.error === 'unauthorized (Bearer required)'
    || snapshot.error === 'Not found';
}

function endpointKey(method: string, path: string): string {
  const url = new URL(path, 'https://tianxi.test');
  return `${method.toUpperCase()} ${url.pathname}`;
}

type RouteDeclaration = {
  key: string;
  source: string;
};

function collectRouteDeclarations(
  label: string,
  source: string,
  routerName: 'adminRoutes' | 'analyzeRoutes' | 'app',
  prefix: string,
  routeNamespace = prefix,
): RouteDeclaration[] {
  const sourceFile = ts.createSourceFile(label, source, ts.ScriptTarget.Latest, true);
  const declarations: RouteDeclaration[] = [];
  const standardMethods = new Set([
    'get',
    'post',
    'put',
    'delete',
    'patch',
    'options',
    'head',
    'all',
    'connect',
    'trace',
  ]);

  function routePath(expression: ts.Expression | undefined): string {
    assert.equal(
      Boolean(expression && (ts.isStringLiteral(expression) || ts.isNoSubstitutionTemplateLiteral(expression))),
      true,
      `${label} route paths must be static strings for policy classification`,
    );
    const path = (expression as ts.StringLiteral).text;
    return path === '/' ? prefix : `${prefix}${path}`;
  }

  function add(method: string, path: string, node: ts.CallExpression): void {
    if (!path.startsWith(routeNamespace)) return;
    declarations.push({
      key: endpointKey(method, path),
      source: node.getText(sourceFile),
    });
  }

  function visit(node: ts.Node): void {
    if (
      ts.isCallExpression(node)
      && ts.isPropertyAccessExpression(node.expression)
      && ts.isIdentifier(node.expression.expression)
      && node.expression.expression.text === routerName
    ) {
      const registration = node.expression.name.text;
      if (standardMethods.has(registration)) {
        add(registration.toUpperCase(), routePath(node.arguments[0]), node);
      } else if (registration === 'on') {
        const path = routePath(node.arguments[1]);
        const methodArg = node.arguments[0];
        if (methodArg && ts.isArrayLiteralExpression(methodArg)) {
          for (const element of methodArg.elements) {
            assert.equal(
              ts.isStringLiteral(element) || ts.isNoSubstitutionTemplateLiteral(element),
              true,
              `${label} route methods must be static strings for policy classification`,
            );
            add((element as ts.StringLiteral).text.toUpperCase(), path, node);
          }
        } else {
          assert.equal(
            Boolean(methodArg && (ts.isStringLiteral(methodArg) || ts.isNoSubstitutionTemplateLiteral(methodArg))),
            true,
            `${label} route methods must be static strings for policy classification`,
          );
          add((methodArg as ts.StringLiteral).text.toUpperCase(), path, node);
        }
      } else if (registration === 'route') {
        add('ROUTE', routePath(node.arguments[0]), node);
      }
    }
    ts.forEachChild(node, visit);
  }

  visit(sourceFile);
  return declarations;
}

function assertRouteSourceMatchesManifest(
  label: string,
  source: string,
  routerName: 'adminRoutes' | 'analyzeRoutes' | 'app',
  prefix: string,
  manifest: EndpointCase[],
  publicRoutes: Set<string>,
  policyInsideHandler: boolean,
  routeNamespace = prefix,
): void {
  const declaredRoutes = new Map(
    collectRouteDeclarations(label, source, routerName, prefix, routeNamespace)
      .map((route) => [route.key, route.source]),
  );
  const declared = new Map(manifest.map((endpoint) => [
    endpointKey(endpoint.method, endpoint.path),
    endpoint,
  ]));
  assert.deepEqual(
    [...declaredRoutes.keys()].sort(),
    [...declared.keys(), ...publicRoutes].sort(),
    `${label} routes must all be classified as public or carry an auth policy`,
  );
  for (const [key, endpoint] of declared) {
    const slice = declaredRoutes.get(key)!;
    if (!policyInsideHandler && endpoint.policy !== ADMIN_AUTH_POLICY.BEARER_ONLY) continue;
    const policyName = endpoint.policy === ADMIN_AUTH_POLICY.BEARER_ONLY
      ? 'ADMIN_AUTH_POLICY.BEARER_ONLY'
      : 'ADMIN_AUTH_POLICY.SESSION_OR_BEARER';
    assert.equal(
      slice.includes(policyName),
      true,
      `${key} must explicitly use ${endpoint.policy}`,
    );
  }
}

function assertRoutesMatchManifest(
  file: string,
  routerName: 'adminRoutes' | 'analyzeRoutes' | 'app',
  prefix: string,
  manifest: EndpointCase[],
  publicRoutes: Set<string>,
  policyInsideHandler: boolean,
  routeNamespace = prefix,
): void {
  assertRouteSourceMatchesManifest(
    file,
    readFileSync(file, 'utf8'),
    routerName,
    prefix,
    manifest,
    publicRoutes,
    policyInsideHandler,
    routeNamespace,
  );
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

  const guardCases = [
    {
      name: 'session-or-bearer accepts an allowlisted session',
      policy: ADMIN_AUTH_POLICY.SESSION_OR_BEARER,
      context: authContext({ cookie: sessionCookie }),
      expected: true,
    },
    {
      name: 'session-or-bearer accepts the configured Bearer token',
      policy: ADMIN_AUTH_POLICY.SESSION_OR_BEARER,
      context: authContext({ authorization: `Bearer ${ADMIN_TOKEN}` }),
      expected: true,
    },
    {
      name: 'bearer-only accepts the configured Bearer token',
      policy: ADMIN_AUTH_POLICY.BEARER_ONLY,
      context: authContext({ authorization: `Bearer ${ADMIN_TOKEN}` }),
      expected: true,
    },
    {
      name: 'bearer-only rejects a valid browser session',
      policy: ADMIN_AUTH_POLICY.BEARER_ONLY,
      context: authContext({ cookie: sessionCookie }),
      expected: false,
    },
    {
      name: 'session-or-bearer rejects an invalid token',
      policy: ADMIN_AUTH_POLICY.SESSION_OR_BEARER,
      context: authContext({ authorization: 'Bearer invalid-token' }),
      expected: false,
    },
    {
      name: 'session-or-bearer rejects missing credentials',
      policy: ADMIN_AUTH_POLICY.SESSION_OR_BEARER,
      context: authContext({}),
      expected: false,
    },
  ] as const;
  for (const testCase of guardCases) {
    assert.equal(
      await hasAdminAccess(testCase.context, testCase.policy),
      testCase.expected,
      testCase.name,
    );
  }

  await assertAccepted(await requestPing({ Cookie: sessionCookie, Accept: 'application/json' }));
  await assertAccepted(await requestPing({
    Cookie: `${SESSION_COOKIE}=invalid-session`,
    Authorization: `Bearer ${ADMIN_TOKEN}`,
    Accept: 'application/json',
  }));
  await assertUnauthorized(await requestPing({ Authorization: 'Bearer invalid-token', Accept: 'application/json' }));
  await assertUnauthorized(await requestPing({ Accept: 'application/json' }));
  await assertUnauthorized(await requestPing(
    { Accept: 'application/json' },
    `?token=${encodeURIComponent(ADMIN_TOKEN)}`,
  ));

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

  const analyzeEndpoints: EndpointCase[] = [
    { name: 'factor analysis', method: 'POST', path: '/api/analyze', policy: ADMIN_AUTH_POLICY.SESSION_OR_BEARER, access: 'private' },
    { name: 'top picks admin fields', method: 'GET', path: '/api/analyze/top-picks?raceId=missing', policy: ADMIN_AUTH_POLICY.SESSION_OR_BEARER, access: 'dual' },
    { name: 'explanation admin fields', method: 'GET', path: '/api/analyze/explain?raceId=missing', policy: ADMIN_AUTH_POLICY.SESSION_OR_BEARER, access: 'dual' },
    { name: 'today picks admin fields', method: 'GET', path: '/api/analyze/today-picks', policy: ADMIN_AUTH_POLICY.SESSION_OR_BEARER, access: 'dual' },
    { name: 'race-day refresh', method: 'POST', path: '/api/analyze/refresh-race-day-report', policy: ADMIN_AUTH_POLICY.SESSION_OR_BEARER, access: 'private' },
    { name: 'ROI analysis', method: 'GET', path: '/api/analyze/roi', policy: ADMIN_AUTH_POLICY.SESSION_OR_BEARER, access: 'private' },
    { name: 'value picks', method: 'GET', path: '/api/analyze/value-picks', policy: ADMIN_AUTH_POLICY.SESSION_OR_BEARER, access: 'private' },
    { name: 'backtest dates', method: 'GET', path: '/api/analyze/backtest-dates', policy: ADMIN_AUTH_POLICY.SESSION_OR_BEARER, access: 'private' },
    { name: 'prediction result join', method: 'POST', path: '/api/analyze/join-prediction-results', policy: ADMIN_AUTH_POLICY.SESSION_OR_BEARER, access: 'private' },
    { name: 'historical picks', method: 'GET', path: '/api/analyze/picks-by-date', policy: ADMIN_AUTH_POLICY.SESSION_OR_BEARER, access: 'private' },
    { name: 'hit-rate admin fields', method: 'GET', path: '/api/analyze/hit-rate?date=2026-01-01', policy: ADMIN_AUTH_POLICY.SESSION_OR_BEARER, access: 'dual' },
    { name: 'ensemble alpha write', method: 'POST', path: '/api/analyze/ensemble-alpha', policy: ADMIN_AUTH_POLICY.BEARER_ONLY, access: 'private' },
    { name: 'D1 inspection', method: 'GET', path: '/api/analyze/d1-inspect', policy: ADMIN_AUTH_POLICY.BEARER_ONLY, access: 'private' },
    { name: 'hit-rate rollup admin fields', method: 'GET', path: '/api/analyze/hit-rate-rollup?days=1', policy: ADMIN_AUTH_POLICY.SESSION_OR_BEARER, access: 'dual' },
    { name: 'strategy P&L admin fields', method: 'GET', path: '/api/analyze/strategy-pnl', policy: ADMIN_AUTH_POLICY.SESSION_OR_BEARER, access: 'dual' },
    { name: 'ensemble tuning', method: 'GET', path: '/api/analyze/ensemble-tune', policy: ADMIN_AUTH_POLICY.SESSION_OR_BEARER, access: 'private' },
  ];
  const maintenanceEndpoints: EndpointCase[] = [
    { name: 'season override', method: 'POST', path: '/admin/api/set-season-mode', policy: ADMIN_AUTH_POLICY.BEARER_ONLY, access: 'private' },
    { name: 'hit-rate refresh', method: 'POST', path: '/admin/api/refresh-hit-cache', policy: ADMIN_AUTH_POLICY.SESSION_OR_BEARER, access: 'private' },
    { name: 'prediction backfill', method: 'POST', path: '/admin/api/backfill-prediction-results', policy: ADMIN_AUTH_POLICY.SESSION_OR_BEARER, access: 'private' },
    { name: 'report refresh', method: 'POST', path: '/admin/api/refresh-race-day-report', policy: ADMIN_AUTH_POLICY.SESSION_OR_BEARER, access: 'private' },
    { name: 'odds prune', method: 'POST', path: '/admin/api/prune-odds', policy: ADMIN_AUTH_POLICY.SESSION_OR_BEARER, access: 'private' },
    { name: 'odds archive', method: 'POST', path: '/admin/api/archive-odds', policy: ADMIN_AUTH_POLICY.SESSION_OR_BEARER, access: 'private' },
    { name: 'strategy P&L warmup', method: 'POST', path: '/admin/api/warm-strategy-pnl', policy: ADMIN_AUTH_POLICY.SESSION_OR_BEARER, access: 'private' },
  ];
  const adminEndpoints = discoverProtectedAdminEndpoints();
  const protectedEndpoints = [...adminEndpoints, ...analyzeEndpoints, ...maintenanceEndpoints];

  assert.deepEqual(
    [...BEARER_ONLY_ADMIN_PATHS].sort(),
    adminEndpoints
      .filter((endpoint) => endpoint.policy === ADMIN_AUTH_POLICY.BEARER_ONLY)
      .map((endpoint) => new URL(endpoint.path, 'https://tianxi.test').pathname.replace('/admin', ''))
      .sort(),
    'all Bearer-only admin routes must be declared in the policy set',
  );
  assert.deepEqual(
    [...new Set(
      adminEndpoints
        .filter((endpoint) => endpoint.policy === ADMIN_AUTH_POLICY.SESSION_OR_BEARER)
        .map((endpoint) => new URL(endpoint.path, 'https://tianxi.test').pathname.replace('/admin', '') || '/'),
    )].sort(),
    [...SESSION_OR_BEARER_ADMIN_PATHS].sort(),
    'all session-or-bearer admin routes must be declared in the policy set',
  );
  assertRoutesMatchManifest(
    'src/routes/admin.ts',
    'adminRoutes',
    '/admin',
    adminEndpoints,
    new Set([
      'GET /admin/login',
      'GET /admin/callback',
      'GET /admin/logout',
    ]),
    false,
  );
  assertRoutesMatchManifest(
    'src/routes/analyze.ts',
    'analyzeRoutes',
    '/api/analyze',
    analyzeEndpoints,
    new Set(['GET /api/analyze/factors']),
    true,
  );
  assertRoutesMatchManifest(
    'src/index.ts',
    'app',
    '',
    maintenanceEndpoints,
    new Set(),
    true,
    '/admin/',
  );

  for (const endpoint of protectedEndpoints) {
    const baseline = await responseSnapshot(await requestEndpoint(endpoint));
    const queryResponse = await responseSnapshot(await requestEndpoint({
      ...endpoint,
      path: withQueryToken(endpoint.path),
    }));
    assert.deepEqual(
      queryResponse,
      baseline,
      `${endpoint.name} must treat ?token= exactly like no credentials`,
    );

    if (endpoint.access === 'dual') continue;
    assert.equal(isAuthRejected(baseline), true, `${endpoint.name} must be protected`);

    const sessionResponse = await responseSnapshot(
      await requestEndpoint(endpoint, { Cookie: sessionCookie }),
    );
    assert.equal(
      isAuthRejected(sessionResponse),
      endpoint.policy === ADMIN_AUTH_POLICY.BEARER_ONLY,
      `${endpoint.name} session behavior must match ${endpoint.policy}`,
    );

    const bearerResponse = await responseSnapshot(
      await requestEndpoint(endpoint, { Authorization: `Bearer ${ADMIN_TOKEN}` }),
    );
    assert.equal(
      isAuthRejected(bearerResponse),
      false,
      `${endpoint.name} must accept the configured Bearer credential`,
    );
  }

  const applyEndpoint: EndpointCase = {
    name: 'ensemble tuning apply',
    method: 'GET',
    path: '/api/analyze/ensemble-tune?apply=1',
    policy: ADMIN_AUTH_POLICY.BEARER_ONLY,
    access: 'private',
  };
  const sessionApply = await requestEndpoint(applyEndpoint, { Cookie: sessionCookie });
  assert.equal(sessionApply.status, 200);
  assert.deepEqual(
    await sessionApply.json().then((body: any) => ({
      applied: body.applied,
      applyDenied: body.applyDenied,
    })),
    { applied: false, applyDenied: true },
    'a browser session must not apply ensemble-alpha changes',
  );
  const bearerApply = await requestEndpoint(applyEndpoint, { Authorization: `Bearer ${ADMIN_TOKEN}` });
  assert.equal(bearerApply.status, 200);
  assert.deepEqual(
    await bearerApply.json().then((body: any) => ({
      applied: body.applied,
      applyDenied: body.applyDenied,
    })),
    { applied: true, applyDenied: false },
    'Bearer auth must retain the intentional ensemble-alpha apply path',
  );

  assert.throws(
    () => assertRouteSourceMatchesManifest(
      'synthetic-put-route.ts',
      "analyzeRoutes.put('/unsafe-new-route', async (c) => c.json({ ok: true }));",
      'analyzeRoutes',
      '/api/analyze',
      [],
      new Set(),
      true,
    ),
    /classified as public or carry an auth policy/,
    'a new unclassified HTTP method must fail the route manifest check',
  );
  const indirectQueryViolations = credentialPolicyViolations(
    join('src', 'routes', 'analyze.ts'),
    "const key = 'to' + 'ken'; const credential = c.req.queries(key);",
  );
  assert.equal(
    indirectQueryViolations.includes('uses an unsafe or unverifiable request query lookup'),
    true,
    'an indirect queries(token) credential lookup must fail the AST policy check',
  );

  assertNoCredentialPolicyDrift();

  console.log('Admin auth regression tests passed.');
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});