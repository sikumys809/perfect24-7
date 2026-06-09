import type { VercelRequest, VercelResponse } from '@vercel/node';
import crypto from 'node:crypto';
import { waitUntil } from '@vercel/functions';
import { createClient } from '@supabase/supabase-js';
import Anthropic from '@anthropic-ai/sdk';

// LINE署名を生データで検証するため、Vercelの自動body解析を無効化
export const config = { api: { bodyParser: false } };

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

// レシート抽出用プロンプト（日本語・税務用途）
const EXTRACTION_PROMPT = `あなたは日本語のレシート・領収書を読み取る専門家です。
画像から以下の項目を抽出し、JSONオブジェクトのみを出力してください（前後の説明文やコードフェンスは不要）。
読み取れない項目は推測せず null にしてください。
チェックボックスは実際に印（チェック）が付いているもののみ採用し、印刷された選択肢を勝手に選ばないでください。

スキーマ:
{
  "date": "YYYY-MM-DD 形式の発行日（和暦は西暦に変換。インボイス登録番号があるなら2023年10月以降のはず）。不明なら null",
  "vendor": "店名・会社名。不明なら null",
  "total_incl_tax": "税込合計金額（数値のみ）。不明なら null",
  "tax_amount": "消費税額（数値のみ）。不明なら null",
  "tax_rate": "\\"10%\\" / \\"8%\\" / \\"mixed\\" / null のいずれか",
  "registration_number": "インボイス登録番号（T + 13桁）。無ければ null",
  "receipt_no": "レシート番号・取引番号。無ければ null",
  "note": "但し書き（例: 御飲食代として）。無ければ null",
  "confidence": "抽出全体の自信度を 0〜1 の数値で"
}`;

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

// 画像をClaude Opus 4.8に渡して構造化データを抽出
async function extractReceipt(buffer: Buffer, contentType: string): Promise<any> {
  const allowed = ['image/jpeg', 'image/png', 'image/gif', 'image/webp'];
  const mediaType = allowed.includes(contentType) ? contentType : 'image/jpeg';
  const res: any = await anthropic.messages.create({
    model: 'claude-opus-4-8',
    max_tokens: 2000,
    messages: [
      {
        role: 'user',
        content: [
          {
            type: 'image',
            source: { type: 'base64', media_type: mediaType as any, data: buffer.toString('base64') },
          },
          { type: 'text', text: EXTRACTION_PROMPT },
        ],
      },
    ],
  });
  const text = (res.content ?? [])
    .filter((b: any) => b.type === 'text')
    .map((b: any) => b.text)
    .join('');
  return JSON.parse(stripJson(text));
}

// 200を返した後にバックグラウンドで実行される処理
async function processWebhookEvents(bodyText: string) {
  const payload = JSON.parse(bodyText);
  const events = payload.events || [];

  for (const ev of events) {
    try {
      if (ev.type === 'message' && ev.message?.type === 'image') {
        const messageId = ev.message.id;
        const { buffer, contentType } = await fetchLineContent(messageId);
        // Supabase Storage のキーは ":" "." を許可しないため安全な形に置換
        const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
        const path = `receipts/${timestamp}_${messageId}`;

        const { error: uploadError } = await supabase.storage
          .from('receipts')
          .upload(path, buffer, { contentType });
        if (uploadError) throw uploadError;

        const { data: receipt, error: receiptError } = await supabase
          .from('receipts')
          .insert({ original_filename: messageId, source: 'LINE' })
          .select()
          .single();
        if (receiptError) throw receiptError;

        const { error: imageError } = await supabase.from('receipt_images').insert({
          receipt_id: receipt?.id ?? null,
          storage_path: path,
          content_type: contentType,
        });
        if (imageError) throw imageError;

        const { data: job } = await supabase
          .from('processing_jobs')
          .insert({
            receipt_id: receipt?.id ?? null,
            status: 'processing',
            queued_at: new Date().toISOString(),
            started_at: new Date().toISOString(),
          })
          .select()
          .single();

        // Claude Opus 4.8 で抽出 → 結果を保存
        try {
          const ex = await extractReceipt(buffer, contentType);
          const total = toNum(ex.total_incl_tax);
          const tax = toNum(ex.tax_amount);
          const net = total != null && tax != null ? total - tax : null;
          const issued =
            typeof ex.date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(ex.date) ? ex.date : null;
          const conf = toNum(ex.confidence);

          await supabase
            .from('receipts')
            .update({
              amount: net,
              total_amount: total,
              tax_amount: tax,
              issued_date: issued,
              description: ex.note ?? null,
            })
            .eq('id', receipt?.id);

          const fieldRows = (
            [
              ['vendor', ex.vendor],
              ['registration_number', ex.registration_number],
              ['tax_rate', ex.tax_rate],
              ['receipt_no', ex.receipt_no],
              ['note', ex.note],
              ['date', ex.date],
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
          if (fieldRows.length) await supabase.from('extracted_fields').insert(fieldRows);

          await supabase
            .from('processing_jobs')
            .update({ status: 'done', finished_at: new Date().toISOString() })
            .eq('id', job?.id);

          if (ev.replyToken) {
            const yen = total != null ? `¥${total.toLocaleString()}` : '金額不明';
            await replyLineMessage(
              ev.replyToken,
              `登録しました。\n${ex.vendor ?? '店名不明'} / ${issued ?? '日付不明'} / ${yen}`,
            );
          }
        } catch (exErr) {
          console.error('Extraction error:', exErr);
          await supabase
            .from('processing_jobs')
            .update({ status: 'failed', error: String(exErr), finished_at: new Date().toISOString() })
            .eq('id', job?.id);
          if (ev.replyToken) {
            await replyLineMessage(
              ev.replyToken,
              '画像を受け取り保存しました。（解析でエラーが出たため後ほど再処理します）',
            );
          }
        }
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
