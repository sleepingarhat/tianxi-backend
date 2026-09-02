import { Hono } from 'hono';
import {
  buildAuthorizeUrl,
  buildSessionCookie,
  issueAdminTokenSession,
  readPresentedAdminSecret,
} from '../lib/admin-auth';

interface GateEnv {
  ADMIN_TOKEN?: string;
  SESSION_HMAC_SECRET?: string;
  GITHUB_OAUTH_CLIENT_ID?: string;
  GITHUB_OAUTH_CLIENT_SECRET?: string;
  ADMIN_GITHUB_USER?: string;
}

export const adminGateRoutes = new Hono<{ Bindings: GateEnv }>();

function githubReady(env: GateEnv): boolean {
  return !!(env.GITHUB_OAUTH_CLIENT_ID && env.SESSION_HMAC_SECRET);
}

function loginPage(reason: string, githubOn: boolean): string {
  const github = githubOn
    ? '<a class="btn ghost" href="/admin/login/github">用 GitHub 登入</a>'
    : '';
  return `<!doctype html><html lang="zh-Hant"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>天喜 · 需要登入</title>
<style>body{font-family:-apple-system,BlinkMacSystemFont,"PingFang TC",sans-serif;background:#0a0a0a;color:#eee;display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0;padding:24px}
.box{background:#181818;border:1px solid #333;border-radius:12px;padding:36px 28px;max-width:420px;width:100%;text-align:center}
h1{margin:0 0 14px;font-size:22px}p{color:#aaa;font-size:14px;margin:0 0 18px;line-height:1.55}
form{display:flex;flex-direction:column;gap:10px;margin:0 0 14px}
input{font:inherit;padding:11px 12px;border-radius:8px;border:1px solid #444;background:#111;color:#fff}
button,.btn{display:inline-block;background:#fff;color:#000;padding:10px 20px;border-radius:8px;text-decoration:none;font-weight:600;border:0;cursor:pointer;font:inherit}
.btn.ghost{background:transparent;color:#fff;border:1px solid #555;margin-top:6px}</style>
</head><body><div class="box"><h1>天喜 · 內部控制台</h1><p>${reason}</p>
<form method="post" action="/admin/login">
<input type="password" name="credential" autocomplete="current-password" placeholder="內部密鑰" required>
<button type="submit">進入監控台</button>
</form>
${github}
</div></body></html>`;
}

adminGateRoutes.get('/login', (c) => {
  const on = githubReady(c.env);
  return c.html(loginPage(
    on
      ? '可用內部密鑰或 GitHub 登入。只貼密鑰本身，或連舊網址一齊貼都可以。'
      : '請用內部密鑰登入。只貼密鑰本身即可；若貼左整條舊監控網址亦會自動抽出 token。',
    on,
  ));
});

adminGateRoutes.post('/login', async (c) => {
  const presented = await readPresentedAdminSecret(c.req.raw);
  if (!presented) {
    return c.html(loginPage('未讀到密鑰。請貼內部密鑰或舊監控網址。', githubReady(c.env)), 401);
  }
  if (!c.env.ADMIN_TOKEN) {
    return c.html(loginPage('伺服器未設定內部密鑰。', githubReady(c.env)), 503);
  }
  const session = await issueAdminTokenSession(c.env, presented);
  if (!session) {
    return c.html(loginPage('密鑰不正確。請確認係雲端 ADMIN_TOKEN，唔係用戶端會員密碼。', githubReady(c.env)), 401);
  }
  return new Response(null, {
    status: 302,
    headers: { Location: '/admin', 'Set-Cookie': buildSessionCookie(session) },
  });
});

adminGateRoutes.get('/login/github', (c) => {
  const env = c.env;
  if (!env.GITHUB_OAUTH_CLIENT_ID || !env.SESSION_HMAC_SECRET) {
    return c.html(loginPage('GitHub OAuth 未設定，請用內部密鑰登入。', false), 503);
  }
  const url = new URL(c.req.url);
  const redirectUri = `${url.origin}/admin/callback`;
  const state = crypto.randomUUID();
  const authorize = buildAuthorizeUrl({ clientId: env.GITHUB_OAUTH_CLIENT_ID, redirectUri, state });
  const stateCookie = `admin_oauth_state=${state}; Path=/admin; HttpOnly; Secure; SameSite=Lax; Max-Age=600`;
  return new Response(null, { status: 302, headers: { Location: authorize, 'Set-Cookie': stateCookie } });
});
