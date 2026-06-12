import type { VercelRequest, VercelResponse } from '@vercel/node';
import crypto from 'node:crypto';
import { createClient } from '@supabase/supabase-js';
// 注意: このプロジェクトの Vercel 設定では api/ 内の相互 import が実行時に解決されない
// （各ファイルが個別トランスパイルされ、兄弟ファイルがバンドルされない）ため、
// 必要なロジックはこのファイル内にインラインで持つ。

// 事務所ログイン（OFFICE_AUTH=on で有効）
const OFFICE_AUTH = process.env.OFFICE_AUTH === 'on';
function officeSession(req: VercelRequest): string | null {
  const raw = req.headers.cookie;
  if (!raw) return null;
  let val: string | undefined;
  for (const part of raw.split(';')) {
    const i = part.indexOf('=');
    if (i > 0 && part.slice(0, i).trim() === 'p247_office') val = decodeURIComponent(part.slice(i + 1).trim());
  }
  if (!val) return null;
  const j = val.lastIndexOf('.');
  if (j < 0) return null;
  const id = val.slice(0, j);
  const exp = crypto.createHmac('sha256', process.env.SUPABASE_KEY ?? '').update(id).digest('base64url');
  const a = Buffer.from(val.slice(j + 1));
  const b = Buffer.from(exp);
  return a.length === b.length && crypto.timingSafeEqual(a, b) ? id : null;
}
type Account = {
  code: string;
  name: string;
  category: 'asset' | 'liability' | 'equity' | 'revenue' | 'expense';
  statement: 'BS' | 'PL';
  normal_balance: 'debit' | 'credit';
  sort_order: number | null;
};

async function loadAccounts(sb: any, officeId: string | null): Promise<Account[]> {
  const { data } = await sb
    .from('account_titles')
    .select('code, name, category, statement, normal_balance, sort_order, office_id, is_active')
    .or(officeId ? `office_id.is.null,office_id.eq.${officeId}` : 'office_id.is.null')
    .eq('is_active', true);
  const rows = (data ?? []) as (Account & { office_id: string | null })[];
  const byCode = new Map<string, Account>();
  for (const r of rows) {
    const existing = byCode.get(r.code);
    if (!existing || r.office_id) byCode.set(r.code, r);
  }
  return [...byCode.values()].sort((a, b) => (a.sort_order ?? 0) - (b.sort_order ?? 0));
}

// 1書類の編集エンドポイント。
//  GET  /api/edit?id=<receipt_id>&...filters  → 編集フォーム（自動更新なし）
//  POST /api/edit                              → 保存してダッシュボードへ 303 リダイレクト
// 税理士の要望「自動で付いた勘定科目を、間違っていたら事務所が修正できる」を満たす。
export const config = { maxDuration: 30 };

const SUPABASE_URL = (process.env.SUPABASE_URL ?? '').replace(/\/rest\/v1\/?$/, '');
const SUPABASE_KEY = process.env.SUPABASE_KEY ?? '';
const DASHBOARD_KEY = process.env.DASHBOARD_KEY ?? '';
const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

function esc(s: unknown): string {
  return String(s ?? '').replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] as string,
  );
}

const CAT_LABEL: Record<string, string> = {
  asset: '資産',
  liability: '負債',
  equity: '純資産',
  revenue: '収益',
  expense: '費用',
};

// 現在のフィルタを維持してダッシュボードに戻る URL を組み立てる
function dashboardUrl(q: Record<string, string>): string {
  const p = new URLSearchParams();
  for (const k of ['type', 'dir', 'client', 'q', 'all', 'key']) {
    if (q[k]) p.set(k, q[k]);
  }
  const s = p.toString();
  return '/api/dashboard' + (s ? '?' + s : '');
}

// extracted_fields の1項目を upsert（既存があれば更新、無ければ挿入）
async function setField(receiptId: string, name: string, value: string | null) {
  const { data } = await supabase
    .from('extracted_fields')
    .select('id')
    .eq('receipt_id', receiptId)
    .eq('field_name', name)
    .limit(1);
  if (data && data.length) {
    await supabase
      .from('extracted_fields')
      .update({ field_value: value, source: 'manual' })
      .eq('id', data[0].id);
  } else if (value !== null && value !== '') {
    await supabase
      .from('extracted_fields')
      .insert({ receipt_id: receiptId, field_name: name, field_value: value, source: 'manual' });
  }
}

