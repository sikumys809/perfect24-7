import type { VercelRequest, VercelResponse } from '@vercel/node';
import { createClient } from '@supabase/supabase-js';
import JSZip from 'jszip';

// ダッシュボードと同じ絞り込み（type/client/q）で証憑データを CSV 出力する。
// 種別を選べばその単一CSV、未選択(すべて)なら全ジャンルのCSVをZIPでまとめて出す。
export const config = { maxDuration: 30 };

const SUPABASE_URL = (process.env.SUPABASE_URL ?? '').replace(/\/rest\/v1\/?$/, '');
const SUPABASE_KEY = process.env.SUPABASE_KEY ?? '';
const DASHBOARD_KEY = process.env.DASHBOARD_KEY ?? '';
const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

// 明細行型（document-level CSV からは除外し、専用CSVで出す）
const LINE_TYPES = ['bankbook', 'petty_cash', 'credit_card', 'inventory', 'loan_schedule', 'payslip', 'wage_ledger'];

const DOC_LABEL: Record<string, string> = {
  receipt: '領収書', invoice: '請求書', bankbook: '通帳', credit_card: 'カード明細',
  tax_payment: '納付書', balance_certificate: '残高証明', inventory: '棚卸表',
  loan_schedule: '返済予定表', payslip: '給与明細', wage_ledger: '賃金台帳',
  fixed_asset: '固定資産', ec_payout: 'EC入金', petty_cash: '小口現金', other: 'その他',
};

type Row = Record<string, any>;

