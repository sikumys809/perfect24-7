import type { VercelRequest, VercelResponse } from '@vercel/node';
import { createClient } from '@supabase/supabase-js';
import {
  loadAccounts,
  deriveEntries,
  JOURNAL_DOC_TYPES,
  type Account,
  type JournalLine,
} from './lib/accounting';

// 月次試算表(BS/PL)と総勘定元帳。受信書類に付与した勘定科目から簡易複式の仕訳を導出して集計する。
//  GET /api/reports?view=trial|ledger&month=YYYY-MM&client=<id>&key=...
// 注意: 期首残高や未送付の取引は含まない「受信書類ベース」の集計。各仕訳は貸借一致するので
//       借方合計＝貸方合計は常に一致する（導出の整合性チェックになる）。
export const config = { maxDuration: 30 };

const SUPABASE_URL = (process.env.SUPABASE_URL ?? '').replace(/\/rest\/v1\/?$/, '');
const SUPABASE_KEY = process.env.SUPABASE_KEY ?? '';
const DASHBOARD_KEY = process.env.DASHBOARD_KEY ?? '';
const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

const CAT_LABEL: Record<string, string> = {
  asset: '資産',
  liability: '負債',
  equity: '純資産',
  revenue: '収益',
  expense: '費用',
};

function esc(s: unknown): string {
  return String(s ?? '').replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] as string,
  );
}
function yen(n: number): string {
  return n ? '¥' + Math.round(n).toLocaleString() : '—';
}
function fmtDate(d: unknown): string {
  return typeof d === 'string' && d ? d.slice(0, 10) : '—';
}
// YYYY-MM を ±1 月する（UTC ベースで月初を動かす）
function shiftMonth(month: string, delta: number): string {
  const [y, m] = month.split('-').map(Number);
  const d = new Date(Date.UTC(y, m - 1 + delta, 1));
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
}
function currentMonthJst(): string {
  const jst = new Date(Date.now() + 9 * 3600 * 1000);
  return `${jst.getUTCFullYear()}-${String(jst.getUTCMonth() + 1).padStart(2, '0')}`;
}

