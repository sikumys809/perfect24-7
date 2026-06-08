import crypto from 'crypto';
import { createClient } from '@supabase/supabase-js';

const LINE_CHANNEL_SECRET = process.env.LINE_CHANNEL_SECRET || '';
const LINE_CHANNEL_ACCESS_TOKEN = process.env.LINE_CHANNEL_ACCESS_TOKEN || '';
const SUPABASE_URL = process.env.SUPABASE_URL || '';
const SUPABASE_KEY = process.env.SUPABASE_KEY || '';

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

function verifyLineSignature(body: string, signature: string | null) {
  if (!signature) return false;
  const hash = crypto.createHmac('sha256', LINE_CHANNEL_SECRET).update(body).digest('base64');
  return hash === signature;
}

async function fetchLineContent(messageId: string) {
  const url = `https://api-data.line.me/v2/bot/message/${messageId}/content`;
  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${LINE_CHANNEL_ACCESS_TOKEN}` },
  });
  if (!res.ok) throw new Error(`Failed to fetch message content: ${res.status}`);
  const buffer = Buffer.from(await res.arrayBuffer());
  const contentType = res.headers.get('content-type') || 'application/octet-stream';
  return { buffer, contentType };
}

export async function handler(req: Request): Promise<Response> {
  try {
    if (req.method !== 'POST') return new Response('Method Not Allowed', { status: 405 });

    const bodyText = await req.text();
    const signature = req.headers.get('x-line-signature');
    if (!verifyLineSignature(bodyText, signature)) {
      console.warn('Invalid LINE signature');
      return new Response('Invalid signature', { status: 401 });
    }

    const payload = JSON.parse(bodyText);
    const events = payload.events || [];

    for (const ev of events) {
      try {
        // 画像メッセージのみ処理
        if (ev.type === 'message' && ev.message?.type === 'image') {
          const messageId = ev.message.id;

          // 1) 画像をLINEから取得
          const { buffer, contentType } = await fetchLineContent(messageId);

          // 2) Supabase Storage にアップロード（bucket: receipts）
          const filename = `receipts/${new Date().toISOString()}_${messageId}`;
          const { error: uploadError } = await supabase.storage
            .from('receipts')
            .upload(filename, buffer, { contentType });

          if (uploadError) throw uploadError;

          const storagePath = `receipts/${filename}`;

          // 3) receipts レコードを作成（簡易）
          const { data: receiptData, error: receiptError } = await supabase
            .from('receipts')
            .insert([
              { original_filename: messageId, source: 'LINE' }
            ])
            .select()
            .limit(1);

          if (receiptError) throw receiptError;

          const receipt = receiptData && receiptData[0];

          // 4) receipt_images を作成
          await supabase.from('receipt_images').insert([
            { receipt_id: receipt?.id ?? null, storage_path: filename, content_type: contentType }
          ]);

          // 5) processing_jobs を enqueue
          await supabase.from('processing_jobs').insert([
            { receipt_id: receipt?.id ?? null, status: 'pending', queued_at: new Date().toISOString() }
          ]);
        }
      } catch (evErr) {
        console.error('Event processing error', evErr);
      }
    }

    return new Response('OK', { status: 200 });
  } catch (err) {
    console.error('line webhook error', err);
    return new Response('Internal Server Error', { status: 500 });
  }
}
