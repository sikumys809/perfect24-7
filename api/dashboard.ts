import type { VercelRequest, VercelResponse } from '@vercel/node';
import { createClient } from '@supabase/supabase-js';

// 事務所向けの読み取り専用ダッシュボード。
// LINE で届いた書類が「整理済み」で並ぶ様子をその場で見せるための簡易ビュー。
// 認証: DASHBOARD_KEY を設定すると ?key= 必須。未設定なら誰でも閲覧可（デモ用・要注意）。
export const config = { maxDuration: 30 };

const SUPABASE_URL = (process.env.SUPABASE_URL ?? '').replace(/\/rest\/v1\/?$/, '');
const SUPABASE_KEY = process.env.SUPABASE_KEY ?? '';
const DASHBOARD_KEY = process.env.DASHBOARD_KEY ?? '';

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

const DOC_LABEL: Record<string, string> = {
  receipt: '領収書',
  invoice: '請求書',
  bankbook: '通帳',
  credit_card: 'カード明細',
  tax_payment: '納付書',
  balance_certificate: '残高証明',
  other: 'その他',
};
const DOC_COLOR: Record<string, string> = {
  receipt: '#2563eb',
  invoice: '#7c3aed',
  bankbook: '#0d9488',
  credit_card: '#db2777',
  tax_payment: '#ea580c',
  balance_certificate: '#0891b2',
  other: '#6b7280',
};

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

type Row = Record<string, any>;

async function loadData() {
  // 最新100件の書類
  const { data: receipts } = await supabase
    .from('receipts')
    .select('id, document_type, direction, total_amount, tax_amount, amount, issued_date, created_at, client_id, office_id')
    .order('created_at', { ascending: false })
    .limit(100);
  const recs: Row[] = receipts ?? [];
  if (recs.length === 0) return { recs, fieldsByRec: {}, imgByRec: {}, txnByRec: {}, clientById: {}, officeById: {}, signed: {} };

  const ids = recs.map((r) => r.id);
  const clientIds = [...new Set(recs.map((r) => r.client_id).filter(Boolean))];
  const officeIds = [...new Set(recs.map((r) => r.office_id).filter(Boolean))];

  const [fieldsRes, imgRes, txnRes, clientRes, officeRes] = await Promise.all([
    supabase.from('extracted_fields').select('receipt_id, field_name, field_value').in('receipt_id', ids),
    supabase.from('receipt_images').select('receipt_id, storage_path, content_type').in('receipt_id', ids),
    supabase
      .from('bank_transactions')
      .select('receipt_id, line_no, txn_date, description, withdrawal, deposit, balance, confidence')
      .in('receipt_id', ids)
      .order('line_no', { ascending: true }),
    clientIds.length
      ? supabase.from('clients').select('id, client_code, official_name').in('id', clientIds)
      : Promise.resolve({ data: [] as Row[] }),
    officeIds.length
      ? supabase.from('offices').select('id, office_code, name').in('id', officeIds)
      : Promise.resolve({ data: [] as Row[] }),
  ]);

  // receipt_id ごとに項目をまとめる
  const fieldsByRec: Record<string, Record<string, string>> = {};
  for (const f of fieldsRes.data ?? []) {
    (fieldsByRec[f.receipt_id] ??= {})[f.field_name] = f.field_value;
  }
  const imgByRec: Record<string, Row> = {};
  for (const im of imgRes.data ?? []) {
    imgByRec[im.receipt_id] ??= im; // 代表1枚
  }
  const txnByRec: Record<string, Row[]> = {};
  for (const t of txnRes.data ?? []) {
    (txnByRec[t.receipt_id] ??= []).push(t);
  }
  const clientById: Record<string, Row> = {};
  for (const c of clientRes.data ?? []) clientById[c.id] = c;
  const officeById: Record<string, Row> = {};
  for (const o of officeRes.data ?? []) officeById[o.id] = o;

  // 画像の署名URL（非公開バケットを安全に表示。1時間有効）
  const paths = Object.values(imgByRec)
    .map((im) => im.storage_path)
    .filter(Boolean);
  const signed: Record<string, string> = {};
  if (paths.length) {
    const { data: signedList } = await supabase.storage.from('receipts').createSignedUrls(paths, 3600);
    for (const s of signedList ?? []) {
      if (s.path && s.signedUrl) signed[s.path] = s.signedUrl;
    }
  }

  return { recs, fieldsByRec, imgByRec, txnByRec, clientById, officeById, signed };
}

