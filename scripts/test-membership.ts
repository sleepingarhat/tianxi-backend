#!/usr/bin/env tsx

import assert from 'node:assert/strict';
import {
  CHECKOUT_URLS,
  WHOP_DAY_PRODUCT_ID,
  WHOP_MONTH_PRODUCT_ID,
  decryptToken,
  deriveEntitlement,
  encryptToken,
  oauthCookie,
  readCookie,
  sessionCookie,
  whopAuthorizationUrl,
} from '../src/lib/membership';
import { projectTodayPicksForFree } from '../src/lib/public-today-picks';

const now = new Date('2026-08-20T12:00:00.000Z');

assert.equal(deriveEntitlement([], now).active, false);
assert.equal(deriveEntitlement([{
  id: 'mem_month',
  product: { id: WHOP_MONTH_PRODUCT_ID },
  status: 'active',
  expires_at: '2026-09-20T12:00:00.000Z',
}], now).plan, 'month');
assert.equal(deriveEntitlement([{
  id: 'mem_cancelled',
  product_id: WHOP_MONTH_PRODUCT_ID,
  status: 'cancelled',
  valid: true,
  expires_at: '2026-09-20T12:00:00.000Z',
}], now).active, false);
assert.equal(deriveEntitlement([{
  id: 'mem_cancel_period_end',
  product_id: WHOP_MONTH_PRODUCT_ID,
  status: 'active',
  cancel_at_period_end: true,
  expires_at: '2026-09-20T12:00:00.000Z',
}], now).cancelAtPeriodEnd, true);

const currentDay = deriveEntitlement([{
  id: 'mem_day',
  product_id: WHOP_DAY_PRODUCT_ID,
  status: 'completed',
  created_at: '2026-08-19T13:00:00.000Z',
}], now);
assert.equal(currentDay.active, true);
assert.equal(currentDay.validUntil, '2026-08-20T13:00:00.000Z');
assert.equal(deriveEntitlement([{
  id: 'mem_old_day',
  product_id: WHOP_DAY_PRODUCT_ID,
  status: 'completed',
  created_at: '2026-08-19T11:59:59.000Z',
}], now).active, false);
assert.equal(deriveEntitlement([{
  id: 'mem_day_without_creation',
  product_id: WHOP_DAY_PRODUCT_ID,
  status: 'completed',
}], now).active, false);
assert.equal(deriveEntitlement([{
  id: 'other_product',
  product_id: 'prod_attacker',
  status: 'active',
}], now).active, false);

assert.deepEqual(CHECKOUT_URLS, {
  day: 'https://whop.com/tianxi-2d70/38-79/',
  month: 'https://whop.com/tianxi-2d70/198/',
});

const authorizeUrl = new URL(whopAuthorizationUrl({
  redirectUri: 'https://tianxi.racing/api/membership/oauth/callback',
  state: 'state-value',
  nonce: 'nonce-value',
  codeChallenge: 'challenge-value',
}));
assert.equal(authorizeUrl.searchParams.get('client_id'), 'app_G2CjSxrds7D5Qz');
assert.equal(authorizeUrl.searchParams.get('nonce'), 'nonce-value');
assert.equal(authorizeUrl.searchParams.get('code_challenge_method'), 'S256');
assert.equal(authorizeUrl.searchParams.get('scope'), 'openid profile');

const free = projectTodayPicksForFree({
  date: '2026-08-20',
  venue: 'HV',
  races: [
    { raceId: 'race_2026-08-20_HV_1', raceNumber: 1, picks: [{ horseNumber: 1 }] },
    { raceId: 'race_2026-08-20_HV_2', raceNumber: 2, picks: [{ horseNumber: 2 }] },
  ],
});
assert.equal(free.races.length, 1);
assert.equal(free.races[0].raceNumber, 1);

async function testCryptoAndCookie(): Promise<void> {
  const encrypted = await encryptToken('refresh-token-secret', 'test-session-secret');
  assert.notEqual(encrypted, 'refresh-token-secret');
  assert.equal(await decryptToken(encrypted, 'test-session-secret'), 'refresh-token-secret');
  const cookie = sessionCookie('opaque-session');
  assert.match(cookie, /HttpOnly/);
  assert.match(cookie, /Secure/);
  assert.match(cookie, /SameSite=Lax/);
  assert.equal(readCookie(cookie, 'tx_member'), 'opaque-session');
  const stateCookie = oauthCookie('browser-nonce');
  assert.match(stateCookie, /Path=\/api\/membership\/oauth\/callback/);
  assert.match(stateCookie, /HttpOnly/);
}

testCryptoAndCookie()
  .then(() => console.log('membership regression tests passed'))
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });