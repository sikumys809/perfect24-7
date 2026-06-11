import type { VercelRequest, VercelResponse } from '@vercel/node';
import crypto from 'node:crypto';
import { createClient } from '@supabase/supabase-js';

// 顧問先（送る側）向けダッシュボード。
//  GET  /api/my            … セッションがあれば自分の書類一覧、無ければ登録コードのログイン画面
//  POST /api/my (login)    … 登録コードで本人確認 → 署名付き Cookie を発行
//  GET  /api/my?logout=1   … ログアウト
// 役割は事務所側と分離: ここは「送る動機・確認」に特化し、勘定科目や試算表は見せない。
// セキュリティ: ログイン後の全クエリは必ずセッションの client_id で絞る（URL値は信用しない）。
//   Cookie は SUPABASE_KEY（サーバ秘密）で HMAC 署名し偽造不可にする。
export const config = { maxDuration: 30 };

const SUPABASE_URL = (process.env.SUPABASE_URL ?? '').replace(/\/rest\/v1\/?$/, '');
const SUPABASE_KEY = process.env.SUPABASE_KEY ?? '';
const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

const COOKIE = 'p247_client';

const DOC_LABEL: Record<string, string> = {
  receipt: '領収書', invoice: '請求書', bankbook: '通帳', credit_card: 'カード明細',
  tax_payment: '納付書', balance_certificate: '残高証明', inventory: '棚卸表',
  loan_schedule: '返済予定表', payslip: '給与明細', wage_ledger: '賃金台帳',
  fixed_asset: '固定資産', ec_payout: 'EC入金', petty_cash: '小口現金', other: 'その他',
};
const DOC_COLOR: Record<string, string> = {
  receipt: '#2563eb', invoice: '#7c3aed', bankbook: '#0d9488', credit_card: '#db2777',
  tax_payment: '#ea580c', balance_certificate: '#0891b2', inventory: '#65a30d',
  loan_schedule: '#9333ea', payslip: '#c026d3', wage_ledger: '#a21caf',
  fixed_asset: '#0369a1', ec_payout: '#16a34a', petty_cash: '#0d9488', other: '#6b7280',
};
const LINE_DOC_TYPES = ['bankbook', 'credit_card', 'inventory', 'loan_schedule', 'payslip', 'wage_ledger', 'petty_cash'];

function esc(s: unknown): string {
  return String(s ?? '').replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] as string,
  );
}
function yen(n: unknown): string {
  if (n === null || n === undefined || n === '') return '';
  const v = Number(n);
  return Number.isNaN(v) ? '' : '¥' + v.toLocaleString();
}
function fmtDate(d: unknown): string {
  return typeof d === 'string' && d ? d.slice(0, 10) : '—';
}

