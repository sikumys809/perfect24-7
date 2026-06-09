import type { VercelRequest, VercelResponse } from '@vercel/node';
import crypto from 'node:crypto';
import { waitUntil } from '@vercel/functions';
import { createClient } from '@supabase/supabase-js';

// LINE署名を生データで検証するため、Vercelの自動body解析を無効化
export const config = { api: { bodyParser: false } };

const LINE_CHANNEL_SECRET = process.env.LINE_CHANNEL_SECRET ?? '';
const LINE_CHANNEL_ACCESS_TOKEN = process.env.LINE_CHANNEL_ACCESS_TOKEN ?? '';
const SUPABASE_URL = process.env.SUPABASE_URL ?? '';
const SUPABASE_KEY = process.env.SUPABASE_KEY ?? '';

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

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

// 200を返した後にバックグラウンドで実行される処理
async function processWebhookEvents(bodyText: string) {
  const payload = JSON.parse(bodyText);
  const events = payload.events || [];

  for (const ev of events) {
    try {
      if (ev.type === 'message' && ev.message?.type === 'image') {
        const messageId = ev.message.id;
        const { buffer, contentType } = await fetchLineContent(messageId);
        const path = `receipts/${new Date().toISOString()}_${messageId}`;

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

        const { error: jobError } = await supabase.from('processing_jobs').insert({
          receipt_id: receipt?.id ?? null,
          status: 'pending',
          queued_at: new Date().toISOString(),
        });
        if (jobError) throw jobError;

        if (ev.replyToken) {
          await replyLineMessage(ev.replyToken, '画像を受け取りました。保存が完了しました。');
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
