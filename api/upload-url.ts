import type { VercelRequest, VercelResponse } from '@vercel/node';
import crypto from 'node:crypto';
import { createClient } from '@supabase/supabase-js';

// 大きいファイルを Vercel 関数のボディ上限(4.5MB)を回避して上げるための署名付きアップロードURL発行。
// 流れ: ブラウザ → ここで signedUrl+path 取得 → ブラウザが署名URLへ直接PUT → /api/upload に path を渡す。
// path は clientId と紐づけて HMAC 署名(sig)し、他人のファイルを処理させない。
export const config = { maxDuration: 15 };

const SUPABASE_URL = (process.env.SUPABASE_URL ?? '').replace(/\/rest\/v1\/?$/, '');
const SUPABASE_KEY = process.env.SUPABASE_KEY ?? '';
const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);
const COOKIE = 'p247_client';

function verifySession(value: string | undefined): string | null {
  if (!value) return null;
  const i = value.lastIndexOf('.');
  if (i < 0) return null;
  const clientId = value.slice(0, i);
  const sig = value.slice(i + 1);
  const expect = crypto.createHmac('sha256', SUPABASE_KEY).update(clientId).digest('base64url');
  const a = Buffer.from(sig);
  const b = Buffer.from(expect);
  return a.length === b.length && crypto.timingSafeEqual(a, b) ? clientId : null;
}
function parseCookies(req: VercelRequest): Record<string, string> {
  const out: Record<string, string> = {};
  const raw = req.headers.cookie;
  if (!raw) return out;
  for (const part of raw.split(';')) {
    const idx = part.indexOf('=');
    if (idx > 0) out[part.slice(0, idx).trim()] = decodeURIComponent(part.slice(idx + 1).trim());
  }
  return out;
}
// path を clientId に紐づけて署名（/api/upload で検証）
export function signPath(path: string, clientId: string): string {
  return crypto.createHmac('sha256', SUPABASE_KEY).update(`${path}|${clientId}`).digest('base64url');
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'POST') return res.status(405).json({ ok: false, message: 'POST only' });
  const clientId = verifySession(parseCookies(req)[COOKIE]);
  if (!clientId) return res.status(401).json({ ok: false, message: 'ログインが必要です。' });

  const body: any = req.body ?? {};
  const contentType = typeof body.contentType === 'string' ? body.contentType : '';
  const isPdf = contentType.includes('pdf');
  const isImage = contentType.startsWith('image/');
  if (!isPdf && !isImage) return res.status(400).json({ ok: false, message: '画像かPDFのみ対応しています。' });

  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const rand = crypto.randomBytes(6).toString('hex');
  const path = `receipts/${timestamp}_up_${rand}${isPdf ? '.pdf' : ''}`;

  const { data, error } = await supabase.storage.from('receipts').createSignedUploadUrl(path);
  if (error || !data) {
    console.error('createSignedUploadUrl error', error);
    return res.status(500).json({ ok: false, message: 'アップロードURLの発行に失敗しました。' });
  }
  return res.status(200).json({ ok: true, signedUrl: data.signedUrl, path, sig: signPath(path, clientId) });
}
