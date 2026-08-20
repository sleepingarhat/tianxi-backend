import { Hono } from 'hono';
import type { Env } from '../types';
import {
  CHECKOUT_URLS,
  OAUTH_COOKIE,
  SESSION_COOKIE,
  WHOP_ACCESS_HUB_URL,
  WHOP_OAUTH_CLIENT_ID,
  decryptToken,
  deriveEntitlement,
  encryptToken,
  ensureMembershipTables,
  membershipSecret,
  oauthCookie,
  randomToken,
  readCookie,
  sessionCookie,
  sha256,
  type MembershipEntitlement,
} from '../lib/membership';
import { projectTodayPicksForPublic } from '../lib/public-today-picks';
import { runRaceDayReportCompute } from './analyze';

type TokenSet = { access_token: string; refresh_token: string; expires_in?: number };
type SessionRow = {
  token_hash: string;
  whop_user_id: string;
  username: string | null;
  access_token_enc: string;
  refresh_token_enc: string;
  token_expires_at: string;
  expires_at: string;
};
type CurrentMembership = { row: SessionRow; entitlement: MembershipEntitlement };

export const membershipRoutes = new Hono<{ Bindings: Env }>();

function noStore(c: any) {
  c.header('Cache-Control', 'no-store, private');
  c.header('Pragma', 'no-cache');
}

function callbackUri(requestUrl: string): string {
  const origin = new URL(requestUrl).origin;
  const allowed = new Set([
    'https://tianxi.racing',
    'https://tianxi-backend.tianxi-entertainment.workers.dev',
  ]);
  const safeOrigin = allowed.has(origin) || /^http:\/\/(?:127\.0\.0\.1|localhost)(?::\d+)?$/.test(origin)
    ? origin
    : 'https://tianxi.racing';
  return `${safeOrigin}/api/membership/oauth/callback`;
}

function oauthError(c: any, message: string): Response {
  return c.text(message, 400, {
    'Content-Type': 'text/plain; charset=utf-8',
    'Cache-Control': 'no-store',
  });
}

async function fetchToken(form: URLSearchParams): Promise<TokenSet> {
  const response = await fetch('https://api.whop.com/oauth/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: form,
  });
  if (!response.ok) throw new Error(`whop token exchange failed: ${response.status}`);
  const data = await response.json() as Partial<TokenSet>;
  if (!data.access_token || !data.refresh_token) throw new Error('whop token response incomplete');
  return data as TokenSet;
}

async function refreshToken(refresh: string): Promise<TokenSet> {
  const response = await fetch('https://api.whop.com/oauth/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'refresh_token',
      client_id: WHOP_OAUTH_CLIENT_ID,
      refresh_token: refresh,
    }),
  });
  if (!response.ok) throw new Error(`whop token refresh failed: ${response.status}`);
  const data = await response.json() as Partial<TokenSet>;
  if (!data.access_token) throw new Error('whop refresh response incomplete');
  return {
    access_token: data.access_token,
    refresh_token: data.refresh_token || refresh,
    expires_in: data.expires_in,
  };
}