// CSV セル: ダブルクオートで囲み、内部の " は "" にエスケープ
function cell(v: unknown): string {
  const s = v === null || v === undefined ? '' : String(v);
  return '"' + s.replace(/"/g, '""') + '"';
}
function toCsv(rows: (string | number | null | undefined)[][]): string {
  // 先頭に BOM を付け、Excel で日本語が文字化けしないようにする
  return '﻿' + rows.map((r) => r.map(cell).join(',')).join('\r\n') + '\r\n';
}
function jst(ts: unknown): string {
  if (!ts) return '';
  return new Date(String(ts)).toLocaleString('ja-JP', { timeZone: 'Asia/Tokyo' });
}
function fmtDate(d: unknown): string {
  return typeof d === 'string' && d ? d.slice(0, 10) : '';
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (DASHBOARD_KEY.length > 0 && req.query.key !== DASHBOARD_KEY) {
    return res.status(401).send('アクセスキーが必要です（?key=...）。');
  }

  const fType = typeof req.query.type === 'string' ? req.query.type : '';
  const fClient = typeof req.query.client === 'string' ? req.query.client : '';
  const fq = (typeof req.query.q === 'string' ? req.query.q : '').trim().toLowerCase();

  // 期間（ダッシュボードと同じ from/to / month）。指定があれば issued_date で範囲抽出
  const eFrom = typeof req.query.from === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(req.query.from) ? req.query.from : '';
  const eTo = typeof req.query.to === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(req.query.to) ? req.query.to : '';
  const eMonth = typeof req.query.month === 'string' && /^\d{4}-\d{2}$/.test(req.query.month) ? req.query.month : '';
  let pFrom = '', pTo = '';
  if (eFrom && eTo) { pFrom = eFrom; pTo = eTo; }
  else if (eMonth) { const [y, m] = eMonth.split('-').map(Number); pFrom = `${eMonth}-01`; const d = new Date(Date.UTC(y, m, 0)); pTo = `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}`; }

  // 対象の書類を取得（期間指定時は範囲・最大2000件、無指定は最新500件）
  const fDir = typeof req.query.dir === 'string' ? req.query.dir : '';
  let q = supabase
    .from('receipts')
    .select('id, document_type, direction, total_amount, tax_amount, issued_date, created_at, client_id, account_code');
  q = pFrom && pTo
    ? q.gte('issued_date', pFrom).lte('issued_date', pTo).order('issued_date', { ascending: false }).limit(2000)
    : q.order('created_at', { ascending: false }).limit(500);
  if (fType) q = q.eq('document_type', fType);
  if (fDir) q = q.eq('direction', fDir);
  if (fClient) q = q.eq('client_id', fClient);
  const { data: receipts, error } = await q;
  if (error) {
    console.error('export query error', error);
    return res.status(500).send('データ取得でエラーが発生しました。');
  }
  const recs: Row[] = receipts ?? [];
  const ids = recs.map((r) => r.id);
  const clientIds = [...new Set(recs.map((r) => r.client_id).filter(Boolean))];

  const [fieldsRes, txnRes, lineRes, payRes, clientRes, accountRes] = await Promise.all([
    ids.length
      ? supabase.from('extracted_fields').select('receipt_id, field_name, field_value').in('receipt_id', ids)
      : Promise.resolve({ data: [] as Row[] }),
    ids.length
      ? supabase
          .from('bank_transactions')
          .select('receipt_id, line_no, txn_date, description, withdrawal, deposit, balance')
          .in('receipt_id', ids)
          .order('line_no', { ascending: true })
      : Promise.resolve({ data: [] as Row[] }),
    ids.length
      ? supabase
          .from('document_lines')
          .select('receipt_id, line_no, line_type, label, line_date, quantity, unit_price, amount, principal, interest, balance')
          .in('receipt_id', ids)
          .order('line_no', { ascending: true })
          .then((r) => r, () => ({ data: [] as Row[] }))
      : Promise.resolve({ data: [] as Row[] }),
    ids.length
      ? supabase
          .from('payroll_lines')
          .select('receipt_id, line_no, employee, pay_month, gross, health_insurance, pension, employment_insurance, income_tax, resident_tax, other_deduction, total_deduction, net')
          .in('receipt_id', ids)
          .order('line_no', { ascending: true })
          .then((r) => r, () => ({ data: [] as Row[] }))
      : Promise.resolve({ data: [] as Row[] }),
    clientIds.length
      ? supabase.from('clients').select('id, client_code, official_name').in('id', clientIds)
      : Promise.resolve({ data: [] as Row[] }),
    supabase.from('account_titles').select('code, name').then((r) => r, () => ({ data: [] as Row[] })),
  ]);

  const fieldsByRec: Record<string, Record<string, string>> = {};
  for (const f of fieldsRes.data ?? []) (fieldsByRec[f.receipt_id] ??= {})[f.field_name] = f.field_value;
  const txnByRec: Record<string, Row[]> = {};
  for (const t of txnRes.data ?? []) (txnByRec[t.receipt_id] ??= []).push(t);
  const lineByRec: Record<string, Row[]> = {};
  for (const l of lineRes.data ?? []) (lineByRec[l.receipt_id] ??= []).push(l);
  const payByRec: Record<string, Row[]> = {};
  for (const p of payRes.data ?? []) (payByRec[p.receipt_id] ??= []).push(p);
  const clientById: Record<string, Row> = {};
  for (const c of clientRes.data ?? []) clientById[c.id] = c;
  const accountName: Record<string, string> = {};
  for (const a of accountRes.data ?? []) accountName[a.code] = a.name;

  const clientName = (r: Row) => (r.client_id ? clientById[r.client_id]?.official_name ?? '' : '');
  const clientCode = (r: Row) => (r.client_id ? clientById[r.client_id]?.client_code ?? '' : '');

  // 解析できた書類のみ（未処理は除外）。金額/取引先/明細行のいずれかがあれば対象。取引先検索 q も適用
  const meaningful = recs.filter(
    (r) =>
      r.total_amount != null ||
      Boolean(fieldsByRec[r.id]?.['vendor']) ||
      (txnByRec[r.id]?.length ?? 0) > 0 ||
      (lineByRec[r.id]?.length ?? 0) > 0 ||
      (payByRec[r.id]?.length ?? 0) > 0,
  );
  const filtered = fq
    ? meaningful.filter((r) => String(fieldsByRec[r.id]?.['vendor'] ?? '').toLowerCase().includes(fq))
    : meaningful;

  const reviewOf = (r: Row) => (fieldsByRec[r.id]?.['needs_review'] === 'true' ? '要確認' : '');
  // 各ジャンルのCSVを作る（データが無ければ null）。列構成が違うのでジャンルごとに別ファイル。
  function buildDocuments(): string | null {
    const header = [
      '受信日時', '顧問先ID', '顧問先', '売上経費', '勘定科目', '種別', '日付', '取引先', '発行元', '宛名',
      '税込金額', '消費税', '手数料', '入金額', '税率', '税目', '対象期間', '資産名', '資産区分', '耐用年数',
      '登録番号', '番号', '但し書き', '要確認', '検算メモ',
    ];
    const dirLabel = (dir: unknown) => (dir === 'sales' ? '売上' : dir === 'expense' ? '経費' : '');
    const rows = filtered
      .filter((r) => !LINE_TYPES.includes(r.document_type as string))
      .map((r) => {
        const f = fieldsByRec[r.id] ?? {};
        return [
          jst(r.created_at), clientCode(r), clientName(r), dirLabel(r.direction),
          r.account_code ? accountName[r.account_code] ?? r.account_code : '',
          DOC_LABEL[r.document_type as string] ?? r.document_type ?? '',
          fmtDate(r.issued_date), f['counterparty'] ?? f['vendor'] ?? '', f['vendor'] ?? '', f['recipient'] ?? '',
          r.total_amount ?? '', r.tax_amount ?? '', f['fee'] ?? '', f['net_amount'] ?? '', f['tax_rate'] ?? '',
          f['tax_kind'] ?? '', f['period'] ?? '', f['asset_name'] ?? '', f['asset_category'] ?? '', f['useful_life'] ?? '',
          f['registration_number'] ?? '', f['receipt_no'] ?? '', f['note'] ?? '',
          reviewOf(r), f['validation_notes'] ?? '',
        ];
      });
    return rows.length ? toCsv([header, ...rows]) : null;
  }
  function buildLedger(type: string): string | null {
    const header = ['受信日時', '顧問先ID', '顧問先', '帳簿ID', '行', '取引日', '摘要', '出金/支払', '入金/受入', '残高', '要確認'];
    const body: (string | number | null)[][] = [];
    for (const r of filtered.filter((r) => r.document_type === type))
      for (const t of txnByRec[r.id] ?? [])
        body.push([jst(r.created_at), clientCode(r), clientName(r), String(r.id).slice(0, 8), t.line_no, fmtDate(t.txn_date), t.description ?? '', t.withdrawal ?? '', t.deposit ?? '', t.balance ?? '', reviewOf(r)]);
    return body.length ? toCsv([header, ...body]) : null;
  }
  function buildCard(): string | null {
    const header = ['受信日時', '顧問先ID', '顧問先', 'カード', '明細ID', '行', '利用日', '利用先', '金額', '要確認'];
    const body: (string | number | null)[][] = [];
    for (const r of filtered.filter((r) => r.document_type === 'credit_card'))
      for (const t of txnByRec[r.id] ?? [])
        body.push([jst(r.created_at), clientCode(r), clientName(r), fieldsByRec[r.id]?.['vendor'] ?? '', String(r.id).slice(0, 8), t.line_no, fmtDate(t.txn_date), t.description ?? '', t.withdrawal ?? '', reviewOf(r)]);
    return body.length ? toCsv([header, ...body]) : null;
  }
  function buildInventory(): string | null {
    const header = ['受信日時', '顧問先ID', '顧問先', '棚卸ID', '行', '品名', '数量', '単価', '金額', '要確認'];
    const body: (string | number | null)[][] = [];
    for (const r of filtered.filter((r) => r.document_type === 'inventory'))
      for (const l of lineByRec[r.id] ?? [])
        body.push([jst(r.created_at), clientCode(r), clientName(r), String(r.id).slice(0, 8), l.line_no, l.label ?? '', l.quantity ?? '', l.unit_price ?? '', l.amount ?? '', reviewOf(r)]);
    return body.length ? toCsv([header, ...body]) : null;
  }
  function buildLoan(): string | null {
    const header = ['受信日時', '顧問先ID', '顧問先', '借入先', '返済表ID', '回', '返済日', '返済額', '元金', '利息', '残高', '要確認'];
    const body: (string | number | null)[][] = [];
    for (const r of filtered.filter((r) => r.document_type === 'loan_schedule'))
      for (const l of lineByRec[r.id] ?? [])
        body.push([jst(r.created_at), clientCode(r), clientName(r), fieldsByRec[r.id]?.['vendor'] ?? '', String(r.id).slice(0, 8), l.label ?? '', fmtDate(l.line_date), l.amount ?? '', l.principal ?? '', l.interest ?? '', l.balance ?? '', reviewOf(r)]);
    return body.length ? toCsv([header, ...body]) : null;
  }
  function buildPayroll(): string | null {
    const header = ['受信日時', '顧問先ID', '顧問先', '給与ID', '行', '従業員', '支給月', '総支給', '健康保険', '厚生年金', '雇用保険', '源泉所得税', '住民税', 'その他控除', '控除合計', '差引支給', '要確認'];
    const body: (string | number | null)[][] = [];
    for (const r of filtered.filter((r) => r.document_type === 'payslip' || r.document_type === 'wage_ledger'))
      for (const p of payByRec[r.id] ?? [])
        body.push([jst(r.created_at), clientCode(r), clientName(r), String(r.id).slice(0, 8), p.line_no, p.employee ?? '', p.pay_month ?? '', p.gross ?? '', p.health_insurance ?? '', p.pension ?? '', p.employment_insurance ?? '', p.income_tax ?? '', p.resident_tax ?? '', p.other_deduction ?? '', p.total_deduction ?? '', p.net ?? '', reviewOf(r)]);
    return body.length ? toCsv([header, ...body]) : null;
  }

  // 種別を選んでいれば単一CSV、未選択(すべて)なら全ジャンルをZIPでまとめて出す
  const singleFor = (t: string): string | null => {
    if (t === 'bankbook' || t === 'petty_cash') return buildLedger(t);
    if (t === 'credit_card') return buildCard();
    if (t === 'inventory') return buildInventory();
    if (t === 'loan_schedule') return buildLoan();
    if (t === 'payslip' || t === 'wage_ledger') return buildPayroll();
    return buildDocuments();
  };

  res.setHeader('Cache-Control', 'no-store');
  if (fType) {
    const csv = singleFor(fType) ?? toCsv([['データがありません']]);
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="perfect247_${fType}.csv"`);
    return res.status(200).send(csv);
  }

  // すべて → 全ジャンルをZIP（中身は会計ソフト取込用CSV。READMEで各ファイルの説明）
  const parts: { name: string; label: string; csv: string | null }[] = [
    { name: 'documents.csv', label: '領収書・請求書・納付書・残高証明・固定資産・EC入金', csv: buildDocuments() },
    { name: 'bankbook.csv', label: '通帳', csv: buildLedger('bankbook') },
    { name: 'petty_cash.csv', label: '小口現金出納帳', csv: buildLedger('petty_cash') },
    { name: 'credit_card.csv', label: 'クレジットカード明細', csv: buildCard() },
    { name: 'payroll.csv', label: '給与明細・賃金台帳', csv: buildPayroll() },
    { name: 'inventory.csv', label: '棚卸表', csv: buildInventory() },
    { name: 'loan_schedule.csv', label: '借入金返済予定表', csv: buildLoan() },
  ];
  const present = parts.filter((p) => p.csv);
  if (present.length === 0) {
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="perfect247_empty.csv"`);
    return res.status(200).send(toCsv([['データがありません']]));
  }
  const zip = new JSZip();
  for (const p of present) zip.file(p.name, p.csv as string);
  zip.file(
    'README.txt',
    '﻿パーフェクト24/7 書類データ一式\n\n各CSVの内容:\n' +
      present.map((p) => `  ${p.name} … ${p.label}`).join('\n') +
      '\n\n※ CSVはUTF-8(BOM付)。Excelでそのまま開けます。\n',
  );
  const buf = await zip.generateAsync({ type: 'nodebuffer' });
  const stamp = new Date().toISOString().slice(0, 10);
  res.setHeader('Content-Type', 'application/zip');
  res.setHeader('Content-Disposition', `attachment; filename="perfect247_all_${stamp}.zip"`);
  return res.status(200).send(buf);
}