// ───────── セッション（署名付き Cookie） ─────────
function sign(clientId: string): string {
  const sig = crypto.createHmac('sha256', SUPABASE_KEY).update(clientId).digest('base64url');
  return `${clientId}.${sig}`;
}
function verify(value: string | undefined): string | null {
  if (!value) return null;
  const i = value.lastIndexOf('.');
  if (i < 0) return null;
  const clientId = value.slice(0, i);
  const sig = value.slice(i + 1);
  const expect = crypto.createHmac('sha256', SUPABASE_KEY).update(clientId).digest('base64url');
  const a = Buffer.from(sig);
  const b = Buffer.from(expect);
  return a.length === b.length && crypto.timingSafeEqual(a, b) ? clientId : null;
}
// 登録コードの正規化: 全角英数字→半角、空白(全角含む)・ハイフン除去、大文字化。
// 日本語IMEで全角入力されても一致するようにする。
function normCode(s: unknown): string {
  return String(s ?? '')
    .replace(/[！-～]/g, (ch) => String.fromCharCode(ch.charCodeAt(0) - 0xfee0))
    .replace(/[\s　\-­]/g, '')
    .toUpperCase();
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

const PAGE_HEAD = `<meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<style>
  :root { --bg:#f1f5f9; --card:#fff; --line:#e2e8f0; --text:#0f172a; --muted:#64748b; }
  * { box-sizing:border-box; }
  body { margin:0; background:var(--bg); color:var(--text); font-family:-apple-system,BlinkMacSystemFont,"Hiragino Kaku Gothic ProN","Noto Sans JP",sans-serif; }
  header { position:sticky; top:0; background:#0f172a; color:#fff; padding:14px 16px; display:flex; align-items:center; gap:10px; flex-wrap:wrap; z-index:10; }
  header h1 { font-size:1.05rem; margin:0; font-weight:700; }
  header .who { color:#cbd5e1; font-size:.85rem; }
  header .logout { margin-left:auto; color:#94a3b8; text-decoration:none; font-size:.78rem; }
  .wrap { max-width:680px; margin:0 auto; padding:14px; }
  .tally { display:flex; gap:10px; margin-bottom:14px; }
  .tally .box { flex:1; background:var(--card); border:1px solid var(--line); border-radius:14px; padding:12px 14px; text-align:center; }
  .tally .box .n { font-size:1.5rem; font-weight:800; }
  .tally .box .l { font-size:.72rem; color:var(--muted); margin-top:2px; }
  .filterbar { display:flex; gap:6px; overflow-x:auto; padding-bottom:8px; margin-bottom:8px; -webkit-overflow-scrolling:touch; }
  .tab { white-space:nowrap; text-decoration:none; color:var(--muted); font-size:.82rem; padding:5px 12px; border-radius:999px; border:1px solid var(--line); background:#fff; }
  .tab.active { background:#0f172a; color:#fff; border-color:#0f172a; }
  .tab b { color:#94a3b8; } .tab.active b { color:#cbd5e1; }
  .card { display:flex; gap:12px; background:var(--card); border:1px solid var(--line); border-radius:14px; padding:12px; margin-bottom:10px; }
  .thumb { flex:0 0 88px; }
  .thumb img { width:88px; height:88px; object-fit:cover; border-radius:10px; border:1px solid var(--line); background:#f8fafc; }
  .thumb .pdf, .thumb .noimg { width:88px; height:88px; display:flex; align-items:center; justify-content:center; border-radius:10px; border:1px dashed var(--line); color:var(--muted); font-size:.72rem; text-align:center; text-decoration:none; }
  .info { flex:1; min-width:0; }
  .top { display:flex; align-items:center; gap:7px; flex-wrap:wrap; margin-bottom:5px; }
  .badge { color:#fff; font-size:.7rem; font-weight:700; padding:2px 8px; border-radius:999px; }
  .side { font-size:.7rem; font-weight:700; padding:2px 8px; border-radius:999px; }
  .side.sales { color:#047857; background:#d1fae5; } .side.expense { color:#1e40af; background:#dbeafe; }
  .review { color:#b45309; background:#fef3c7; font-size:.7rem; font-weight:700; padding:2px 8px; border-radius:999px; }
  .vendor { font-size:1rem; font-weight:700; }
  .amount { font-size:1.25rem; font-weight:800; margin:2px 0; }
  .date { color:var(--muted); font-size:.8rem; }
  .empty { text-align:center; color:var(--muted); padding:50px 18px; }
  .login { max-width:380px; margin:8vh auto; background:#fff; border:1px solid var(--line); border-radius:16px; padding:24px; }
  .login h2 { margin:0 0 6px; font-size:1.15rem; }
  .login p { color:var(--muted); font-size:.85rem; margin:0 0 16px; line-height:1.6; }
  .login input { width:100%; font-size:1.15rem; letter-spacing:.15em; text-align:center; padding:12px; border:1px solid #cbd5e1; border-radius:10px; text-transform:uppercase; }
  .login button { width:100%; margin-top:12px; font-size:1rem; font-weight:700; padding:12px; border:none; border-radius:10px; background:#2563eb; color:#fff; cursor:pointer; }
  .login .err { color:#dc2626; font-size:.85rem; margin-top:10px; text-align:center; }
  .mgmt { background:var(--card); border:1px solid var(--line); border-radius:14px; padding:14px; margin-bottom:14px; }
  .pnl { display:flex; gap:8px; }
  .pnl .p { flex:1; text-align:center; }
  .pnl .pl { font-size:.72rem; color:var(--muted); }
  .pnl .pv { font-size:1.2rem; font-weight:800; margin-top:2px; }
  .pnl .pv.sales { color:#047857; } .pnl .pv.expense { color:#1e40af; } .pnl .pv.profit { color:#0f172a; } .pnl .pv.neg { color:#dc2626; }
  .note { font-size:.72rem; color:#b45309; background:#fffbeb; border:1px solid #fde68a; border-radius:8px; padding:6px 9px; margin:10px 0 4px; line-height:1.5; }
  .msec { margin-top:12px; }
  .mh { font-size:.82rem; font-weight:700; color:#334155; margin-bottom:7px; display:flex; align-items:center; }
  .leg { margin-left:auto; font-size:.7rem; color:var(--muted); font-weight:400; }
  .leg i { display:inline-block; width:9px; height:9px; border-radius:2px; vertical-align:middle; margin:0 3px 0 8px; }
  .leg .ls { background:#10b981; } .leg .le { background:#3b82f6; }
  .brow { display:flex; align-items:center; gap:8px; margin-bottom:5px; }
  .brow .bn { flex:0 0 90px; font-size:.8rem; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
  .brow .bbar { flex:1; background:#f1f5f9; border-radius:5px; height:10px; overflow:hidden; }
  .brow .bbar i { display:block; height:100%; background:#3b82f6; }
  .brow .ba { flex:0 0 auto; font-size:.82rem; font-weight:700; font-variant-numeric:tabular-nums; }
  .trow { display:flex; align-items:center; gap:8px; margin-bottom:6px; }
  .trow .tm { flex:0 0 36px; font-size:.78rem; color:var(--muted); }
  .trow .tbars { flex:1; display:flex; flex-direction:column; gap:2px; }
  .trow .tbar { background:#f1f5f9; border-radius:3px; height:7px; overflow:hidden; }
  .trow .tbar i { display:block; height:100%; }
  .trow .tbar .bs { background:#10b981; } .trow .tbar .be { background:#3b82f6; }
  .trow .tp { flex:0 0 64px; text-align:right; font-size:.8rem; font-weight:700; font-variant-numeric:tabular-nums; color:#047857; }
  .trow .tp.neg { color:#dc2626; }
  .subtally { margin-top:10px; font-size:.78rem; color:var(--muted); text-align:right; }
  .muted { color:var(--muted); font-size:.82rem; }
</style>`;

function loginPage(error?: string): string {
  return `<!doctype html><html lang="ja"><head>${PAGE_HEAD}<title>顧問先ログイン｜パーフェクト24/7</title></head><body>
<div class="login">
  <h2>書類かんたん確認</h2>
  <p>事務所からお伝えした<b>登録コード</b>を入力してください。送った領収書・請求書をいつでも確認できます。</p>
  <form method="post" action="/api/my">
    <input type="hidden" name="action" value="login">
    <input name="code" placeholder="登録コード" autocomplete="one-time-code" autocapitalize="characters" required>
    <button type="submit">ログイン</button>
    ${error ? `<div class="err">${esc(error)}</div>` : ''}
  </form>
</div>
</body></html>`;
}

type Row = Record<string, any>;

async function renderDashboard(clientId: string, fType: string): Promise<string> {
  const { data: client } = await supabase
    .from('clients')
    .select('id, client_code, official_name')
    .eq('id', clientId)
    .single();
  if (!client) return loginPage('セッションが無効です。もう一度ログインしてください。');

  // 自分の書類のみ（最新200件）
  const { data: receipts } = await supabase
    .from('receipts')
    .select('id, document_type, direction, total_amount, issued_date, created_at, account_code')
    .eq('client_id', clientId)
    .order('created_at', { ascending: false })
    .limit(400);
  const recs: Row[] = receipts ?? [];
  const ids = recs.map((r) => r.id);

  const [fieldsRes, imgRes, acctRes] = await Promise.all([
    ids.length
      ? supabase.from('extracted_fields').select('receipt_id, field_name, field_value').in('receipt_id', ids)
      : Promise.resolve({ data: [] as Row[] }),
    ids.length
      ? supabase.from('receipt_images').select('receipt_id, storage_path, content_type').in('receipt_id', ids)
      : Promise.resolve({ data: [] as Row[] }),
    supabase.from('account_titles').select('code, name').then((r) => r, () => ({ data: [] as Row[] })),
  ]);
  const accountName: Record<string, string> = {};
  for (const a of acctRes.data ?? []) accountName[a.code] = a.name;
  const fieldsByRec: Record<string, Record<string, string>> = {};
  for (const f of fieldsRes.data ?? []) (fieldsByRec[f.receipt_id] ??= {})[f.field_name] = f.field_value;
  const imgByRec: Record<string, Row> = {};
  for (const im of imgRes.data ?? []) imgByRec[im.receipt_id] ??= im;

  const paths = Object.values(imgByRec).map((im) => im.storage_path).filter(Boolean);
  const signed: Record<string, string> = {};
  if (paths.length) {
    const { data: list } = await supabase.storage.from('receipts').createSignedUrls(paths, 3600);
    for (const s of list ?? []) if (s.path && s.signedUrl) signed[s.path] = s.signedUrl;
  }

  // 解析できた書類のみ（金額/取引先あり、または明細系の種別）
  const meaningful = recs.filter(
    (r) =>
      r.total_amount != null ||
      Boolean(fieldsByRec[r.id]?.['vendor']) ||
      LINE_DOC_TYPES.includes(r.document_type),
  );

  // 今月（JST）の件数・経費/売上累計
  const jst = new Date(Date.now() + 9 * 3600 * 1000);
  const ym = `${jst.getUTCFullYear()}-${String(jst.getUTCMonth() + 1).padStart(2, '0')}`;
  const thisMonth = meaningful.filter((r) => String(r.created_at).slice(0, 7) === ym);
  const monthCount = thisMonth.length;
  const sumDir = (dir: string) =>
    thisMonth.filter((r) => r.direction === dir && r.document_type !== 'bankbook').reduce((s, r) => s + (Number(r.total_amount) || 0), 0);
  const monthExpense = sumDir('expense');
  const monthSales = sumDir('sales');

  // ───────── 経営の見える化（参考値）─────────
  // 損益に効く書類のみ（通帳・カード・固定資産・残高証明などは二重計上/資産のため除外）。
  // 税込ベースの概算。正式な試算表は事務所側で算出する。
  const PNL_TYPES = new Set(['receipt', 'invoice', 'tax_payment', 'ec_payout', 'payslip', 'wage_ledger']);
  const pnl = meaningful.filter((r) => PNL_TYPES.has(r.document_type));
  const monthKey = (r: Row) => String(r.issued_date ?? r.created_at ?? '').slice(0, 7);

  // 直近6ヶ月の推移
  const months: string[] = [];
  for (let i = 5; i >= 0; i--) {
    const d = new Date(Date.UTC(jst.getUTCFullYear(), jst.getUTCMonth() - i, 1));
    months.push(`${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`);
  }
  const trend: Record<string, { sales: number; expense: number }> = {};
  for (const m of months) trend[m] = { sales: 0, expense: 0 };
  for (const r of pnl) {
    const m = monthKey(r);
    if (!(m in trend)) continue;
    const amt = Number(r.total_amount) || 0;
    if (r.direction === 'sales') trend[m].sales += amt;
    else if (r.direction === 'expense') trend[m].expense += amt;
  }

  // 今月の科目別 経費内訳
  const expByAcct: Record<string, number> = {};
  for (const r of pnl) {
    if (r.direction !== 'expense' || monthKey(r) !== ym) continue;
    const code = r.account_code || 'other';
    expByAcct[code] = (expByAcct[code] ?? 0) + (Number(r.total_amount) || 0);
  }
  const expBreakdown = Object.entries(expByAcct)
    .map(([code, amt]) => ({ name: accountName[code] ?? '未分類', amt }))
    .sort((a, b) => b.amt - a.amt);
  const monthProfit = monthSales - monthExpense;

  // 種別タブ
  const present = [...new Set(meaningful.map((r) => r.document_type ?? 'other'))];
  const typeDefs: [string, string][] = [['', 'すべて'], ...present.map((t) => [t, DOC_LABEL[t] ?? t] as [string, string])];
  const tabs = typeDefs
    .map(([val, label]) => {
      const n = val === '' ? meaningful.length : meaningful.filter((r) => (r.document_type ?? 'other') === val).length;
      return `<a class="tab${fType === val ? ' active' : ''}" href="/api/my${val ? '?type=' + encodeURIComponent(val) : ''}">${esc(label)} <b>${n}</b></a>`;
    })
    .join('');

  const display = fType ? meaningful.filter((r) => (r.document_type ?? 'other') === fType) : meaningful;

  const cards = display.length
    ? display
        .map((r) => {
          const f = fieldsByRec[r.id] ?? {};
          const docType = r.document_type ?? 'other';
          const img = imgByRec[r.id];
          const url = img ? signed[img.storage_path] : undefined;
          const isImg = (img?.content_type ?? '').startsWith('image/');
          const thumb = url && isImg
            ? `<a href="${esc(url)}" target="_blank" rel="noopener"><img src="${esc(url)}" loading="lazy" alt=""></a>`
            : url
              ? `<a class="pdf" href="${esc(url)}" target="_blank" rel="noopener">📄 PDF</a>`
              : `<div class="noimg">画像なし</div>`;
          const who = f['counterparty'] ?? f['vendor'] ?? (LINE_DOC_TYPES.includes(docType) ? DOC_LABEL[docType] : '取引先不明');
          const review = f['needs_review'] === 'true';
          return `<div class="card">
            <div class="thumb">${thumb}</div>
            <div class="info">
              <div class="top">
                <span class="badge" style="background:${DOC_COLOR[docType] ?? '#6b7280'}">${esc(DOC_LABEL[docType] ?? docType)}</span>
                ${r.direction && docType !== 'bankbook' ? `<span class="side ${r.direction}">${r.direction === 'sales' ? '売上' : '経費'}</span>` : ''}
                ${review ? `<span class="review">確認中</span>` : ''}
              </div>
              <div class="vendor">${esc(who)}</div>
              ${r.total_amount != null ? `<div class="amount">${yen(r.total_amount)}</div>` : ''}
              <div class="date">${esc(fmtDate(r.issued_date))}</div>
            </div>
          </div>`;
        })
        .join('')
    : '<div class="empty">まだ書類がありません。LINE で領収書・請求書を撮って送ってください。</div>';

  // 経営の見える化パネル（参考値）
  const maxTrend = Math.max(1, ...months.map((m) => Math.max(trend[m].sales, trend[m].expense)));
  const trendRows = months
    .map((m) => {
      const t = trend[m];
      const profit = t.sales - t.expense;
      return `<div class="trow">
        <span class="tm">${esc(m.slice(5))}月</span>
        <div class="tbars">
          <div class="tbar"><i class="bs" style="width:${((t.sales / maxTrend) * 100).toFixed(1)}%"></i></div>
          <div class="tbar"><i class="be" style="width:${((t.expense / maxTrend) * 100).toFixed(1)}%"></i></div>
        </div>
        <span class="tp ${profit < 0 ? 'neg' : ''}">${profit >= 0 ? '+' : '−'}${Math.abs(Math.round(profit)).toLocaleString()}</span>
      </div>`;
    })
    .join('');
  const maxExp = Math.max(1, ...expBreakdown.map((e) => e.amt));
  const breakdownRows =
    expBreakdown
      .slice(0, 6)
      .map(
        (e) => `<div class="brow">
        <span class="bn">${esc(e.name)}</span>
        <div class="bbar"><i style="width:${((e.amt / maxExp) * 100).toFixed(1)}%"></i></div>
        <span class="ba">${yen(e.amt)}</span>
      </div>`,
      )
      .join('') || '<div class="muted">今月の経費はまだありません。</div>';
  const mgmt = `<div class="mgmt">
    <div class="pnl">
      <div class="p"><div class="pl">今月の売上</div><div class="pv sales">${monthSales ? '¥' + monthSales.toLocaleString() : '—'}</div></div>
      <div class="p"><div class="pl">今月の経費</div><div class="pv expense">${monthExpense ? '¥' + monthExpense.toLocaleString() : '—'}</div></div>
      <div class="p"><div class="pl">今月の利益</div><div class="pv ${monthProfit < 0 ? 'neg' : 'profit'}">${(monthProfit >= 0 ? '¥' : '−¥') + Math.abs(Math.round(monthProfit)).toLocaleString()}</div></div>
    </div>
    <div class="note">※ LINEで送っていただいた書類からの概算（税込）です。正式な試算表・申告は事務所にご確認ください。</div>
    <div class="msec"><div class="mh">今月の経費の内訳</div>${breakdownRows}</div>
    <div class="msec"><div class="mh">月次の推移（直近6ヶ月）<span class="leg"><i class="ls"></i>売上<i class="le"></i>経費</span></div>${trendRows}</div>
    <div class="subtally">今月の提出 ${monthCount} 件</div>
  </div>`;

  return `<!doctype html><html lang="ja"><head>${PAGE_HEAD}<title>マイ書類｜パーフェクト24/7</title></head><body>
<header>
  <h1>マイ書類</h1>
  <span class="who">${esc(client.official_name)}</span>
  <a class="logout" href="/api/my?logout=1">ログアウト</a>
</header>
<div class="wrap">
  ${mgmt}
  <div class="filterbar">${tabs}</div>
  ${cards}
</div>
</body></html>`;
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  // ログアウト
  if (req.method === 'GET' && req.query.logout) {
    res.setHeader('Set-Cookie', `${COOKIE}=; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=0`);
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    return res.status(200).send(loginPage());
  }

  // ログイン（登録コード）
  if (req.method === 'POST' && req.body?.action === 'login') {
    const code = normCode(req.body?.code);
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    if (!code) return res.status(400).send(loginPage('登録コードを入力してください。'));
    const { data } = await supabase
      .from('clients')
      .select('id')
      .eq('registration_code', code)
      .limit(1);
    const client = data && data.length ? data[0] : null;
    if (!client) return res.status(401).send(loginPage('登録コードが正しくありません。事務所にご確認ください。'));
    res.setHeader('Set-Cookie', `${COOKIE}=${encodeURIComponent(sign(client.id))}; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=2592000`);
    res.setHeader('Cache-Control', 'no-store');
    return res.redirect(303, '/api/my');
  }

  // 表示
  const clientId = verify(parseCookies(req)[COOKIE]);
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  if (!clientId) return res.status(200).send(loginPage());
  const fType = typeof req.query.type === 'string' ? req.query.type : '';
  try {
    return res.status(200).send(await renderDashboard(clientId, fType));
  } catch (err) {
    console.error('my dashboard error', err);
    return res.status(500).send(loginPage('表示中にエラーが発生しました。もう一度お試しください。'));
  }
}
