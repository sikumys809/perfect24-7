import type { VercelRequest, VercelResponse } from '@vercel/node';
import crypto from 'node:crypto';
import { createClient } from '@supabase/supabase-js';

// 税理士事務所のログイン（メール＋パスワード）。自己登録→承認(pending→active)制。
//  GET  /api/office            … ログイン/新規登録ページ（セッションがあればダッシュボードへ）
//  POST /api/office (login)    … メール＋パスワードでログイン（password_hash が NULL の事務所は初回設定）
//  POST /api/office (signup)   … 新規事務所を pending で作成（承認後にログイン可）
//  GET  /api/office?logout=1   … ログアウト
// 認証の有効化は env OFFICE_AUTH=on（OFF の間はダッシュボード等は従来どおり開く）。
export const config = { maxDuration: 20 };

const SUPABASE_URL = (process.env.SUPABASE_URL ?? '').replace(/\/rest\/v1\/?$/, '');
const SUPABASE_KEY = process.env.SUPABASE_KEY ?? '';
const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

const COOKIE = 'p247_office';

function esc(s: unknown): string {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] as string);
}
function sign(officeId: string): string {
  return `${officeId}.${crypto.createHmac('sha256', SUPABASE_KEY).update(officeId).digest('base64url')}`;
}
function verify(value: string | undefined): string | null {
  if (!value) return null;
  const i = value.lastIndexOf('.');
  if (i < 0) return null;
  const id = value.slice(0, i);
  const sig = value.slice(i + 1);
  const exp = crypto.createHmac('sha256', SUPABASE_KEY).update(id).digest('base64url');
  const a = Buffer.from(sig);
  const b = Buffer.from(exp);
  return a.length === b.length && crypto.timingSafeEqual(a, b) ? id : null;
}
function parseCookies(req: VercelRequest): Record<string, string> {
  const out: Record<string, string> = {};
  const raw = req.headers.cookie;
  if (!raw) return out;
  for (const part of raw.split(';')) {
    const idx = part.indexOf('=');
    if (idx > 0) out[part.slice(0, idx).trim()] = decodeURIComponent(part.slice(idx + 1).trim());
  }
  return out;
}
function hashPassword(pw: string): string {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(pw, salt, 64).toString('hex');
  return `scrypt$${salt}$${hash}`;
}
function verifyPassword(pw: string, stored: string | null): boolean {
  if (!stored) return false;
  const [scheme, salt, hash] = stored.split('$');
  if (scheme !== 'scrypt' || !salt || !hash) return false;
  const h = crypto.scryptSync(pw, salt, 64).toString('hex');
  const a = Buffer.from(h);
  const b = Buffer.from(hash);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}
function cookieHeader(value: string, maxAge: number): string {
  return `${COOKIE}=${value}; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=${maxAge}`;
}

function page(opts: { mode?: 'login' | 'signup'; error?: string; info?: string; email?: string } = {}): string {
  const mode = opts.mode ?? 'login';
  return `<!doctype html><html lang="ja"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>事務所ログイン｜パーフェクト24/7</title>
<style>
  body{margin:0;background:#0f172a;color:#0f172a;font-family:-apple-system,BlinkMacSystemFont,"Hiragino Kaku Gothic ProN","Noto Sans JP",sans-serif;}
  .top{padding:26px 0 6px;text-align:center;color:#fff;}
  .logo{font-weight:800;font-size:1.4rem;background:linear-gradient(90deg,#38bdf8,#818cf8);-webkit-background-clip:text;background-clip:text;color:transparent;}
  .logo .mk{-webkit-text-fill-color:initial;}
  .sub{color:#94a3b8;font-size:.85rem;margin-top:4px;}
  .card{max-width:400px;margin:18px auto;background:#fff;border-radius:16px;padding:24px;}
  h2{margin:0 0 14px;font-size:1.1rem;}
  label{display:block;font-size:.82rem;font-weight:700;color:#334155;margin:12px 0 4px;}
  input{width:100%;font-size:1rem;padding:11px;border:1px solid #cbd5e1;border-radius:10px;box-sizing:border-box;}
  button{width:100%;margin-top:18px;font-size:1.02rem;font-weight:700;padding:13px;border:none;border-radius:11px;background:#2563eb;color:#fff;cursor:pointer;}
  .switch{margin-top:16px;text-align:center;font-size:.85rem;color:#64748b;}
  .switch a{color:#2563eb;text-decoration:none;font-weight:700;}
  .err{margin-top:12px;color:#dc2626;font-size:.85rem;text-align:center;}
  .info{margin-top:12px;color:#047857;font-size:.85rem;text-align:center;background:#ecfdf5;border:1px solid #a7f3d0;border-radius:10px;padding:10px;}
  .note{font-size:.78rem;color:#64748b;margin-top:6px;line-height:1.5;}
</style></head><body>
<div class="top"><div class="logo"><span class="mk">⚡</span>パーフェクト24/7</div><div class="sub">税理士事務所 管理画面</div></div>
<div class="card">
${
  mode === 'signup'
    ? `<h2>新規事務所の登録</h2>
  <form method="post" action="/api/office">
    <input type="hidden" name="action" value="signup">
    <label>事務所名 <span style="color:#dc2626">*</span></label>
    <input name="name" required placeholder="〇〇税理士事務所">
    <label>メールアドレス <span style="color:#dc2626">*</span></label>
    <input name="email" type="email" inputmode="email" autocapitalize="off" required value="${esc(opts.email ?? '')}">
    <label>パスワード <span style="color:#dc2626">*</span>（8文字以上）</label>
    <input name="password" type="password" minlength="8" required>
    <button type="submit">登録を申請する</button>
    <div class="note">登録後、運営の承認をもってログインできるようになります。</div>
  </form>
  <div class="switch">アカウントをお持ちですか？ <a href="/api/office">ログイン</a></div>`
    : `<h2>ログイン</h2>
  <form method="post" action="/api/office">
    <input type="hidden" name="action" value="login">
    <label>メールアドレス</label>
    <input name="email" type="email" inputmode="email" autocapitalize="off" required value="${esc(opts.email ?? '')}">
    <label>パスワード</label>
    <input name="password" type="password" required>
    <button type="submit">ログイン</button>
    <div class="note">初めてのログインでは、入力したパスワードが設定されます。</div>
  </form>
  <div class="switch">事務所の新規登録は <a href="/api/office?signup=1">こちら</a></div>`
}
${opts.error ? `<div class="err">${esc(opts.error)}</div>` : ''}
${opts.info ? `<div class="info">${esc(opts.info)}</div>` : ''}
</div></body></html>`;
}

