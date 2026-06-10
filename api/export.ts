import type { VercelRequest, VercelResponse } from '@vercel/node';
import { createClient } from '@supabase/supabase-js';

// ダッシュボードと同じ絞り込み（type/client/q）で証憑データを CSV 出力する。
// 「読み取った内容をそのまま会計ソフトに取り込む」導線のデモ用。
export const config = { maxDuration: 30 };

const SUPABASE_URL = (process.env.SUPABASE_URL ?? '').replace(/\/rest\/v1\/?$/, '');
const SUPABASE_KEY = process.env.SUPABASE_KEY ?? '';
const DASHBOARD_KEY = process.env.DASHBOARD_KEY ?? '';
const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

const DOC_LABEL: Record<string, string> = {
  receipt: '領収書',
  invoice: '請求書',
  bankbook: '通帳',
  other: 'その他',
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

  // 対象の書類を取得（最新500件まで）
  const fDir = typeof req.query.dir === 'string' ? req.query.dir : '';
  let q = supabase
    .from('receipts')
    .select('id, document_type, direction, total_amount, tax_amount, issued_date, created_at, client_id')
    .order('created_at', { ascending: false })
    .limit(500);
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

  const [fieldsRes, txnRes, lineRes, clientRes] = await Promise.all([
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
    clientIds.length
      ? supabase.from('clients').select('id, client_code, official_name').in('id', clientIds)
      : Promise.resolve({ data: [] as Row[] }),
  ]);

  const fieldsByRec: Record<string, Record<string, string>> = {};
  for (const f of fieldsRes.data ?? []) (fieldsByRec[f.receipt_id] ??= {})[f.field_name] = f.field_value;
  const txnByRec: Record<string, Row[]> = {};
  for (const t of txnRes.data ?? []) (txnByRec[t.receipt_id] ??= []).push(t);
  const lineByRec: Record<string, Row[]> = {};
  for (const l of lineRes.data ?? []) (lineByRec[l.receipt_id] ??= []).push(l);
  const clientById: Record<string, Row> = {};
  for (const c of clientRes.data ?? []) clientById[c.id] = c;

  const clientName = (r: Row) => (r.client_id ? clientById[r.client_id]?.official_name ?? '' : '');
  const clientCode = (r: Row) => (r.client_id ? clientById[r.client_id]?.client_code ?? '' : '');

  // 解析できた書類のみ（未処理は除外）。取引先検索 q も適用
  const meaningful = recs.filter(
    (r) => r.document_type === 'bankbook' || r.total_amount != null || Boolean(fieldsByRec[r.id]?.['vendor']),
  );
  const filtered = fq
    ? meaningful.filter((r) => String(fieldsByRec[r.id]?.['vendor'] ?? '').toLowerCase().includes(fq))
    : meaningful;

  let csv: string;
  let fname: string;

  if (fType === 'bankbook') {
    // 通帳は明細1行=1レコードで出力
    const header = ['受信日時', '顧問先ID', '顧問先', '通帳ID', '行', '取引日', '摘要', '出金', '入金', '残高', '要確認'];
    const body: (string | number | null)[][] = [];
    for (const r of filtered) {
      const review = fieldsByRec[r.id]?.['needs_review'] === 'true' ? '要確認' : '';
      for (const t of txnByRec[r.id] ?? []) {
        body.push([
          jst(r.created_at), clientCode(r), clientName(r), String(r.id).slice(0, 8),
          t.line_no, fmtDate(t.txn_date), t.description ?? '',
          t.withdrawal ?? '', t.deposit ?? '', t.balance ?? '', review,
        ]);
      }
    }
    csv = toCsv([header, ...body]);
    fname = 'bankbook';
  } else if (fType === 'credit_card') {
    // カード明細は利用1行=1レコードで出力
    const header = ['受信日時', '顧問先ID', '顧問先', 'カード', '明細ID', '行', '利用日', '利用先', '金額', '要確認'];
    const body: (string | number | null)[][] = [];
    for (const r of filtered) {
      const review = fieldsByRec[r.id]?.['needs_review'] === 'true' ? '要確認' : '';
      const card = fieldsByRec[r.id]?.['vendor'] ?? '';
      for (const t of txnByRec[r.id] ?? []) {
        body.push([
          jst(r.created_at), clientCode(r), clientName(r), card, String(r.id).slice(0, 8),
          t.line_no, fmtDate(t.txn_date), t.description ?? '', t.withdrawal ?? '', review,
        ]);
      }
    }
    csv = toCsv([header, ...body]);
    fname = 'credit_card';
  } else if (fType === 'inventory') {
    // 棚卸表は品目1行=1レコードで出力
    const header = ['受信日時', '顧問先ID', '顧問先', '棚卸ID', '行', '品名', '数量', '単価', '金額', '要確認'];
    const body: (string | number | null)[][] = [];
    for (const r of filtered) {
      const review = fieldsByRec[r.id]?.['needs_review'] === 'true' ? '要確認' : '';
      for (const l of lineByRec[r.id] ?? []) {
        body.push([
          jst(r.created_at), clientCode(r), clientName(r), String(r.id).slice(0, 8),
          l.line_no, l.label ?? '', l.quantity ?? '', l.unit_price ?? '', l.amount ?? '', review,
        ]);
      }
    }
    csv = toCsv([header, ...body]);
    fname = 'inventory';
  } else if (fType === 'loan_schedule') {
    // 借入金返済予定表は返済1回=1レコードで出力
    const header = ['受信日時', '顧問先ID', '顧問先', '借入先', '返済表ID', '回', '返済日', '返済額', '元金', '利息', '残高', '要確認'];
    const body: (string | number | null)[][] = [];
    for (const r of filtered) {
      const review = fieldsByRec[r.id]?.['needs_review'] === 'true' ? '要確認' : '';
      const lender = fieldsByRec[r.id]?.['vendor'] ?? '';
      for (const l of lineByRec[r.id] ?? []) {
        body.push([
          jst(r.created_at), clientCode(r), clientName(r), lender, String(r.id).slice(0, 8),
          l.label ?? '', fmtDate(l.line_date), l.amount ?? '', l.principal ?? '', l.interest ?? '', l.balance ?? '', review,
        ]);
      }
    }
    csv = toCsv([header, ...body]);
    fname = 'loan_schedule';
  } else {
    // 領収書・請求書（および種別未指定の通帳以外）
    const header = [
      '受信日時', '顧問先ID', '顧問先', '売上経費', '種別', '日付', '取引先', '発行元', '宛名',
      '税込金額', '消費税', '手数料', '税率', '税目', '対象期間', '登録番号', '番号', '但し書き', '要確認', '検算メモ',
    ];
    const dirLabel = (dir: unknown) => (dir === 'sales' ? '売上' : dir === 'expense' ? '経費' : '');
    const body = filtered
      .filter(
        (r) =>
          !['bankbook', 'credit_card', 'inventory', 'loan_schedule'].includes(r.document_type as string),
      )
      .map((r) => {
        const f = fieldsByRec[r.id] ?? {};
        return [
          jst(r.created_at), clientCode(r), clientName(r), dirLabel(r.direction),
          DOC_LABEL[r.document_type as string] ?? r.document_type ?? '',
          fmtDate(r.issued_date), f['counterparty'] ?? f['vendor'] ?? '', f['vendor'] ?? '', f['recipient'] ?? '',
          r.total_amount ?? '', r.tax_amount ?? '', f['fee'] ?? '', f['tax_rate'] ?? '',
          f['tax_kind'] ?? '', f['period'] ?? '',
          f['registration_number'] ?? '', f['receipt_no'] ?? '', f['note'] ?? '',
          f['needs_review'] === 'true' ? '要確認' : '', f['validation_notes'] ?? '',
        ];
      });
    csv = toCsv([header, ...body]);
    fname = fType || 'receipts';
  }

  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="perfect247_${fname}.csv"`);
  res.setHeader('Cache-Control', 'no-store');
  return res.status(200).send(csv);
}