type Posting = JournalLine & { contra: string };

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (DASHBOARD_KEY.length > 0 && req.query.key !== DASHBOARD_KEY) {
    return res.status(401).send('アクセスキーが必要です（?key=...）。');
  }

  const view = req.query.view === 'ledger' ? 'ledger' : 'trial';
  const month = typeof req.query.month === 'string' && /^\d{4}-\d{2}$/.test(req.query.month)
    ? req.query.month
    : currentMonthJst();
  const fClient = typeof req.query.client === 'string' ? req.query.client : '';
  const key = typeof req.query.key === 'string' ? req.query.key : '';
  const monthStart = `${month}-01`;
  const monthEnd = `${shiftMonth(month, 1)}-01`;

  // 当月・対象書類（仕訳対象の種別のみ）を取得
  let q = supabase
    .from('receipts')
    .select('id, document_type, direction, total_amount, tax_amount, issued_date, account_code, payment_account_code, client_id, office_id')
    .gte('issued_date', monthStart)
    .lt('issued_date', monthEnd)
    .in('document_type', [...JOURNAL_DOC_TYPES])
    .order('issued_date', { ascending: true });
  if (fClient) q = q.eq('client_id', fClient);
  const { data: receipts } = await q;
  const recs = receipts ?? [];

  const ids = recs.map((r) => r.id);
  const officeId = recs.find((r) => r.office_id)?.office_id ?? null;

  const [fieldsRes, payRes, accounts, clientsRes] = await Promise.all([
    ids.length
      ? supabase.from('extracted_fields').select('receipt_id, field_name, field_value').in('receipt_id', ids)
      : Promise.resolve({ data: [] as any[] }),
    ids.length
      ? supabase
          .from('payroll_lines')
          .select('receipt_id, gross, health_insurance, pension, employment_insurance, income_tax, resident_tax, other_deduction, net')
          .in('receipt_id', ids)
          .then((r) => r, () => ({ data: [] as any[] }))
      : Promise.resolve({ data: [] as any[] }),
    loadAccounts(supabase, officeId).catch(() => [] as Account[]),
    supabase
      .from('clients')
      .select('id, client_code, official_name, tax_accounting')
      .then((r) => r, () => ({ data: [] as any[] })),
  ]);

  const fieldsByRec: Record<string, Record<string, string>> = {};
  for (const f of fieldsRes.data ?? []) (fieldsByRec[f.receipt_id] ??= {})[f.field_name] = f.field_value;
  const payByRec: Record<string, any[]> = {};
  for (const p of payRes.data ?? []) (payByRec[p.receipt_id] ??= []).push(p);
  const accountByCode = new Map(accounts.map((a) => [a.code, a]));
  const nameOf = (code: string) => accountByCode.get(code)?.name ?? code;

  // 顧問先ごとの経理方式（税込 inclusive / 税抜 exclusive）
  const clientsAll = (clientsRes.data ?? []) as any[];
  const taxModeByClient: Record<string, 'inclusive' | 'exclusive'> = {};
  for (const c of clientsAll) taxModeByClient[c.id] = c.tax_accounting === 'exclusive' ? 'exclusive' : 'inclusive';

  // 全 receipt を仕訳に展開し、相手科目ラベルを付ける
  const postings: Posting[] = [];
  for (const rec of recs) {
    const mode = (rec.client_id && taxModeByClient[rec.client_id]) || 'inclusive';
    const lines = deriveEntries(rec, fieldsByRec[rec.id] ?? {}, accountByCode, payByRec[rec.id], mode);
    for (const ln of lines) {
      // 2行仕訳なら相手の科目名、複合仕訳は「諸口」
      const contra =
        lines.length === 2 ? nameOf(lines.find((o) => o !== ln)!.account_code) : '諸口';
      postings.push({ ...ln, contra });
    }
  }

  const clients = clientsAll;
  const clientName = fClient ? clients.find((c) => c.id === fClient)?.official_name ?? '' : '';
  const selectedMode = fClient ? taxModeByClient[fClient] ?? 'inclusive' : null;

  // 共通のリンク生成
  const link = (ov: { view?: string; month?: string; client?: string }) => {
    const p = new URLSearchParams();
    p.set('view', ov.view ?? view);
    p.set('month', ov.month ?? month);
    const c = ov.client !== undefined ? ov.client : fClient;
    if (c) p.set('client', c);
    if (key) p.set('key', key);
    return '/api/reports?' + p.toString();
  };
  const dashHref = '/api/dashboard' + (key ? `?key=${esc(key)}` : '');

  // 顧問先プルダウン
  const clientOptions = [
    `<option value="">全顧問先</option>`,
    ...clients
      .sort((a, b) => String(a.client_code).localeCompare(String(b.client_code)))
      .map((c) => `<option value="${esc(c.id)}"${fClient === c.id ? ' selected' : ''}>${esc(c.official_name)}</option>`),
  ].join('');

  // ───────────────────────── 集計 ─────────────────────────
  const agg = new Map<string, { debit: number; credit: number }>();
  for (const p of postings) {
    const a = agg.get(p.account_code) ?? { debit: 0, credit: 0 };
    a.debit += p.debit;
    a.credit += p.credit;
    agg.set(p.account_code, a);
  }
  const totalDebit = postings.reduce((s, p) => s + p.debit, 0);
  const totalCredit = postings.reduce((s, p) => s + p.credit, 0);

  // 科目ごとの残高（正味）。借方系=debit-credit、貸方系=credit-debit。
  type Bal = { code: string; name: string; category: string; statement: string; bal: number };
  const balances: Bal[] = [];
  for (const [code, a] of agg) {
    const acc = accountByCode.get(code);
    const normalDebit = acc ? acc.normal_balance === 'debit' : true;
    const bal = normalDebit ? a.debit - a.credit : a.credit - a.debit;
    if (Math.round(bal) === 0) continue;
    balances.push({
      code,
      name: acc?.name ?? code,
      category: acc?.category ?? 'expense',
      statement: acc?.statement ?? 'PL',
      bal,
    });
  }
  balances.sort((a, b) => Number(a.code) - Number(b.code));

  const sumCat = (cat: string) => balances.filter((b) => b.category === cat).reduce((s, b) => s + b.bal, 0);
  const revenue = sumCat('revenue');
  const expense = sumCat('expense');
  const netIncome = revenue - expense; // 当期純利益
  const assets = sumCat('asset');
  const liabilities = sumCat('liability');
  const equity = sumCat('equity');

  // ───────────────────────── 本文 ─────────────────────────
  let main = '';

  if (view === 'trial') {
    const section = (title: string, cats: string[], showSubtotal = true) => {
      const rows = balances
        .filter((b) => cats.includes(b.category))
        .map(
          (b) => `<tr>
            <td class="code">${esc(b.code)}</td>
            <td>${esc(b.name)}</td>
            <td class="cat">${esc(CAT_LABEL[b.category] ?? b.category)}</td>
            <td class="num">${yen(b.bal)}</td></tr>`,
        )
        .join('');
      const sub = cats.reduce((s, c) => s + sumCat(c), 0);
      return `<h2>${esc(title)}</h2>
        <table class="rep">
          <thead><tr><th>コード</th><th>勘定科目</th><th>区分</th><th class="num">残高</th></tr></thead>
          <tbody>${rows || '<tr><td colspan="4" class="empty">該当なし</td></tr>'}</tbody>
          ${showSubtotal ? `<tfoot><tr><td colspan="3">小計</td><td class="num">${yen(sub)}</td></tr></tfoot>` : ''}
        </table>`;
    };

    main = `
      <div class="pl">
        <h2>損益計算書（PL）</h2>
        <table class="rep">
          <thead><tr><th>コード</th><th>勘定科目</th><th>区分</th><th class="num">金額</th></tr></thead>
          <tbody>
            ${balances
              .filter((b) => b.statement === 'PL')
              .map(
                (b) => `<tr><td class="code">${esc(b.code)}</td><td>${esc(b.name)}</td><td class="cat">${esc(CAT_LABEL[b.category])}</td><td class="num">${yen(b.bal)}</td></tr>`,
              )
              .join('') || '<tr><td colspan="4" class="empty">該当なし</td></tr>'}
          </tbody>
          <tfoot>
            <tr><td colspan="3">収益合計</td><td class="num">${yen(revenue)}</td></tr>
            <tr><td colspan="3">費用合計</td><td class="num">${yen(expense)}</td></tr>
            <tr class="grand"><td colspan="3">当期純利益</td><td class="num ${netIncome < 0 ? 'neg' : ''}">${yen(netIncome)}</td></tr>
          </tfoot>
        </table>
      </div>
      <div class="bs">
        <h2>貸借対照表（BS）</h2>
        <table class="rep">
          <thead><tr><th>コード</th><th>勘定科目</th><th>区分</th><th class="num">残高</th></tr></thead>
          <tbody>
            ${balances
              .filter((b) => b.statement === 'BS')
              .map(
                (b) => `<tr><td class="code">${esc(b.code)}</td><td>${esc(b.name)}</td><td class="cat">${esc(CAT_LABEL[b.category])}</td><td class="num">${yen(b.bal)}</td></tr>`,
              )
              .join('') || '<tr><td colspan="4" class="empty">該当なし</td></tr>'}
          </tbody>
          <tfoot>
            <tr><td colspan="3">資産合計</td><td class="num">${yen(assets)}</td></tr>
            <tr><td colspan="3">負債合計</td><td class="num">${yen(liabilities)}</td></tr>
            <tr><td colspan="3">純資産合計</td><td class="num">${yen(equity)}</td></tr>
            <tr class="grand"><td colspan="3">当期純利益（振替）</td><td class="num ${netIncome < 0 ? 'neg' : ''}">${yen(netIncome)}</td></tr>
          </tfoot>
        </table>
      </div>
      <div class="integrity">
        借方合計 ${yen(totalDebit)} ／ 貸方合計 ${yen(totalCredit)}
        ${Math.round(totalDebit) === Math.round(totalCredit) ? '<b class="ok">✓ 貸借一致</b>' : '<b class="ng">✗ 不一致</b>'}
        <span class="note">※ 期首残高・未送付の取引は含まない「受信書類ベース」の集計です。BSは期首残高が無いため通常は均衡しません。</span>
      </div>`;
  } else {
    // 総勘定元帳: 科目ごとに仕訳を並べ、残高を積み上げる
    const byCode: Record<string, Posting[]> = {};
    for (const p of postings) (byCode[p.account_code] ??= []).push(p);
    const codes = Object.keys(byCode).sort((a, b) => Number(a) - Number(b));
    main = codes.length
      ? codes
          .map((code) => {
            const list = byCode[code].slice().sort((a, b) => String(a.date).localeCompare(String(b.date)));
            const acc = accountByCode.get(code);
            const normalDebit = acc ? acc.normal_balance === 'debit' : true;
            let run = 0;
            const rows = list
              .map((p) => {
                run += normalDebit ? p.debit - p.credit : p.credit - p.debit;
                return `<tr>
                  <td>${esc(fmtDate(p.date))}</td>
                  <td>${esc(p.contra)}</td>
                  <td class="desc">${esc([p.counterparty, p.description].filter(Boolean).join(' / '))}</td>
                  <td class="num">${p.debit ? yen(p.debit) : ''}</td>
                  <td class="num">${p.credit ? yen(p.credit) : ''}</td>
                  <td class="num bal">${yen(run)}</td></tr>`;
              })
              .join('');
            const dSum = list.reduce((s, p) => s + p.debit, 0);
            const cSum = list.reduce((s, p) => s + p.credit, 0);
            return `<div class="ledger">
              <h3><span class="code">${esc(code)}</span> ${esc(acc?.name ?? code)} <span class="cat">${esc(CAT_LABEL[acc?.category ?? ''] ?? '')}</span></h3>
              <table class="rep">
                <thead><tr><th>日付</th><th>相手科目</th><th>摘要</th><th class="num">借方</th><th class="num">貸方</th><th class="num">残高</th></tr></thead>
                <tbody>${rows}</tbody>
                <tfoot><tr><td colspan="3">合計</td><td class="num">${yen(dSum)}</td><td class="num">${yen(cSum)}</td><td class="num bal">${yen(run)}</td></tr></tfoot>
              </table>
            </div>`;
          })
          .join('')
      : '<div class="empty-big">この月の仕訳がありません。</div>';
  }

  const html = `<!doctype html>
<html lang="ja"><head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${view === 'trial' ? '月次試算表' : '総勘定元帳'}｜パーフェクト24/7</title>
<style>
  :root { --line:#e2e8f0; --muted:#64748b; }
  * { box-sizing:border-box; }
  body { margin:0; background:#f1f5f9; color:#0f172a; font-family:-apple-system,BlinkMacSystemFont,"Hiragino Kaku Gothic ProN","Noto Sans JP",sans-serif; }
  header { position:sticky; top:0; background:#0f172a; color:#fff; padding:12px 18px; display:flex; align-items:center; gap:14px; flex-wrap:wrap; z-index:10; }
  header h1 { font-size:1.05rem; margin:0; }
  header a.back { color:#cbd5e1; text-decoration:none; font-size:.85rem; }
  .bar { background:#fff; border-bottom:1px solid var(--line); padding:10px 16px; display:flex; gap:12px; align-items:center; flex-wrap:wrap; position:sticky; top:46px; z-index:9; }
  .tabs { display:flex; gap:6px; }
  .tab { text-decoration:none; color:var(--muted); font-size:.9rem; padding:6px 14px; border-radius:999px; border:1px solid var(--line); }
  .tab.active { background:#0f172a; color:#fff; border-color:#0f172a; }
  .month { display:flex; align-items:center; gap:8px; font-weight:700; }
  .month a { text-decoration:none; color:#2563eb; font-size:1.1rem; padding:2px 8px; border:1px solid var(--line); border-radius:8px; }
  select { font-size:.85rem; padding:6px 9px; border:1px solid var(--line); border-radius:8px; background:#fff; }
  .taxmode { display:flex; align-items:center; gap:6px; }
  .taxmode label { font-size:.8rem; color:var(--muted); font-weight:700; }
  .taxnote { font-size:.78rem; color:#94a3b8; }
  .wrap { max-width:880px; margin:0 auto; padding:18px; }
  h2 { font-size:1rem; margin:18px 0 8px; padding-left:8px; border-left:4px solid #2563eb; }
  table.rep { width:100%; border-collapse:collapse; background:#fff; border:1px solid var(--line); border-radius:10px; overflow:hidden; font-size:.88rem; margin-bottom:8px; }
  table.rep th { text-align:left; background:#f8fafc; color:var(--muted); font-weight:600; padding:7px 10px; border-bottom:1px solid var(--line); }
  table.rep td { padding:6px 10px; border-bottom:1px solid #f1f5f9; }
  table.rep td.num, table.rep th.num { text-align:right; font-variant-numeric:tabular-nums; }
  table.rep td.code { color:#94a3b8; font-variant-numeric:tabular-nums; }
  table.rep td.cat { color:var(--muted); font-size:.8rem; }
  table.rep td.desc { color:#334155; }
  table.rep td.bal { font-weight:700; }
  table.rep tfoot td { background:#f8fafc; font-weight:700; border-top:1px solid var(--line); }
  table.rep tfoot tr.grand td { background:#eff6ff; color:#1e3a8a; font-size:.95rem; }
  .num.neg { color:#dc2626; }
  .empty { color:var(--muted); text-align:center; }
  .empty-big { color:var(--muted); text-align:center; padding:60px; }
  .integrity { margin:16px 0; padding:12px 14px; background:#fff; border:1px solid var(--line); border-radius:10px; font-size:.9rem; }
  .integrity .ok { color:#047857; } .integrity .ng { color:#dc2626; }
  .integrity .note { display:block; color:var(--muted); font-size:.78rem; margin-top:6px; }
  .ledger { margin-bottom:18px; }
  .ledger h3 { font-size:.95rem; margin:0 0 6px; }
  .ledger h3 .code { color:#94a3b8; font-weight:600; }
  .ledger h3 .cat { color:var(--muted); font-size:.78rem; font-weight:400; }
</style>
</head><body>
<header>
  <h1>${view === 'trial' ? '月次試算表（BS / PL）' : '総勘定元帳'}</h1>
  ${clientName ? `<span style="color:#cbd5e1;font-size:.85rem">${esc(clientName)}</span>` : ''}
  <a class="back" href="${dashHref}" style="margin-left:auto">← ダッシュボード</a>
</header>
<div class="bar">
  <div class="tabs">
    <a class="tab ${view === 'trial' ? 'active' : ''}" href="${link({ view: 'trial' })}">試算表</a>
    <a class="tab ${view === 'ledger' ? 'active' : ''}" href="${link({ view: 'ledger' })}">総勘定元帳</a>
  </div>
  <div class="month">
    <a href="${link({ month: shiftMonth(month, -1) })}">‹</a>
    <span>${esc(month)}</span>
    <a href="${link({ month: shiftMonth(month, 1) })}">›</a>
  </div>
  <form method="get" style="margin-left:auto">
    <input type="hidden" name="view" value="${esc(view)}">
    <input type="hidden" name="month" value="${esc(month)}">
    ${key ? `<input type="hidden" name="key" value="${esc(key)}">` : ''}
    <select name="client" onchange="this.form.submit()">${clientOptions}</select>
  </form>
  ${
    fClient
      ? `<form method="post" action="/api/settings" class="taxmode">
    <input type="hidden" name="client" value="${esc(fClient)}">
    <input type="hidden" name="view" value="${esc(view)}">
    <input type="hidden" name="month" value="${esc(month)}">
    ${key ? `<input type="hidden" name="key" value="${esc(key)}">` : ''}
    <label>経理方式</label>
    <select name="tax_accounting" onchange="this.form.submit()">
      <option value="inclusive"${selectedMode === 'inclusive' ? ' selected' : ''}>税込経理</option>
      <option value="exclusive"${selectedMode === 'exclusive' ? ' selected' : ''}>税抜経理</option>
    </select>
  </form>`
      : `<span class="taxnote">経理方式は顧問先を選ぶと設定できます（既定: 税込経理）</span>`
  }
</div>
<div class="wrap">
  ${main}
</div>
</body></html>`;

  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  return res.status(200).send(html);
}
