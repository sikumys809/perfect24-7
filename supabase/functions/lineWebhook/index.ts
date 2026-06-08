const LINE_CHANNEL_SECRET = Deno.env.get('LINE_CHANNEL_SECRET') ?? '';
const LINE_CHANNEL_ACCESS_TOKEN = Deno.env.get('LINE_CHANNEL_ACCESS_TOKEN') ?? '';
const SUPABASE_URL = Deno.env.get('SUPABASE_URL') ?? '';
const SUPABASE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? Deno.env.get('SUPABASE_KEY') ?? '';
const SUPABASE_REST_URL = SUPABASE_URL.replace(/\/rest\/v1\/?$/, '');
const STORAGE_URL = `${SUPABASE_REST_URL}/storage/v1`;

function encodeStoragePath(path: string) {
  return path.split('/').map(encodeURIComponent).join('/');
}

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

async function uploadToStorage(bucket: string, path: string, data: ArrayBuffer, contentType: string) {
  const url = `${STORAGE_URL}/object/${bucket}/${encodeStoragePath(path)}`;
  const res = await fetch(url, {
    method: 'PUT',
    body: data,
    headers: {
      Authorization: `Bearer ${SUPABASE_KEY}`,
      apikey: SUPABASE_KEY,
      'Content-Type': contentType,
    },
  });
  if (!res.ok) {
    throw new Error(`Storage upload failed: ${res.status}`);
  }
}

async function insertRow(table: string, row: unknown) {
  const url = `${SUPABASE_URL}${table}`;
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${SUPABASE_KEY}`,
      apikey: SUPABASE_KEY,
      'Content-Type': 'application/json',
      Prefer: 'return=representation',
    },
    body: JSON.stringify(row),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Insert failed (${table}): ${res.status} ${text}`);
  }
  return res.json();
}

async function replyLineMessage(replyToken: string, text: string) {
  const url = 'https://api.line.me/v2/bot/message/reply';
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${LINE_CHANNEL_ACCESS_TOKEN}`,
    },
    body: JSON.stringify({
      replyToken,
      messages: [{ type: 'text', text }],
    }),
  });
  if (!res.ok) {
    throw new Error(`Failed to reply to LINE message: ${res.status}`);
  }
}

export default async function handler(req: Request): Promise<Response> {
  if (req.method !== 'POST') {
    return new Response('Method Not Allowed', { status: 405 });
  }
  return new Response('OK', { status: 200 });
}