function renderCard(r: Row, d: Awaited<ReturnType<typeof loadData>>): string {
  const fields = d.fieldsByRec[r.id] ?? {};
  const img = d.imgByRec[r.id];
  const signedUrl = img ? d.signed[img.storage_path] : undefined;
  const isImage = (img?.content_type ?? '').startsWith('image/');
  const client = r.client_id ? d.clientById[r.client_id] : null;

  const docType = r.document_type ?? 'other';
  const label = DOC_LABEL[docType] ?? docType ?? '未判定';
  const color = DOC_COLOR[docType] ?? '#6b7280';

  const needsReview = fields['needs_review'] === 'true';
  const notes = fields['validation_notes'];

  // サムネイル
  let thumb: string;
  if (signedUrl && isImage) {
    thumb = `<a href="${esc(signedUrl)}" target="_blank" rel="noopener"><img src="${esc(signedUrl)}" alt="receipt" loading="lazy"></a>`;
  } else if (signedUrl) {
    thumb = `<a class="pdf" href="${esc(signedUrl)}" target="_blank" rel="noopener">📄 PDFを開く</a>`;
  } else {
    thumb = `<div class="noimg">画像なし</div>`;
  }

  // 本文
  let body: string;
  if (docType === 'bankbook') {
    const txns = d.txnByRec[r.id] ?? [];
    const rows = txns
      .map(
        (t) => `<tr${(t.confidence != null && Number(t.confidence) < 0.7) ? ' class="low"' : ''}>
        <td>${esc(fmtDate(t.txn_date))}</td>
        <td class="desc">${esc(t.description ?? '')}</td>
        <td class="num">${yen(t.withdrawal)}</td>
        <td class="num">${yen(t.deposit)}</td>
        <td class="num">${yen(t.balance)}</td></tr>`,
      )
      .join('');
    body = `
      <div class="meta"><span class="vendor">通帳 明細 ${txns.length} 件</span></div>
      <table class="txns">
        <thead><tr><th>日付</th><th>摘要</th><th>出金</th><th>入金</th><th>残高</th></tr></thead>
        <tbody>${rows || '<tr><td colspan="5">明細なし</td></tr>'}</tbody>
      </table>`;
  } else if (docType === 'credit_card') {
    const txns = d.txnByRec[r.id] ?? [];
    const cardName = fields['vendor'];
    const total = txns.reduce((s, t) => s + (Number(t.withdrawal) || 0), 0);
    const rows = txns
      .map(
        (t) => `<tr${(t.confidence != null && Number(t.confidence) < 0.7) ? ' class="low"' : ''}>
        <td>${esc(fmtDate(t.txn_date))}</td>
        <td class="desc">${esc(t.description ?? '')}</td>
        <td class="num">${yen(t.withdrawal)}</td></tr>`,
      )
      .join('');
    body = `
      <div class="meta">
        <span class="vendor">${esc(cardName ?? 'カード明細')}</span>
        <span class="date">利用 ${txns.length} 件・合計 ${yen(total)}</span>
      </div>
      <table class="txns">
        <thead><tr><th>利用日</th><th>利用先</th><th>金額</th></tr></thead>
        <tbody>${rows || '<tr><td colspan="3">明細なし</td></tr>'}</tbody>
      </table>`;
  } else {
    // 取引先＝顧問先から見た相手方（売上なら宛名、経費なら発行元）
    const counterparty = fields['counterparty'] ?? fields['vendor'] ?? '取引先不明';
    const reg = fields['registration_number'];
    const taxRate = fields['tax_rate'];
    const note = fields['note'];
    const fee = fields['fee'];
    const taxKind = fields['tax_kind'];
    const period = fields['period'];
    body = `
      <div class="meta">
        <span class="vendor">${esc(counterparty)}</span>
        <span class="date">${esc(fmtDate(r.issued_date))}</span>
      </div>
      <div class="amount">${yen(r.total_amount) || '金額不明'}${fee ? `<span class="fee">手数料 ${yen(fee)}</span>` : ''}</div>
      <div class="sub">
        ${taxKind ? `<span class="taxkind">${esc(taxKind)}</span>` : ''}
        ${period ? `<span>${esc(period)}</span>` : ''}
        ${r.tax_amount != null ? `<span>税 ${yen(r.tax_amount)}</span>` : ''}
        ${taxRate ? `<span>${esc(taxRate)}</span>` : ''}
        ${reg ? `<span>登録番号 ${esc(reg)}</span>` : ''}
      </div>
      ${note ? `<div class="note">${esc(note)}</div>` : ''}`;
  }

  return `
  <div class="card">
    <div class="thumb">${thumb}</div>
    <div class="info">
      <div class="top">
        <span class="badge" style="background:${color}">${esc(label)}</span>
        ${docType !== 'bankbook' && r.direction ? `<span class="side ${r.direction === 'sales' ? 'sales' : 'expense'}">${r.direction === 'sales' ? '売上' : '経費'}</span>` : ''}
        ${client ? `<span class="client">${esc(client.official_name)} <small>${esc(client.client_code)}</small></span>` : ''}
        ${needsReview ? `<span class="review">⚠️ 要確認</span>` : ''}
      </div>
      ${body}
      ${needsReview && notes ? `<div class="notes">${esc(notes)}</div>` : ''}
      <div class="received">受信: ${esc(new Date(r.created_at).toLocaleString('ja-JP', { timeZone: 'Asia/Tokyo' }))}</div>
    </div>
  </div>`;
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  // 簡易アクセス保護
  const keyEnforced = DASHBOARD_KEY.length > 0;
  if (keyEnforced && req.query.key !== DASHBOARD_KEY) {
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    return res.status(401).send('<!doctype html><meta charset="utf-8"><body style="font-family:sans-serif;padding:2rem">アクセスキーが必要です（?key=...）。</body>');
  }

  let d: Awaited<ReturnType<typeof loadData>>;
  try {
    d = await loadData();
  } catch (err) {
    console.error('dashboard load error', err);
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    return res.status(500).send('<!doctype html><meta charset="utf-8"><body style="font-family:sans-serif;padding:2rem">データ取得でエラーが発生しました。</body>');
  }

  // フィルタ用パラメータ
  const showAll = req.query.all === '1';
  const fType = typeof req.query.type === 'string' ? req.query.type : '';
  const fDir = typeof req.query.dir === 'string' ? req.query.dir : ''; // sales | expense
  const fClient = typeof req.query.client === 'string' ? req.query.client : '';
  const fq = (typeof req.query.q === 'string' ? req.query.q : '').trim();
  const key = typeof req.query.key === 'string' ? req.query.key : '';

  // 現在のフィルタを維持したままパラメータを差し替えるURLを作る
  const withParams = (ov: { type?: string; dir?: string; client?: string; q?: string }) => {
    const p = new URLSearchParams();
    const t = ov.type !== undefined ? ov.type : fType;
    const dr = ov.dir !== undefined ? ov.dir : fDir;
    const c = ov.client !== undefined ? ov.client : fClient;
    const q = ov.q !== undefined ? ov.q : fq;
    if (t) p.set('type', t);
    if (dr) p.set('dir', dr);
    if (c) p.set('client', c);
    if (q) p.set('q', q);
    if (showAll) p.set('all', '1');
    if (key) p.set('key', key);
    const s = p.toString();
    return s ? '?' + s : '';
  };

  // 解析できた書類だけを表示（?all=1 で未処理・空カードも含め全件表示）。
  // 判定: 通帳 / 金額あり / 取引先ありのいずれか＝意味のある抽出ができている
  const isMeaningful = (r: Row) =>
    r.document_type === 'bankbook' ||
    r.total_amount != null ||
    Boolean(d.fieldsByRec[r.id]?.['vendor']);
  const meaningfulRecs = showAll ? d.recs : d.recs.filter(isMeaningful);
  const hiddenCount = showAll ? 0 : d.recs.length - meaningfulRecs.length;

  // 種別・売上経費・顧問先・取引先検索で絞り込み
  let displayRecs = meaningfulRecs;
  if (fType) displayRecs = displayRecs.filter((r) => (r.document_type ?? 'other') === fType);
  if (fDir) displayRecs = displayRecs.filter((r) => r.direction === fDir);
  if (fClient) displayRecs = displayRecs.filter((r) => r.client_id === fClient);
  if (fq) {
    const ql = fq.toLowerCase();
    displayRecs = displayRecs.filter((r) =>
      String(d.fieldsByRec[r.id]?.['counterparty'] ?? d.fieldsByRec[r.id]?.['vendor'] ?? '')
        .toLowerCase()
        .includes(ql),
    );
  }

  const reviewCount = displayRecs.filter((r) => d.fieldsByRec[r.id]?.['needs_review'] === 'true').length;

  // 売上/経費の当月合計（表示中の集合に対して）。税込金額ベース
  const sumByDir = (dir: string) =>
    displayRecs
      .filter((r) => r.direction === dir && r.document_type !== 'bankbook')
      .reduce((s, r) => s + (Number(r.total_amount) || 0), 0);
  const salesTotal = sumByDir('sales');
  const expenseTotal = sumByDir('expense');

  // 種別タブ（件数つき）
  const typeDefs: [string, string][] = [
    ['', 'すべて'],
    ['receipt', '領収書'],
    ['invoice', '請求書'],
    ['tax_payment', '納付書'],
    ['credit_card', 'カード'],
    ['bankbook', '通帳'],
  ];
  const typeTabs = typeDefs
    .map(([val, label]) => {
      const n =
        val === '' ? meaningfulRecs.length : meaningfulRecs.filter((r) => (r.document_type ?? 'other') === val).length;
      const active = fType === val ? ' active' : '';
      return `<a class="tab${active}" href="${withParams({ type: val })}">${esc(label)} <b>${n}</b></a>`;
    })
    .join('');

  // 売上/経費タブ
  const dirDefs: [string, string][] = [
    ['', 'すべて'],
    ['sales', '売上'],
    ['expense', '経費'],
  ];
  const dirTabs = dirDefs
    .map(([val, label]) => {
      const n =
        val === ''
          ? meaningfulRecs.filter((r) => r.document_type !== 'bankbook').length
          : meaningfulRecs.filter((r) => r.direction === val).length;
      const active = fDir === val ? ' active' : '';
      return `<a class="tab dir ${val}${active}" href="${withParams({ dir: val })}">${esc(label)} <b>${n}</b></a>`;
    })
    .join('');

  // 顧問先ドロップダウン（書類のある顧問先のみ）
  const clients = Object.values(d.clientById).sort((a, b) =>
    String(a.client_code).localeCompare(String(b.client_code)),
  );
  const clientOptions = [
    `<option value="">全顧問先</option>`,
    ...clients.map(
      (c) => `<option value="${esc(c.id)}"${fClient === c.id ? ' selected' : ''}>${esc(c.official_name)}</option>`,
    ),
  ].join('');

  const filterBar = `
  <div class="filterbar">
    <div class="tabs">${typeTabs}</div>
    <span class="divider"></span>
    <div class="tabs">${dirTabs}</div>
    <form class="filters" method="get">
      ${key ? `<input type="hidden" name="key" value="${esc(key)}">` : ''}
      ${fType ? `<input type="hidden" name="type" value="${esc(fType)}">` : ''}
      ${fDir ? `<input type="hidden" name="dir" value="${esc(fDir)}">` : ''}
      ${showAll ? `<input type="hidden" name="all" value="1">` : ''}
      <select name="client" onchange="this.form.submit()">${clientOptions}</select>
      <input name="q" value="${esc(fq)}" placeholder="取引先で検索" autocomplete="off">
      <button type="submit">検索</button>
      ${fq || fClient ? `<a class="clear" href="${withParams({ client: '', q: '' })}">クリア</a>` : ''}
    </form>
    <a class="csv" href="/api/export${withParams({})}">⬇ CSVダウンロード（${displayRecs.length}）</a>
  </div>`;

  const summary = [
    `${displayRecs.length} 件`,
    salesTotal ? `売上 ¥${salesTotal.toLocaleString()}` : '',
    expenseTotal ? `経費 ¥${expenseTotal.toLocaleString()}` : '',
    reviewCount ? `⚠️要確認 ${reviewCount}` : '',
    hiddenCount ? `未処理 ${hiddenCount}件は非表示` : '',
  ]
    .filter(Boolean)
    .join(' ・ ');

  const cards = displayRecs.length
    ? displayRecs.map((r) => renderCard(r, d)).join('\n')
    : '<div class="empty">該当する書類がありません。LINE で領収書・請求書・通帳を送ってください。</div>';

  const html = `<!doctype html>
<html lang="ja"><head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta http-equiv="refresh" content="20">
<title>証憑ダッシュボード｜パーフェクト24/7</title>
<style>
  :root { --bg:#f1f5f9; --card:#fff; --line:#e2e8f0; --text:#0f172a; --muted:#64748b; }
  * { box-sizing:border-box; }
  body { margin:0; background:var(--bg); color:var(--text); font-family:-apple-system,BlinkMacSystemFont,"Hiragino Kaku Gothic ProN","Noto Sans JP",sans-serif; }
  header { position:sticky; top:0; background:#0f172a; color:#fff; padding:14px 18px; display:flex; align-items:baseline; gap:14px; flex-wrap:wrap; z-index:10; }
  header h1 { font-size:1.05rem; margin:0; font-weight:700; }
  header .sum { color:#cbd5e1; font-size:.85rem; }
  header .live { margin-left:auto; font-size:.75rem; color:#34d399; }
  .wrap { max-width:1100px; margin:0 auto; padding:16px; }
  .card { display:flex; gap:14px; background:var(--card); border:1px solid var(--line); border-radius:14px; padding:14px; margin-bottom:12px; box-shadow:0 1px 2px rgba(0,0,0,.04); }
  .thumb { flex:0 0 120px; }
  .thumb img { width:120px; height:120px; object-fit:cover; border-radius:10px; border:1px solid var(--line); background:#f8fafc; }
  .thumb .pdf, .thumb .noimg { width:120px; height:120px; display:flex; align-items:center; justify-content:center; border-radius:10px; border:1px dashed var(--line); color:var(--muted); font-size:.8rem; text-align:center; text-decoration:none; }
  .info { flex:1; min-width:0; }
  .top { display:flex; align-items:center; gap:8px; flex-wrap:wrap; margin-bottom:6px; }
  .badge { color:#fff; font-size:.72rem; font-weight:700; padding:2px 9px; border-radius:999px; }
  .client { font-size:.85rem; color:var(--muted); }
  .client small { color:#94a3b8; }
  .review { color:#b45309; background:#fef3c7; font-size:.72rem; font-weight:700; padding:2px 8px; border-radius:999px; }
  .side { font-size:.72rem; font-weight:700; padding:2px 9px; border-radius:999px; }
  .side.sales { color:#047857; background:#d1fae5; }
  .side.expense { color:#1e40af; background:#dbeafe; }
  .meta { display:flex; align-items:baseline; gap:10px; flex-wrap:wrap; }
  .vendor { font-size:1.05rem; font-weight:700; }
  .date { color:var(--muted); font-size:.85rem; }
  .amount { font-size:1.5rem; font-weight:800; margin:4px 0; letter-spacing:.02em; }
  .amount .fee { font-size:.8rem; font-weight:600; color:var(--muted); margin-left:10px; }
  .sub { display:flex; gap:12px; flex-wrap:wrap; color:var(--muted); font-size:.82rem; align-items:center; }
  .sub .taxkind { color:#9a3412; background:#ffedd5; font-weight:700; padding:1px 8px; border-radius:999px; }
  .note { margin-top:5px; font-size:.85rem; color:#334155; }
  .notes { margin-top:6px; font-size:.8rem; color:#b45309; background:#fffbeb; border:1px solid #fde68a; border-radius:8px; padding:5px 9px; }
  .received { margin-top:8px; font-size:.72rem; color:#94a3b8; }
  table.txns { width:100%; border-collapse:collapse; margin-top:8px; font-size:.82rem; }
  table.txns th { text-align:left; color:var(--muted); font-weight:600; border-bottom:1px solid var(--line); padding:4px 6px; }
  table.txns td { border-bottom:1px solid #f1f5f9; padding:4px 6px; }
  table.txns td.num { text-align:right; font-variant-numeric:tabular-nums; }
  table.txns td.desc { color:#334155; }
  table.txns tr.low td { background:#fffbeb; }
  .empty { text-align:center; color:var(--muted); padding:60px 20px; }
  .filterbar { background:#fff; border-bottom:1px solid var(--line); padding:10px 16px; display:flex; gap:14px; align-items:center; flex-wrap:wrap; position:sticky; top:51px; z-index:9; }
  .tabs { display:flex; gap:6px; flex-wrap:wrap; }
  .tab { text-decoration:none; color:var(--muted); font-size:.85rem; padding:5px 12px; border-radius:999px; border:1px solid var(--line); }
  .tab b { color:#94a3b8; font-weight:700; }
  .tab.active { background:#0f172a; color:#fff; border-color:#0f172a; }
  .tab.active b { color:#cbd5e1; }
  .tab.dir.sales.active { background:#047857; border-color:#047857; }
  .tab.dir.expense.active { background:#1e40af; border-color:#1e40af; }
  .divider { width:1px; height:20px; background:var(--line); }
  .filters { display:flex; gap:6px; align-items:center; }
  .filters select, .filters input { font-size:.85rem; padding:6px 9px; border:1px solid var(--line); border-radius:8px; background:#fff; }
  .filters button { font-size:.85rem; padding:6px 12px; border:none; border-radius:8px; background:#2563eb; color:#fff; cursor:pointer; }
  .filters .clear { font-size:.8rem; color:var(--muted); text-decoration:none; }
  .csv { margin-left:auto; text-decoration:none; font-size:.85rem; font-weight:700; color:#0d9488; border:1px solid #5eead4; background:#f0fdfa; padding:7px 14px; border-radius:9px; }
  @media (max-width:560px){ .thumb{ flex-basis:84px } .thumb img,.thumb .pdf,.thumb .noimg{ width:84px;height:84px } .amount{ font-size:1.25rem } .filterbar{ top:47px } .csv{ margin-left:0 } }
</style>
</head><body>
<header>
  <h1>証憑ダッシュボード</h1>
  <span class="sum">${esc(summary)}</span>
  <span class="live">● 20秒ごとに自動更新</span>
</header>
${filterBar}
<div class="wrap">
  ${cards}
</div>
</body></html>`;

  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  return res.status(200).send(html);
}
