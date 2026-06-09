import type { VercelRequest, VercelResponse } from '@vercel/node';
import crypto from 'node:crypto';
import { waitUntil } from '@vercel/functions';
import { createClient } from '@supabase/supabase-js';
import Anthropic from '@anthropic-ai/sdk';

// LINE署名を生データで検証するため、Vercelの自動body解析を無効化
// 大きめPDFの解析に時間がかかるため実行上限を延長（Hobbyの上限60秒）
export const config = { api: { bodyParser: false }, maxDuration: 60 };

const LINE_CHANNEL_SECRET = process.env.LINE_CHANNEL_SECRET ?? '';
const LINE_CHANNEL_ACCESS_TOKEN = process.env.LINE_CHANNEL_ACCESS_TOKEN ?? '';
// supabase-js はベースURL (https://xxxx.supabase.co) を期待するため、
// 末尾に "/rest/v1" が付いていても剥がして渡す
const SUPABASE_URL = (process.env.SUPABASE_URL ?? '').replace(/\/rest\/v1\/?$/, '');
const SUPABASE_KEY = process.env.SUPABASE_KEY ?? '';
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY ?? '';

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);
const anthropic = new Anthropic({ apiKey: ANTHROPIC_API_KEY });

function readRawBody(req: VercelRequest): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function verifyLineSignature(body: Buffer, signature: string | undefined): boolean {
  if (!signature) return false;
  const hash = crypto.createHmac('sha256', LINE_CHANNEL_SECRET).update(body).digest('base64');
  const a = Buffer.from(hash);
  const b = Buffer.from(signature);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

async function fetchLineContent(messageId: string) {
  const res = await fetch(`https://api-data.line.me/v2/bot/message/${messageId}/content`, {
    headers: { Authorization: `Bearer ${LINE_CHANNEL_ACCESS_TOKEN}` },
  });
  if (!res.ok) throw new Error(`Failed to fetch content: ${res.status}`);
  const arrayBuffer = await res.arrayBuffer();
  const contentType = res.headers.get('content-type') || 'application/octet-stream';
  return { buffer: Buffer.from(arrayBuffer), contentType };
}

async function replyLineMessage(replyToken: string, text: string) {
  await fetch('https://api.line.me/v2/bot/message/reply', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${LINE_CHANNEL_ACCESS_TOKEN}`,
    },
    body: JSON.stringify({ replyToken, messages: [{ type: 'text', text }] }),
  });
}

// レシート/領収書/請求書/通帳 抽出用プロンプト（日本語・税務用途）
// 1入力（画像/PDF）に複数枚・複数ページ含まれることがあるため、配列で全件返させる
const EXTRACTION_PROMPT = `あなたは日本語のレシート・領収書・請求書・銀行通帳（預金通帳）を読み取る専門家です。
1つの入力（画像またはPDF）に複数枚・複数ページが含まれることがあります（ノート台紙に複数枚貼付、PDFの複数ページ、通帳の見開きなど）。
出力はJSONオブジェクトのみ（前後の説明文やコードフェンスは不要）。読み取れない項目は推測せず null にしてください。
チェックボックスは実際に印（チェック）が付いているもののみ採用し、印刷された選択肢を勝手に選ばないでください。

まず書類の種類を判定してください: レシート/領収書=receipt、請求書=invoice、銀行通帳=bankbook、それ以外=other。

document_type が receipt / invoice の場合のスキーマ（含まれるレシート/領収書/請求書を1件ずつ全件）:
{
  "document_type": "receipt | invoice",
  "receipts": [
    {
      "date": "YYYY-MM-DD 形式の発行日（和暦は西暦に変換。インボイス登録番号があるなら2023年10月以降のはず）。不明なら null",
      "vendor": "店名・会社名（発行元）。不明なら null",
      "total_incl_tax": "税込合計金額（数値のみ）。不明なら null",
      "tax_amount": "消費税額（数値のみ）。不明なら null",
      "tax_rate": "\\"10%\\" / \\"8%\\" / \\"mixed\\" / null のいずれか",
      "registration_number": "インボイス登録番号（T + 13桁）。無ければ null",
      "receipt_no": "レシート番号・取引番号・請求書番号。無ければ null",
      "note": "但し書き（例: 御飲食代として）。無ければ null",
      "confidence": "その1件の抽出の自信度を 0〜1 の数値で"
    }
  ]
}

document_type が bankbook の場合のスキーマ（取引明細を上から順に1行ずつ全件。合計や見出し行は含めない）:
{
  "document_type": "bankbook",
  "transactions": [
    {
      "date": "YYYY-MM-DD 形式の取引日（和暦・2桁年は西暦へ変換）。不明なら null",
      "description": "摘要・お取扱内容（振込/カード/ATM/給与 等）。不明なら null",
      "withdrawal": "お支払金額（出金、数値のみ）。無ければ null",
      "deposit": "お預り金額（入金、数値のみ）。無ければ null",
      "balance": "差引残高（数値のみ）。不明なら null",
      "confidence": "その行の抽出の自信度を 0〜1 の数値で"
    }
  ]
}

該当する明細／レシートが1件も無ければ、その配列（receipts または transactions）は空配列にしてください。`;

function toNum(v: unknown): number | null {
  if (v === null || v === undefined) return null;
  if (typeof v === 'number') return Number.isNaN(v) ? null : v;
  const n = Number(String(v).replace(/[^0-9.-]/g, ''));
  return Number.isNaN(n) ? null : n;
}

function stripJson(text: string): string {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fenced) return fenced[1].trim();
  const s = text.indexOf('{');
  const e = text.lastIndexOf('}');
  return s >= 0 && e > s ? text.slice(s, e + 1) : text.trim();
}

// インボイス登録番号(T+法人番号13桁)のチェックディジット検証
// 戻り値: true=妥当 / false=不正(誤読の可能性) / null=未取得で判定不能
function validateRegistrationNumber(reg: unknown): boolean | null {
  if (typeof reg !== 'string') return null;
  const m = reg.match(/^T(\d{13})$/);
  if (!m) return false;
  const digits = m[1];
  const check = Number(digits[0]); // 先頭がチェックディジット
  const base = digits.slice(1); // 残り12桁
  let sum = 0;
  for (let i = 0; i < 12; i++) {
    const p = Number(base[11 - i]); // 下n桁目(n=i+1)
    const q = i % 2 === 0 ? 1 : 2; // nが奇数=1 / 偶数=2
    sum += p * q;
  }
  return check === 9 - (sum % 9);
}

// 抽出結果の検算。怪しい点があれば notes に積む（弾かず「要確認」フラグ用）
function validateExtraction(
  ex: any,
  total: number | null,
  tax: number | null,
  issued: string | null,
): { needsReview: boolean; notes: string[] } {
  const notes: string[] = [];

  const regValid = validateRegistrationNumber(ex?.registration_number);
  if (regValid === false) notes.push('登録番号の形式または検査数字が不正（誤読の可能性）');
  if (regValid === true && issued && issued < '2023-10-01') {
    notes.push(`日付 ${issued} が登録番号の存在(2023年10月以降)と矛盾（年の誤読の可能性）`);
  }

  const rateMap: Record<string, number> = { '10%': 0.1, '8%': 0.08 };
  const r = ex?.tax_rate ? rateMap[ex.tax_rate] : undefined;
  if (total != null && tax != null && r != null) {
    const expected = Math.round(total - total / (1 + r));
    if (Math.abs(tax - expected) > 2) {
      notes.push(`消費税額が税率${ex.tax_rate}と不整合（税込${total}なら約${expected}円のはず）`);
    }
  }

  const conf = toNum(ex?.confidence);
  if (conf != null && conf < 0.7) notes.push(`信頼度が低い(${conf})`);

  return { needsReview: notes.length > 0, notes };
}

type BankRow = {
  line_no: number;
  withdrawal: number | null;
  deposit: number | null;
  balance: number | null;
  confidence: number | null;
};

// 通帳明細の残高検算。「前残高 + 入金 - 出金 = 当残高」が成り立たない行を誤読候補として拾う。
// 弾かず needs_review フラグ用。残高が読めない行はスキップ（判定不能）。
function validateBankTransactions(rows: BankRow[]): {
  needsReview: boolean;
  notes: string[];
  badLines: number[];
} {
  const notes: string[] = [];
  const badLines: number[] = [];

  for (let i = 1; i < rows.length; i++) {
    const prev = rows[i - 1];
    const cur = rows[i];
    if (prev.balance == null || cur.balance == null) continue; // 残高未取得は判定不能
    const delta = cur.balance - prev.balance; // 残高の増減
    const txn = (cur.deposit ?? 0) - (cur.withdrawal ?? 0); // 取引額（入金+ / 出金-）
    if (Math.abs(delta - txn) > 1) {
      badLines.push(cur.line_no);
    }
  }
  if (badLines.length) {
    notes.push(`残高が不整合の行: ${badLines.join(', ')}行目（金額または残高の誤読の可能性）`);
  }

  const low = rows.filter((r) => r.confidence != null && (r.confidence as number) < 0.7).length;
  if (low > 0) notes.push(`信頼度が低い行が${low}件`);

  return { needsReview: notes.length > 0, notes, badLines };
}

// 画像/PDF を Claude Opus 4.8 に渡して構造化データ（複数件）を抽出
async function extractDocument(buffer: Buffer, contentType: string): Promise<any> {
  const today = new Date().toISOString().slice(0, 10);
  const prompt = `${EXTRACTION_PROMPT}

今日は ${today} です。日付の2桁年（例:「26」）は西暦の下2桁とみなし、今日に最も近い年として解釈してください（例: 今日が2026年なら「26-05-18」は 2026-05-18）。和暦（令和/平成）表記は西暦に変換してください。`;

  const isPdf = contentType.includes('pdf');
  const allowed = ['image/jpeg', 'image/png', 'image/gif', 'image/webp'];
  const block = isPdf
    ? {
        type: 'document',
        source: { type: 'base64', media_type: 'application/pdf', data: buffer.toString('base64') },
      }
    : {
        type: 'image',
        source: {
          type: 'base64',
          media_type: (allowed.includes(contentType) ? contentType : 'image/jpeg') as any,
          data: buffer.toString('base64'),
        },
      };

  // 多件数でも途中で切れないよう出力上限を確保し、ストリーミングでタイムアウトを回避
  const stream = anthropic.messages.stream({
    model: 'claude-opus-4-8',
    max_tokens: 16000,
    messages: [{ role: 'user', content: [block as any, { type: 'text', text: prompt }] }],
  });
  const final: any = await stream.finalMessage();
  const text = (final.content ?? [])
    .filter((b: any) => b.type === 'text')
    .map((b: any) => b.text)
    .join('');
  return JSON.parse(stripJson(text));
}

type SaveCtx = {
  messageId: string;
  path: string;
  contentType: string;
  imageHash: string | null; // 重複弾き用ハッシュ。代表1件のみ付与、他は null
  docType?: string | null; // receipt / invoice / bankbook / other
};

// 抽出1件分を保存し、返信用サマリ行を返す
async function saveReceipt(ex: any, ctx: SaveCtx): Promise<string> {
  const { data: receipt } = await supabase
    .from('receipts')
    .insert({ original_filename: ctx.messageId, source: 'LINE', document_type: ctx.docType ?? null })
    .select()
    .single();

  await supabase.from('receipt_images').insert({
    receipt_id: receipt?.id ?? null,
    storage_path: ctx.path,
    content_type: ctx.contentType,
    image_sha256: ctx.imageHash,
  });

  const total = toNum(ex?.total_incl_tax);
  const tax = toNum(ex?.tax_amount);
  const net = total != null && tax != null ? total - tax : null;
  const issued =
    typeof ex?.date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(ex.date) ? ex.date : null;
  const conf = toNum(ex?.confidence);

  await supabase
    .from('receipts')
    .update({
      amount: net,
      total_amount: total,
      tax_amount: tax,
      issued_date: issued,
      description: ex?.note ?? null,
    })
    .eq('id', receipt?.id);

  const fieldRows = (
    [
      ['vendor', ex?.vendor],
      ['registration_number', ex?.registration_number],
      ['tax_rate', ex?.tax_rate],
      ['receipt_no', ex?.receipt_no],
      ['note', ex?.note],
      ['date', ex?.date],
      ['total_incl_tax', total],
      ['tax_amount', tax],
    ] as [string, unknown][]
  )
    .filter(([, v]) => v !== null && v !== undefined && v !== '')
    .map(([field_name, value]) => ({
      receipt_id: receipt?.id ?? null,
      field_name,
      field_value: String(value),
      confidence: conf,
      source: 'claude-opus-4-8',
    }));

  const validation = validateExtraction(ex, total, tax, issued);
  fieldRows.push({
    receipt_id: receipt?.id ?? null,
    field_name: 'needs_review',
    field_value: String(validation.needsReview),
    confidence: null,
    source: 'validation',
  });
  if (validation.notes.length) {
    fieldRows.push({
      receipt_id: receipt?.id ?? null,
      field_name: 'validation_notes',
      field_value: validation.notes.join(' / '),
      confidence: null,
      source: 'validation',
    });
  }
  if (fieldRows.length) await supabase.from('extracted_fields').insert(fieldRows);

  const now = new Date().toISOString();
  await supabase.from('processing_jobs').insert({
    receipt_id: receipt?.id ?? null,
    status: 'done',
    queued_at: now,
    started_at: now,
    finished_at: now,
  });

  const yen = total != null ? `¥${total.toLocaleString()}` : '金額不明';
  const warn = validation.needsReview ? ' ⚠️要確認' : '';
  return `${ex?.vendor ?? '店名不明'} / ${issued ?? '日付不明'} / ${yen}${warn}`;
}

// 通帳1冊分（取引明細の配列）を保存し、件数と残高検算の結果を返す
async function saveBankTransactions(
  txns: any[],
  ctx: SaveCtx,
): Promise<{ count: number; validation: ReturnType<typeof validateBankTransactions> }> {
  const { data: receipt } = await supabase
    .from('receipts')
    .insert({ original_filename: ctx.messageId, source: 'LINE', document_type: 'bankbook' })
    .select()
    .single();

  await supabase.from('receipt_images').insert({
    receipt_id: receipt?.id ?? null,
    storage_path: ctx.path,
    content_type: ctx.contentType,
    image_sha256: ctx.imageHash,
  });

  const rows = txns.map((t, i) => ({
    receipt_id: receipt?.id ?? null,
    line_no: i + 1,
    txn_date: typeof t?.date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(t.date) ? t.date : null,
    description: t?.description ?? null,
    withdrawal: toNum(t?.withdrawal),
    deposit: toNum(t?.deposit),
    balance: toNum(t?.balance),
    confidence: toNum(t?.confidence),
    source: 'claude-opus-4-8',
  }));
  if (rows.length) await supabase.from('bank_transactions').insert(rows);

  // 残高検算（誤読候補は弾かず needs_review として記録）
  const validation = validateBankTransactions(rows);
  const fieldRows = [
    {
      receipt_id: receipt?.id ?? null,
      field_name: 'needs_review',
      field_value: String(validation.needsReview),
      confidence: null,
      source: 'validation',
    },
  ];
  if (validation.notes.length) {
    fieldRows.push({
      receipt_id: receipt?.id ?? null,
      field_name: 'validation_notes',
      field_value: validation.notes.join(' / '),
      confidence: null,
      source: 'validation',
    });
  }
  await supabase.from('extracted_fields').insert(fieldRows);

  const now = new Date().toISOString();
  await supabase.from('processing_jobs').insert({
    receipt_id: receipt?.id ?? null,
    status: 'done',
    queued_at: now,
    started_at: now,
    finished_at: now,
  });

  return { count: rows.length, validation };
}

// 抽出失敗・該当なし時：画像は保存しつつハッシュは付けない（=再送で再処理できる）
async function saveUnprocessed(ctx: Omit<SaveCtx, 'imageHash'>, errorText: string) {
  const { data: r } = await supabase
    .from('receipts')
    .insert({ original_filename: ctx.messageId, source: 'LINE' })
    .select()
    .single();
  await supabase.from('receipt_images').insert({
    receipt_id: r?.id ?? null,
    storage_path: ctx.path,
    content_type: ctx.contentType,
  });
  const now = new Date().toISOString();
  await supabase.from('processing_jobs').insert({
    receipt_id: r?.id ?? null,
    status: 'failed',
    error: errorText,
    queued_at: now,
    finished_at: now,
  });
}

// 200を返した後にバックグラウンドで実行される処理
async function processWebhookEvents(bodyText: string) {
  const payload = JSON.parse(bodyText);
  const events = payload.events || [];

  for (const ev of events) {
    try {
      const msgType = ev?.type === 'message' ? ev.message?.type : null;
      if (msgType !== 'image' && msgType !== 'file') continue;

      const messageId = ev.message.id;
      const { buffer, contentType } = await fetchLineContent(messageId);

      const isPdf = contentType.includes('pdf');
      const isImage = contentType.startsWith('image/');
      if (!isPdf && !isImage) {
        if (ev.replyToken) {
          await replyLineMessage(ev.replyToken, '対応していない形式です（画像かPDFを送ってください）。');
        }
        continue;
      }

      // 完全同一ファイルの重複弾き（SHA-256）。内容ベースでは弾かない
      const fileHash = crypto.createHash('sha256').update(buffer).digest('hex');
      const { data: dup } = await supabase
        .from('receipt_images')
        .select('id')
        .eq('image_sha256', fileHash)
        .limit(1);
      if (dup && dup.length > 0) {
        if (ev.replyToken) await replyLineMessage(ev.replyToken, 'この画像は既に受信済みです。');
        continue;
      }

      // Storage に元ファイルを1回保存（キーに ":" "." は使えないため置換）
      const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
      const path = `receipts/${timestamp}_${messageId}${isPdf ? '.pdf' : ''}`;
      const { error: uploadError } = await supabase.storage
        .from('receipts')
        .upload(path, buffer, { contentType });
      if (uploadError) throw uploadError;

      const ctx = { messageId, path, contentType };

      // 抽出（複数件）
      let doc: any;
      try {
        doc = await extractDocument(buffer, contentType);
      } catch (exErr) {
        console.error('Extraction error:', exErr);
        await saveUnprocessed(ctx, String(exErr));
        if (ev.replyToken) {
          await replyLineMessage(
            ev.replyToken,
            'ファイルを受け取り保存しました。（解析でエラーが出たため後ほど再処理します）',
          );
        }
        continue;
      }

      const docType = typeof doc?.document_type === 'string' ? doc.document_type : null;

      // 通帳：取引明細を bank_transactions にまとめて保存
      if (docType === 'bankbook') {
        const txns: any[] = Array.isArray(doc?.transactions)
          ? doc.transactions.filter((t: any) => t && typeof t === 'object')
          : [];
        if (txns.length === 0) {
          await saveUnprocessed(ctx, 'no_transactions_found');
          if (ev.replyToken) {
            await replyLineMessage(ev.replyToken, '通帳から読み取れる取引明細が見つかりませんでした。');
          }
          continue;
        }
        const { count, validation } = await saveBankTransactions(txns, {
          ...ctx,
          imageHash: fileHash,
          docType,
        });
        if (ev.replyToken) {
          const warn = validation.badLines.length
            ? `\n⚠️ ${validation.badLines.join(', ')}行目の残高が合いません（金額の誤読の可能性。要確認）`
            : '';
          await replyLineMessage(ev.replyToken, `通帳を登録しました（明細${count}件）${warn}`);
        }
        continue;
      }

      // レシート/領収書/請求書
      const receipts: any[] = Array.isArray(doc?.receipts)
        ? doc.receipts.filter((r: any) => r && typeof r === 'object')
        : [];

      if (receipts.length === 0) {
        await saveUnprocessed(ctx, 'no_receipts_found');
        if (ev.replyToken) {
          await replyLineMessage(
            ev.replyToken,
            '読み取れるレシート/領収書/請求書が見つかりませんでした。',
          );
        }
        continue;
      }

      // 各件を保存（ハッシュは代表1件のみに付与＝重複弾きは維持しつつ複数件を別レコード化）
      const summaries: string[] = [];
      for (let i = 0; i < receipts.length; i++) {
        const summary = await saveReceipt(receipts[i], {
          ...ctx,
          imageHash: i === 0 ? fileHash : null,
          docType,
        });
        summaries.push(summary);
      }

      if (ev.replyToken) {
        const head =
          receipts.length > 1 ? `登録しました（${receipts.length}件）\n` : '登録しました。\n';
        await replyLineMessage(ev.replyToken, head + summaries.join('\n'));
      }
    } catch (err) {
      console.error('Event processing error:', err);
    }
  }
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'POST') {
    return res.status(405).send('Method Not Allowed');
  }

  try {
    const rawBody = await readRawBody(req);
    const signature = req.headers['x-line-signature'] as string | undefined;

    if (!verifyLineSignature(rawBody, signature)) {
      return res.status(401).send('Invalid signature');
    }

    // 200を即返し、保存処理は裏で最後までやりきる
    waitUntil(processWebhookEvents(rawBody.toString('utf8')));
    return res.status(200).send('OK');
  } catch (err) {
    console.error('Webhook handler error', err);
    return res.status(500).send('Internal Server Error');
  }
}
