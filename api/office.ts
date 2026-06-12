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
const ADMIN_KEY = process.env.ADMIN_KEY ?? ''; // 運営によるパスワードリセット用（メール未設定時のフォールバック）
const RESEND_API_KEY = process.env.RESEND_API_KEY ?? ''; // パスワード再設定メールの送信
const MAIL_FROM = process.env.MAIL_FROM ?? 'パーフェクト24/7 <onboarding@resend.dev>';
const APP_ORIGIN = (process.env.APP_ORIGIN ?? 'https://perfect24-7.vercel.app').replace(/\/$/, '');

// パスワード再設定トークン（DB不要・30分有効）。署名鍵に現在の password_hash を混ぜるため、
// 再設定するとリンクは自動失効＝実質ワンタイム。
function makeResetToken(officeId: string, passwordHash: string | null, nowMs: number): string {
  const exp = nowMs + 30 * 60 * 1000;
  const payload = `${officeId}.${exp}`;
  const sig = crypto.createHmac('sha256', `${SUPABASE_KEY}:${passwordHash ?? ''}`).update(payload).digest('base64url');
  return `${payload}.${sig}`;
}
async function verifyResetToken(token: string, nowMs: number): Promise<string | null> {
  const parts = String(token).split('.');
  if (parts.length !== 3) return null;
  const [officeId, expStr, sig] = parts;
  const exp = Number(expStr);
  if (!exp || exp < nowMs) return null;
  const { data } = await supabase.from('offices').select('id, password_hash, status').eq('id', officeId).single();
  if (!data || data.status !== 'active') return null;
  const expect = crypto.createHmac('sha256', `${SUPABASE_KEY}:${data.password_hash ?? ''}`).update(`${officeId}.${expStr}`).digest('base64url');
  const a = Buffer.from(sig);
  const b = Buffer.from(expect);
  return a.length === b.length && crypto.timingSafeEqual(a, b) ? officeId : null;
}
async function sendResetEmail(to: string, link: string): Promise<boolean> {
  if (!RESEND_API_KEY) return false;
  try {
    const r = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { Authorization: `Bearer ${RESEND_API_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        from: MAIL_FROM,
        to: [to],
        subject: '【パーフェクト24/7】パスワード再設定のご案内',
        html: `<p>パスワード再設定のリクエストを受け付けました。</p>
<p>下のボタン（リンク）から新しいパスワードを設定してください。<b>30分間有効</b>です。</p>
<p><a href="${link}" style="display:inline-block;background:#2563eb;color:#fff;padding:10px 18px;border-radius:8px;text-decoration:none;font-weight:700">パスワードを再設定する</a></p>
<p style="color:#64748b;font-size:13px">ボタンが押せない場合はこのURLを開いてください:<br>${link}</p>
<p style="color:#64748b;font-size:13px">心当たりがない場合は、このメールを破棄してください。</p>`,
      }),
    });
    return r.ok;
  } catch {
    return false;
  }
}

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
  <div class="switch">事務所の新規登録は <a href="/api/office?signup=1">こちら</a></div>
  <div class="switch"><a href="/api/office?forgot=1" style="color:#94a3b8;font-weight:400">パスワードをお忘れの方</a></div>`
}
${opts.error ? `<div class="err">${esc(opts.error)}</div>` : ''}
${opts.info ? `<div class="info">${esc(opts.info)}</div>` : ''}
</div></body></html>`;
}

// 小さなフォーム用の共通シェル
function shell(title: string, inner: string): string {
  return `<!doctype html><html lang="ja"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${esc(title)}｜パーフェクト24/7</title>
<style>
  body{margin:0;background:#0f172a;font-family:-apple-system,BlinkMacSystemFont,"Hiragino Kaku Gothic ProN","Noto Sans JP",sans-serif;}
  .top{padding:26px 0 6px;text-align:center;}
  .logo{font-weight:800;font-size:1.3rem;background:linear-gradient(90deg,#38bdf8,#818cf8);-webkit-background-clip:text;background-clip:text;color:transparent;} .logo .mk{-webkit-text-fill-color:initial;}
  .card{max-width:400px;margin:16px auto;background:#fff;border-radius:16px;padding:24px;}
  h2{margin:0 0 6px;font-size:1.1rem;} label{display:block;font-size:.82rem;font-weight:700;color:#334155;margin:12px 0 4px;}
  input{width:100%;font-size:1rem;padding:11px;border:1px solid #cbd5e1;border-radius:10px;box-sizing:border-box;}
  button{width:100%;margin-top:18px;font-size:1.02rem;font-weight:700;padding:13px;border:none;border-radius:11px;background:#2563eb;color:#fff;cursor:pointer;}
  .err{margin-top:12px;color:#dc2626;font-size:.85rem;text-align:center;} .info{margin-top:12px;color:#047857;font-size:.85rem;text-align:center;background:#ecfdf5;border:1px solid #a7f3d0;border-radius:10px;padding:10px;}
  .note{font-size:.82rem;color:#64748b;margin-top:10px;line-height:1.7;} a{color:#2563eb;text-decoration:none;font-weight:700;} .center{text-align:center;margin-top:14px;}
</style></head><body>
<div class="top"><div class="logo"><span class="mk">⚡</span>パーフェクト24/7</div></div>
<div class="card">${inner}</div></body></html>`;
}
function changePwPage(o: { error?: string; info?: string } = {}): string {
  return shell('パスワード変更', `<h2>パスワード変更</h2>
  <form method="post" action="/api/office">
    <input type="hidden" name="action" value="changepw">
    <label>現在のパスワード</label><input name="current" type="password" required>
    <label>新しいパスワード（8文字以上）</label><input name="newpw" type="password" minlength="8" required>
    <button type="submit">変更する</button>
  </form>
  ${o.error ? `<div class="err">${esc(o.error)}</div>` : ''}${o.info ? `<div class="info">${esc(o.info)}</div>` : ''}
  <div class="center"><a href="/api/dashboard">← ダッシュボードへ</a></div>`);
}
function forgotPage(o: { error?: string; info?: string } = {}): string {
  return shell('パスワード再設定', `<h2>パスワード再設定</h2>
  <p class="note">ご登録のメールアドレスを入力してください。パスワード再設定用のリンクをお送りします（30分間有効）。</p>
  <form method="post" action="/api/office">
    <input type="hidden" name="action" value="forgot">
    <label>メールアドレス</label><input name="email" type="email" autocapitalize="off" required>
    <button type="submit">再設定リンクを送る</button>
  </form>
  ${o.error ? `<div class="err">${esc(o.error)}</div>` : ''}${o.info ? `<div class="info">${esc(o.info)}</div>` : ''}
  <div class="center"><a href="/api/office">← ログインへ戻る</a></div>`);
}
function resetPwPage(token: string, o: { error?: string } = {}): string {
  return shell('新しいパスワードの設定', `<h2>新しいパスワードの設定</h2>
  <p class="note">新しいパスワードを入力してください（8文字以上）。</p>
  <form method="post" action="/api/office">
    <input type="hidden" name="action" value="resetpw">
    <input type="hidden" name="token" value="${esc(token)}">
    <label>新しいパスワード</label><input name="newpw" type="password" minlength="8" required>
    <button type="submit">設定する</button>
  </form>
  ${o.error ? `<div class="err">${esc(o.error)}</div>` : ''}`);
}
function invalidResetPage(): string {
  return shell('リンクが無効です', `<h2>リンクが無効か期限切れです</h2>
  <p class="note">パスワード再設定リンクの有効期限は30分です。お手数ですが、もう一度お試しください。</p>
  <div class="center"><a href="/api/office?forgot=1">再設定をやり直す</a></div>`);
}
function adminPage(o: { error?: string; info?: string } = {}): string {
  return shell('運営: パスワードリセット', `<h2>運営: パスワードリセット</h2>
  <p class="note">対象事務所のパスワードを無効化します。対象事務所は次回ログイン時に入力したパスワードが新しいパスワードとして設定されます。</p>
  <form method="post" action="/api/office">
    <input type="hidden" name="action" value="adminreset">
    <label>対象事務所のメールアドレス</label><input name="email" type="email" autocapitalize="off" required>
    <label>管理キー（ADMIN_KEY）</label><input name="adminkey" type="password" required>
    <button type="submit">リセットする</button>
  </form>
  ${o.error ? `<div class="err">${esc(o.error)}</div>` : ''}${o.info ? `<div class="info">${esc(o.info)}</div>` : ''}`);
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
    if (req.query.forgot) return send(res, 200, forgotPage());
    if (req.query.admin) return send(res, 200, adminPage());
    if (typeof req.query.reset === 'string') {
      const officeId = await verifyResetToken(req.query.reset, Date.now());
      return send(res, officeId ? 200 : 400, officeId ? resetPwPage(req.query.reset) : invalidResetPage());
    }
    const sid = verify(parseCookies(req)[COOKIE]);
    if (req.query.settings) {
      if (!sid) {
        res.setHeader('Location', '/api/office');
        return res.status(302).end();
      }
      return send(res, 200, changePwPage());
    }
    // 既にログイン済みならダッシュボードへ
    if (sid) {
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

  // ── パスワード変更（ログイン中・現パスワード確認） ──
  if (action === 'changepw') {
    const sid = verify(parseCookies(req)[COOKIE]);
    if (!sid) {
      res.setHeader('Location', '/api/office');
      return res.status(302).end();
    }
    const current = String(b.current ?? '');
    const newpw = String(b.newpw ?? '');
    const { data } = await supabase.from('offices').select('password_hash').eq('id', sid).single();
    if (!data || !verifyPassword(current, data.password_hash)) {
      return send(res, 401, changePwPage({ error: '現在のパスワードが正しくありません。' }));
    }
    if (newpw.length < 8) return send(res, 400, changePwPage({ error: '新しいパスワードは8文字以上にしてください。' }));
    await supabase.from('offices').update({ password_hash: hashPassword(newpw) }).eq('id', sid);
    return send(res, 200, changePwPage({ info: 'パスワードを変更しました。' }));
  }

  // ── パスワード再設定: リンク要求（登録メールへ送信） ──
  if (action === 'forgot') {
    // 列挙攻撃を防ぐため、結果に関わらず同じ文言を返す
    const generic = 'ご登録があれば、再設定リンクをメールでお送りしました。メールをご確認ください（30分有効）。';
    if (email) {
      const { data } = await supabase.from('offices').select('id, email, password_hash, status').ilike('email', email).limit(1);
      const office = data && data.length ? data[0] : null;
      if (office && office.status === 'active') {
        const token = makeResetToken(office.id, office.password_hash, Date.now());
        const link = `${APP_ORIGIN}/api/office?reset=${encodeURIComponent(token)}`;
        const sent = await sendResetEmail(office.email, link);
        if (!sent && !RESEND_API_KEY) {
          // メール基盤未設定: 運営が気づけるようログ。利用者には汎用文言。
          console.warn('RESEND_API_KEY 未設定のため再設定メールを送信できません。reset link=', link);
        }
      }
    }
    return send(res, 200, forgotPage({ info: generic }));
  }

  // ── パスワード再設定: 新パスワード確定（トークン検証） ──
  if (action === 'resetpw') {
    const token = String(b.token ?? '');
    const newpw = String(b.newpw ?? '');
    const officeId = await verifyResetToken(token, Date.now());
    if (!officeId) return send(res, 400, invalidResetPage());
    if (newpw.length < 8) return send(res, 400, resetPwPage(token, { error: 'パスワードは8文字以上にしてください。' }));
    await supabase.from('offices').update({ password_hash: hashPassword(newpw) }).eq('id', officeId);
    return send(res, 200, page({ mode: 'login', info: 'パスワードを再設定しました。新しいパスワードでログインしてください。' }));
  }

  // ── 運営によるパスワードリセット（ADMIN_KEY 必須・メール未設定時のフォールバック） ──
  if (action === 'adminreset') {
    if (!ADMIN_KEY || b.adminkey !== ADMIN_KEY) {
      return send(res, 403, adminPage({ error: '管理キーが正しくありません。' }));
    }
    if (!email) return send(res, 400, adminPage({ error: 'メールアドレスを入力してください。' }));
    const { data } = await supabase.from('offices').update({ password_hash: null }).ilike('email', email).select('id');
    return send(res, 200, adminPage({
      info: data && data.length
        ? '無効化しました。対象事務所は次回ログイン時に新しいパスワードを設定できます。'
        : '該当する事務所が見つかりませんでした。',
    }));
  }

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