function num(v: unknown): number | null {
  if (v === null || v === undefined || String(v).trim() === '') return null;
  const n = Number(String(v).replace(/[^0-9.-]/g, ''));
  return Number.isNaN(n) ? null : n;
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  const officeId = officeSession(req);
  if (OFFICE_AUTH && !officeId) {
    if (req.method === 'POST') return res.status(401).send('ログインが必要です。');
    res.setHeader('Location', '/api/office');
    return res.status(302).end();
  }
  const keyEnforced = !OFFICE_AUTH && DASHBOARD_KEY.length > 0;
  const key = (req.method === 'POST' ? req.body?.key : req.query.key) ?? '';
  if (keyEnforced && key !== DASHBOARD_KEY) {
    return res.status(401).send('アクセスキーが必要です（?key=...）。');
  }

  // ───────── 保存 ─────────
  if (req.method === 'POST') {
    const b = req.body ?? {};
    const id = String(b.id ?? '');
    if (!id) return res.status(400).send('id が必要です。');

    // 所有チェック: 他事務所の書類は編集不可
    if (officeId) {
      const { data: own } = await supabase.from('receipts').select('office_id').eq('id', id).single();
      if (!own || own.office_id !== officeId) return res.status(403).send('この書類を編集する権限がありません。');
    }

    const direction = b.direction === 'sales' || b.direction === 'expense' ? b.direction : null;
    const total = num(b.total_amount);
    const tax = num(b.tax_amount);
    // 税抜本体 amount は 税込−消費税 で再計算（reports/CSV の整合のため）
    const net = total != null && tax != null ? total - tax : total;
    const patch: Record<string, unknown> = {
      account_code: b.account_code || null,
      payment_account_code: b.payment_account_code || null,
      account_source: 'manual',
      direction,
      total_amount: total,
      tax_amount: tax,
      amount: net,
      issued_date: typeof b.issued_date === 'string' && b.issued_date ? b.issued_date : null,
      description: b.note || null,
    };
    await supabase.from('receipts').update(patch).eq('id', id);

    // 明細的な項目は extracted_fields 側に upsert
    await setField(id, 'counterparty', String(b.counterparty ?? '').trim() || null);
    await setField(id, 'note', String(b.note ?? '').trim() || null);
    await setField(id, 'direction', direction);
    await setField(id, 'tax_amount', tax != null ? String(tax) : null);
    await setField(id, 'tax_rate', String(b.tax_rate ?? '').trim() || null);
    await setField(id, 'registration_number', String(b.registration_number ?? '').trim() || null);
    await setField(id, 'receipt_no', String(b.receipt_no ?? '').trim() || null);
    await setField(id, 'fee', num(b.fee) != null ? String(num(b.fee)) : null);
    // 「確認済みにする」がチェックされていれば要確認を解除
    await setField(id, 'needs_review', b.reviewed ? 'false' : 'true');

    res.setHeader('Cache-Control', 'no-store');
    return res.redirect(303, dashboardUrl(b));
  }

  // ───────── 編集フォーム表示 ─────────
  const id = typeof req.query.id === 'string' ? req.query.id : '';
  if (!id) return res.status(400).send('id が必要です。');

  const [{ data: rec }, fieldsRes] = await Promise.all([
    supabase
      .from('receipts')
      .select('id, document_type, direction, total_amount, tax_amount, issued_date, account_code, payment_account_code, office_id, client_id')
      .eq('id', id)
      .single(),
    supabase.from('extracted_fields').select('field_name, field_value').eq('receipt_id', id),
  ]);
  if (!rec) return res.status(404).send('書類が見つかりません。');
  if (officeId && rec.office_id !== officeId) return res.status(404).send('書類が見つかりません。');

  const fields: Record<string, string> = {};
  for (const f of fieldsRes.data ?? []) fields[f.field_name] = f.field_value;

  let accounts: Account[] = [];
  try {
    accounts = await loadAccounts(supabase, rec.office_id ?? null);
  } catch {
    /* マスタ未作成 */
  }

  // 科目 select（科目区分でグループ化）
  const accountOptions = (selected: string | null, blankLabel: string) => {
    const groups: Record<string, Account[]> = {};
    for (const a of accounts) (groups[a.category] ??= []).push(a);
    const order = ['expense', 'revenue', 'asset', 'liability', 'equity'];
    const opts = [`<option value="">${esc(blankLabel)}</option>`];
    for (const cat of order) {
      const list = groups[cat];
      if (!list) continue;
      opts.push(`<optgroup label="${esc(CAT_LABEL[cat] ?? cat)}">`);
      for (const a of list) {
        const sel = a.code === selected ? ' selected' : '';
        opts.push(`<option value="${esc(a.code)}"${sel}>${esc(a.code)} ${esc(a.name)}</option>`);
      }
      opts.push('</optgroup>');
    }
    return opts.join('');
  };

  const filterInputs = ['type', 'dir', 'client', 'q', 'all', 'key']
    .map((k) => (req.query[k] ? `<input type="hidden" name="${k}" value="${esc(req.query[k])}">` : ''))
    .join('');

  const reviewed = fields['needs_review'] !== 'true'; // 既に確認済みならチェック済みで表示
  const counterparty = fields['counterparty'] ?? fields['vendor'] ?? '';
  const dir = rec.direction ?? '';

  const html = `<!doctype html>
<html lang="ja"><head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>書類の編集｜パーフェクト24/7</title>
<style>
  body { margin:0; background:#f1f5f9; color:#0f172a; font-family:-apple-system,BlinkMacSystemFont,"Hiragino Kaku Gothic ProN","Noto Sans JP",sans-serif; }
  header { background:#0f172a; color:#fff; padding:14px 18px; font-weight:700; }
  .wrap { max-width:640px; margin:0 auto; padding:18px; }
  form { background:#fff; border:1px solid #e2e8f0; border-radius:14px; padding:18px; }
  .row { margin-bottom:14px; }
  label { display:block; font-size:.82rem; color:#475569; font-weight:700; margin-bottom:5px; }
  input[type=text], input[type=number], input[type=date], select {
    width:100%; font-size:1rem; padding:9px 10px; border:1px solid #cbd5e1; border-radius:9px; background:#fff; }
  .two { display:flex; gap:12px; } .two > div { flex:1; }
  .hint { color:#64748b; font-size:.78rem; margin-top:4px; }
  .seg { display:flex; gap:8px; } .seg label { display:flex; align-items:center; gap:5px; font-weight:600; color:#0f172a; }
  .actions { display:flex; gap:10px; align-items:center; margin-top:6px; }
  button { font-size:1rem; font-weight:700; padding:10px 20px; border:none; border-radius:9px; background:#2563eb; color:#fff; cursor:pointer; }
  a.cancel { color:#64748b; text-decoration:none; font-size:.9rem; }
  .check { display:flex; align-items:center; gap:8px; font-weight:600; }
  .docmeta { color:#64748b; font-size:.85rem; margin-bottom:14px; }
</style>
</head><body>
<header>書類の編集</header>
<div class="wrap">
  <form method="post" action="/api/edit">
    ${filterInputs}
    <input type="hidden" name="id" value="${esc(rec.id)}">
    <div class="docmeta">種別: ${esc(rec.document_type ?? '—')}　/　ID: ${esc(String(rec.id).slice(0, 8))}</div>

    <div class="row">
      <label>勘定科目</label>
      <select name="account_code">${accountOptions(rec.account_code ?? null, '（未設定）')}</select>
      <div class="hint">自動で付いた科目を確認・修正してください。</div>
    </div>

    <div class="row two">
      <div>
        <label>売上 / 経費</label>
        <select name="direction">
          <option value=""${dir === '' ? ' selected' : ''}>（なし）</option>
          <option value="sales"${dir === 'sales' ? ' selected' : ''}>売上</option>
          <option value="expense"${dir === 'expense' ? ' selected' : ''}>経費</option>
        </select>
      </div>
      <div>
        <label>相手科目（支払・入金側）</label>
        <select name="payment_account_code">${accountOptions(rec.payment_account_code ?? null, '（未設定）')}</select>
      </div>
    </div>

    <div class="row two">
      <div>
        <label>日付</label>
        <input type="date" name="issued_date" value="${esc(rec.issued_date ?? '')}">
      </div>
      <div>
        <label>税込金額</label>
        <input type="number" name="total_amount" value="${esc(rec.total_amount ?? '')}" step="1">
      </div>
    </div>

    <div class="row two">
      <div>
        <label>消費税額</label>
        <input type="number" name="tax_amount" value="${esc(rec.tax_amount ?? '')}" step="1">
      </div>
      <div>
        <label>税率</label>
        <select name="tax_rate">
          ${['', '10%', '8%', 'mixed']
            .map((v) => `<option value="${esc(v)}"${(fields['tax_rate'] ?? '') === v ? ' selected' : ''}>${v === '' ? '（未設定）' : v === 'mixed' ? '複数税率' : v}</option>`)
            .join('')}
        </select>
      </div>
    </div>

    <div class="row two">
      <div>
        <label>インボイス登録番号</label>
        <input type="text" name="registration_number" value="${esc(fields['registration_number'] ?? '')}" placeholder="T+13桁">
      </div>
      <div>
        <label>手数料</label>
        <input type="number" name="fee" value="${esc(fields['fee'] ?? '')}" step="1">
      </div>
    </div>

    <div class="row two">
      <div>
        <label>取引先</label>
        <input type="text" name="counterparty" value="${esc(counterparty)}">
      </div>
      <div>
        <label>番号（レシート/請求書番号）</label>
        <input type="text" name="receipt_no" value="${esc(fields['receipt_no'] ?? '')}">
      </div>
    </div>

    <div class="row">
      <label>摘要 / 但し書き</label>
      <input type="text" name="note" value="${esc(fields['note'] ?? '')}">
    </div>

    <div class="row">
      <label class="check"><input type="checkbox" name="reviewed" value="1"${reviewed ? ' checked' : ''}> 確認済みにする（⚠️要確認を外す）</label>
    </div>

    <div class="actions">
      <button type="submit">保存</button>
      <a class="cancel" href="${esc(dashboardUrl(req.query as Record<string, string>))}">キャンセル</a>
    </div>
  </form>
</div>
</body></html>`;

  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  return res.status(200).send(html);
}