function send(res: VercelResponse, status: number, html: string) {
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  return res.status(status).send(html);
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  // ログアウト
  if (req.method === 'GET' && req.query.logout) {
    res.setHeader('Set-Cookie', cookieHeader('', 0));
    return send(res, 200, page({ info: 'ログアウトしました。' }));
  }

  if (req.method === 'GET') {
    // 既にログイン済みならダッシュボードへ
    if (verify(parseCookies(req)[COOKIE])) {
      res.setHeader('Location', '/api/dashboard');
      return res.status(302).end();
    }
    return send(res, 200, page({ mode: req.query.signup ? 'signup' : 'login' }));
  }

  if (req.method !== 'POST') return res.status(405).send('Method Not Allowed');

  const b: any = req.body ?? {};
  const action = b.action;
  const email = String(b.email ?? '').trim().toLowerCase();
  const password = String(b.password ?? '');

  // ── 新規登録（pending で作成） ──
  if (action === 'signup') {
    const name = String(b.name ?? '').trim();
    if (!name || !email || password.length < 8) {
      return send(res, 400, page({ mode: 'signup', email, error: '事務所名・メール・8文字以上のパスワードを入力してください。' }));
    }
    const { data: dup } = await supabase.from('offices').select('id').ilike('email', email).limit(1);
    if (dup && dup.length) {
      return send(res, 409, page({ mode: 'signup', email, error: 'このメールアドレスは既に登録されています。' }));
    }
    const { error } = await supabase.from('offices').insert({ name, email, password_hash: hashPassword(password), status: 'pending' });
    if (error) {
      console.error('office signup error', error);
      return send(res, 500, page({ mode: 'signup', email, error: '登録に失敗しました。時間をおいて再度お試しください。' }));
    }
    return send(res, 200, page({ mode: 'login', email, info: '登録を申請しました。運営の承認後にログインできます。' }));
  }

  // ── ログイン ──
  if (action === 'login') {
    if (!email || !password) return send(res, 400, page({ email, error: 'メールとパスワードを入力してください。' }));
    const { data } = await supabase
      .from('offices')
      .select('id, status, password_hash')
      .ilike('email', email)
      .limit(1);
    const office = data && data.length ? data[0] : null;
    if (!office) return send(res, 401, page({ email, error: 'メールまたはパスワードが正しくありません。' }));
    if (office.status === 'pending') return send(res, 403, page({ email, error: 'このアカウントはまだ承認されていません。' }));
    if (office.status !== 'active') return send(res, 403, page({ email, error: 'このアカウントは利用できません。' }));

    if (!office.password_hash) {
      // 初回ログイン: 入力されたパスワードを設定
      if (password.length < 8) return send(res, 400, page({ email, error: '初回設定のパスワードは8文字以上にしてください。' }));
      await supabase.from('offices').update({ password_hash: hashPassword(password) }).eq('id', office.id);
    } else if (!verifyPassword(password, office.password_hash)) {
      return send(res, 401, page({ email, error: 'メールまたはパスワードが正しくありません。' }));
    }

    res.setHeader('Set-Cookie', cookieHeader(encodeURIComponent(sign(office.id)), 2592000));
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Location', '/api/dashboard');
    return res.status(303).end();
  }

  return res.status(400).send('Bad Request');
}
