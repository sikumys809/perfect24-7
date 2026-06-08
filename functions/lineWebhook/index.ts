import { createClient } from '@supabase/supabase-js';

const LINE_CHANNEL_SECRET = Deno.env.get('LINE_CHANNEL_SECRET') ?? '';
const LINE_CHANNEL_ACCESS_TOKEN = Deno.env.get('LINE_CHANNEL_ACCESS_TOKEN') ?? '';
const SUPABASE_URL = Deno.env.get('SUPABASE_URL') ?? '';
const SUPABASE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? Deno.env.get('SUPABASE_KEY') ?? '';

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

async function computeHmacSha256(message: string, secret: string) {
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey(
    'raw',
    encoder.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  );
  const signature = await crypto.subtle.sign('HMAC', key, encoder.encode(message));
  const bytes = new Uint8Array(signature);
  let str = '';
  for (const byte of bytes) {
    str += String.fromCharCode(byte);
  }
  return btoa(str);
}

async function verifyLineSignature(body: string, signature: string | null) {
  if (!signature) return false;
  const hash = await computeHmacSha256(body, LINE_CHANNEL_SECRET);
  return hash === signature;
}

async function fetchLineContent(messageId: string) {
  const url = `https://api-data.line.me/v2/bot/message/${messageId}/content`;
  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${LINE_CHANNEL_ACCESS_TOKEN}` },
  });
  if (!res.ok) {
    throw new Error(`Failed to fetch message content: ${res.status}`);
  }
  const arrayBuffer = await res.arrayBuffer();
  const contentType = res.headers.get('content-type') || 'application/octet-stream';
  return { arrayBuffer, contentType };
}

export async function handler(req: Request): Promise<Response> {
  try {
    if (req.method !== 'POST') {
      return new Response('Method Not Allowed', { status: 405 });
    }

    const bodyText = await req.text();
    const signature = req.headers.get('x-line-signature');
    if (!verifyLineSignature(bodyText, signature)) {
      return new Response('Invalid signature', { status: 401 });
    }

    const payload = JSON.parse(bodyText);
    const events = payload.events || [];

    for (const ev of events) {
      try {
        if (ev.type === 'message' && ev.message?.type === 'image') {
          const messageId = ev.message.id;

          const { arrayBuffer, contentType } = await fetchLineContent(messageId);
          const filename = `receipts/${new Date().toISOString()}_${messageId}`;

          const { error: uploadError } = await supabase.storage
            .from('receipts')
            .upload(filename, new Uint8Array(arrayBuffer), { contentType });
          if (uploadError) throw uploadError;

          const { data: receiptData, error: receiptError } = await supabase
            .from('receipts')
            .insert([{ original_filename: messageId, source: 'LINE' }])
            .select()
            .limit(1);
          if (receiptError) throw receiptError;

          const receipt = receiptData?.[0];
          await supabase.from('receipt_images').insert([
            { receipt_id: receipt?.id ?? null, storage_path: filename, content_type: contentType },
          ]);
          await supabase.from('processing_jobs').insert([
            { receipt_id: receipt?.id ?? null, status: 'pending', queued_at: new Date().toISOString() },
          ]);
        }
      } catch (innerErr) {
        console.error('Event processing error', innerErr);
      }
    }

    return new Response('OK', { status: 200 });
  } catch (err) {
    console.error('line webhook error', err);
    return new Response('Internal Server Error', { status: 500 });
  }
}