async function fetchUserInfo(accessToken: string): Promise<{ id: string; username?: string }> {
  const response = await fetch('https://api.whop.com/oauth/userinfo', {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (!response.ok) throw new Error(`whop userinfo failed: ${response.status}`);
  const data: any = await response.json();
  const id = typeof data?.sub === 'string' ? data.sub : data?.id;
  if (typeof id !== 'string' || !id) throw new Error('whop userinfo missing subject');
  const username = [data?.username, data?.name]
    .find((value) => typeof value === 'string' && value.trim());
  return { id, username };
}

async function fetchMemberships(accessToken: string): Promise<unknown[]> {
  const response = await fetch('https://api.whop.com/api/v1/memberships', {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (!response.ok) throw new Error(`whop memberships failed: ${response.status}`);
  const data: any = await response.json();
  if (Array.isArray(data)) return data;
  if (Array.isArray(data?.data)) return data.data;
  if (Array.isArray(data?.memberships)) return data.memberships;
  return [];
}

async function persistEntitlement(
  db: D1Database,
  userId: string,
  entitlement: MembershipEntitlement,
): Promise<void> {
  await db.prepare(
    `INSERT INTO membership_entitlements
      (whop_user_id, membership_id, product_id, plan, active, valid_until, cancel_at_period_end, checked_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, datetime('now'))
     ON CONFLICT(whop_user_id) DO UPDATE SET
       membership_id=excluded.membership_id, product_id=excluded.product_id,
       plan=excluded.plan, active=excluded.active, valid_until=excluded.valid_until,
       cancel_at_period_end=excluded.cancel_at_period_end, checked_at=excluded.checked_at`,
  ).bind(
    userId,
    entitlement.membershipId ?? null,
    entitlement.productId ?? null,
    entitlement.plan ?? null,
    entitlement.active ? 1 : 0,
    entitlement.validUntil ?? null,
    entitlement.cancelAtPeriodEnd ? 1 : 0,
  ).run();
}

async function currentMembership(c: any): Promise<CurrentMembership | null> {
  const secret = membershipSecret(c.env);
  const opaque = readCookie(c.req.header('Cookie'), SESSION_COOKIE);
  if (!secret || !opaque) return null;
  const tokenHash = await sha256(opaque);
  const row = await c.env.DB.prepare(
    `SELECT * FROM membership_sessions
     WHERE token_hash = ? AND expires_at > datetime('now')`,
  ).bind(tokenHash).first().catch(() => null) as SessionRow | null;
  if (!row) return null;

  let accessToken: string;
  let refresh: string;
  try {
    accessToken = await decryptToken(row.access_token_enc, secret);
    refresh = await decryptToken(row.refresh_token_enc, secret);
  } catch {
    await c.env.DB.prepare('DELETE FROM membership_sessions WHERE token_hash = ?').bind(tokenHash).run();
    return null;
  }

  const expiresAt = Date.parse(row.token_expires_at);
  if (!Number.isFinite(expiresAt) || expiresAt <= Date.now() + 30_000) {
    try {
      const refreshed = await refreshToken(refresh);
      accessToken = refreshed.access_token;
      refresh = refreshed.refresh_token;
      const tokenExpiresAt = new Date(Date.now() + Math.max(60, refreshed.expires_in ?? 3600) * 1000).toISOString();
      await c.env.DB.prepare(
        `UPDATE membership_sessions
         SET access_token_enc=?, refresh_token_enc=?, token_expires_at=?, last_seen_at=datetime('now')
         WHERE token_hash=?`,
      ).bind(
        await encryptToken(accessToken, secret),
        await encryptToken(refresh, secret),
        tokenExpiresAt,
        tokenHash,
      ).run();
    } catch {
      return null;
    }
  }

  try {
    const entitlement = deriveEntitlement(await fetchMemberships(accessToken));
    await persistEntitlement(c.env.DB, row.whop_user_id, entitlement);
    await c.env.DB.prepare(
      `UPDATE membership_sessions SET last_seen_at=datetime('now') WHERE token_hash=?`,
    ).bind(tokenHash).run();
    return { row, entitlement };
  } catch {
    // Fail closed: stale sessions cannot grant access while Whop is unavailable.
    return null;
  }
}

membershipRoutes.get('/login', async (c) => {
  noStore(c);
  const secret = membershipSecret(c.env);
  if (!secret) return c.json({ error: 'membership login unavailable' }, 503);
  await ensureMembershipTables(c.env.DB);
  const state = randomToken();
  const verifier = randomToken(48);
  const browserNonce = randomToken();
  const redirectUri = callbackUri(c.req.url);
  await c.env.DB.prepare(
    `INSERT INTO membership_oauth_states
      (state_hash, verifier_enc, browser_nonce_hash, redirect_uri, expires_at)
     VALUES (?, ?, ?, ?, datetime('now', '+10 minutes'))`,
  ).bind(
    await sha256(state),
    await encryptToken(verifier, secret),
    await sha256(browserNonce),
    redirectUri,
  ).run();
  c.header('Set-Cookie', oauthCookie(browserNonce));
  const authorize = new URL('https://api.whop.com/oauth/authorize');
  authorize.search = new URLSearchParams({
    client_id: WHOP_OAUTH_CLIENT_ID,
    redirect_uri: redirectUri,
    response_type: 'code',
    scope: 'openid profile',
    code_challenge: await sha256(verifier),
    code_challenge_method: 'S256',
    state,
  }).toString();
  return c.redirect(authorize.toString(), 302);
});

membershipRoutes.get('/oauth/callback', async (c) => {
  noStore(c);
  const code = c.req.query('code');
  const state = c.req.query('state');
  const browserNonce = readCookie(c.req.header('Cookie'), OAUTH_COOKIE);
  c.header('Set-Cookie', oauthCookie('', 0));
  if (!code || !state || !browserNonce) return oauthError(c, 'invalid membership callback');
  const secret = membershipSecret(c.env);
  if (!secret) return oauthError(c, 'membership login unavailable');
  await ensureMembershipTables(c.env.DB);
  const stateHash = await sha256(state);
  const browserNonceHash = await sha256(browserNonce);
  const stateRow = await c.env.DB.prepare(
    `SELECT verifier_enc, redirect_uri FROM membership_oauth_states
     WHERE state_hash=? AND browser_nonce_hash=?
       AND used_at IS NULL AND expires_at > datetime('now')`,
  ).bind(stateHash, browserNonceHash).first<{ verifier_enc: string; redirect_uri: string }>();
  const consumption = await c.env.DB.prepare(
    `UPDATE membership_oauth_states SET used_at=datetime('now')
     WHERE state_hash=? AND browser_nonce_hash=?
       AND used_at IS NULL AND expires_at > datetime('now')`,
  ).bind(stateHash, browserNonceHash).run();
  if (!stateRow || Number((consumption.meta as any)?.changes ?? 0) !== 1) {
    return oauthError(c, 'expired or already used login state');
  }

  try {
    const verifier = await decryptToken(stateRow.verifier_enc, secret);
    const tokens = await fetchToken(new URLSearchParams({
      grant_type: 'authorization_code',
      client_id: WHOP_OAUTH_CLIENT_ID,
      code,
      redirect_uri: stateRow.redirect_uri,
      code_verifier: verifier,
    }));
    const [user, memberships] = await Promise.all([
      fetchUserInfo(tokens.access_token),
      fetchMemberships(tokens.access_token),
    ]);
    const entitlement = deriveEntitlement(memberships);
    const opaque = randomToken();
    await c.env.DB.prepare(
      `INSERT INTO membership_sessions
       (token_hash, whop_user_id, username, access_token_enc, refresh_token_enc, token_expires_at, expires_at)
       VALUES (?, ?, ?, ?, ?, ?, datetime('now', '+30 days'))`,
    ).bind(
      await sha256(opaque),
      user.id,
      user.username ?? null,
      await encryptToken(tokens.access_token, secret),
      await encryptToken(tokens.refresh_token, secret),
      new Date(Date.now() + Math.max(60, tokens.expires_in ?? 3600) * 1000).toISOString(),
    ).run();
    await persistEntitlement(c.env.DB, user.id, entitlement);
    c.header('Set-Cookie', sessionCookie(opaque), { append: true });
    return c.redirect('/pro/', 302);
  } catch {
    return oauthError(c, 'membership verification failed');
  }
});

membershipRoutes.get('/status', async (c) => {
  noStore(c);
  const current = await currentMembership(c);
  if (!current) return c.json({ authenticated: false }, 401);
  return c.json({
    authenticated: true,
    user: current.row.username ?? undefined,
    entitlement: current.entitlement,
    telegramAccessUrl: current.entitlement.active ? WHOP_ACCESS_HUB_URL : undefined,
  });
});

membershipRoutes.post('/logout', async (c) => {
  noStore(c);
  const opaque = readCookie(c.req.header('Cookie'), SESSION_COOKIE);
  if (opaque) {
    await c.env.DB.prepare('DELETE FROM membership_sessions WHERE token_hash=?')
      .bind(await sha256(opaque)).run().catch(() => {});
  }
  c.header('Set-Cookie', sessionCookie('', 0));
  return c.json({ ok: true });
});

membershipRoutes.get('/checkout/:plan', (c) => {
  noStore(c);
  const plan = c.req.param('plan');
  if (plan !== 'day' && plan !== 'month') return c.json({ error: 'plan not found' }, 404);
  return c.redirect(CHECKOUT_URLS[plan], 303);
});

membershipRoutes.get('/pro/today', async (c) => {
  noStore(c);
  const current = await currentMembership(c);
  if (!current?.entitlement.active) return c.json({ error: 'active membership required' }, 403);
  try {
    const result = await runRaceDayReportCompute(c.env.DB, 'v12');
    if (result?.error) return c.json({ error: 'pro picks unavailable' }, (Number(result.status) || 503) as any);
    return c.json(projectTodayPicksForPublic(result));
  } catch {
    return c.json({ error: 'pro picks unavailable' }, 503);
  }
});

export function proPage(): string {
  return `<!doctype html><html lang="zh-HK"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>天喜 Pro 會員中心</title><style>
*{box-sizing:border-box}body{margin:0;background:#f5f1e8;color:#24201b;font-family:-apple-system,BlinkMacSystemFont,"Noto Sans HK",sans-serif}.wrap{max-width:760px;margin:auto;padding:32px 20px 54px}.k{letter-spacing:.14em;font:700 11px monospace;color:#886b34}h1{font-family:Georgia,serif;font-size:34px;margin:8px 0}h2{font-size:16px;margin:28px 0 10px}.card{background:#fff;border:1px solid #ded6c6;border-radius:14px;padding:18px;margin:12px 0;box-shadow:0 5px 18px #463c2b0a}.muted{color:#756c5e;font-size:14px;line-height:1.65}.btn{display:inline-block;border:0;border-radius:9px;background:#74521f;color:#fff;padding:11px 14px;font:700 14px inherit;text-decoration:none;cursor:pointer}.ghost{background:#ede5d6;color:#4d3b21}.hidden{display:none}.race{border-top:1px solid #eee5d7;padding:13px 0}.race:first-child{border-top:0}.title{font-weight:800}.picks{display:flex;flex-wrap:wrap;gap:7px;margin-top:8px}.pick{background:#f5f0e5;border-radius:7px;padding:6px 8px;font-size:13px}.pick b{color:#76531d}#error{color:#9a3d32;font-size:13px}</style></head><body><main class="wrap"><div class="k">TIANXI PRO</div><h1>會員中心</h1><p class="muted">全卡賽前預測只會在這個已核實頁面載入。</p>
<section id="loading" class="card">正在核實 Whop 會籍…</section>
<section id="guest" class="card hidden"><b>請先登入</b><p class="muted">請使用購買時的 Whop 帳戶。</p><a class="btn" href="/api/membership/login">使用 Whop 登入</a></section>
<section id="inactive" class="card hidden"><b>目前沒有有效天喜會籍</b><p class="muted">付款成功頁、電郵或會員編號本身不會解鎖。請確認使用購買時的 Whop 帳戶。</p><a class="btn" href="/api/membership/checkout/month">查看月費方案</a></section>
<section id="member" class="hidden"><div class="card"><b id="hello">已核實會員</b><p class="muted" id="plan"></p><a id="tg" class="btn" target="_blank" rel="noopener">在 Whop 開啟 Telegram VIP</a> <button id="logout" class="btn ghost">登出</button></div><h2>今日全卡預測</h2><div id="picks" class="card">載入中…</div></section><p id="error"></p></main><script>
const q=s=>document.querySelector(s),show=s=>q(s).classList.remove('hidden'),hide=s=>q(s).classList.add('hidden');
function txt(v){return typeof v==='string'||typeof v==='number'?String(v):''}function pick(p){let n=txt(p.horseNumber),name=txt(p.nameCh)||txt(p.nameEn),r=txt(p.rank),w=typeof p.pWin==='number'?' '+Math.round(p.pWin*100)+'%':'';return '<span class="pick">'+(r?'<b>#'+r+'</b> ':'')+(n?n+'號 ':'')+name+w+'</span>'}
async function load(){let r=await fetch('/api/membership/pro/today',{credentials:'same-origin',cache:'no-store'}),d=await r.json();if(!r.ok)throw Error('暫未能載入全卡預測');let races=Array.isArray(d.races)?d.races:[];q('#picks').innerHTML=races.length?races.map(x=>'<div class="race"><div class="title">第 '+txt(x.raceNumber)+' 場 '+txt(x.title)+'</div><div class="picks">'+(Array.isArray(x.picks)?x.picks.slice(0,4).map(pick).join(''):'')+'</div></div>').join(''):'今日未有可用排位表'}
async function status(){let r=await fetch('/api/membership/status',{credentials:'same-origin',cache:'no-store'});hide('#loading');if(r.status===401){show('#guest');return}let d=await r.json();if(!d.entitlement?.active){show('#inactive');return}show('#member');if(d.user)q('#hello').textContent='你好，'+d.user;let a=[d.entitlement.plan==='month'?'月費會員':'單日通行證'];if(d.entitlement.validUntil)a.push('有效至 '+new Date(d.entitlement.validUntil).toLocaleString('zh-HK'));if(d.entitlement.cancelAtPeriodEnd)a.push('已設定期末取消');q('#plan').textContent=a.join(' · ');q('#tg').href=d.telegramAccessUrl;await load()}
q('#logout').onclick=async()=>{await fetch('/api/membership/logout',{method:'POST',credentials:'same-origin'});location.reload()};status().catch(()=>{hide('#loading');q('#error').textContent='暫未能核實會籍，請稍後再試。'});</script></body></html>`;
}