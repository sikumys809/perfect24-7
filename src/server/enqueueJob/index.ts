// Edge Function サンプル：receipt_id を受け取り processing_jobs にジョブを作成する雛形
// 実動作時は認証と入力検証、エラーハンドリングを強化してください。

import { createClient } from '@supabase/supabase-js';

const SUPABASE_URL = process.env.SUPABASE_URL || '';
const SUPABASE_KEY = process.env.SUPABASE_KEY || '';

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

export async function handler(req: Request): Promise<Response> {
  try {
    if (req.method !== 'POST') return new Response('Method Not Allowed', { status: 405 });

    const body = await req.json();
    const { receipt_id } = body;
    if (!receipt_id) return new Response('receipt_id required', { status: 400 });

    const { data, error } = await supabase.from('processing_jobs').insert([
      { receipt_id, status: 'pending', queued_at: new Date().toISOString() }
    ]).select();

    if (error) {
      console.error('enqueue error', error);
      return new Response('Enqueue failed', { status: 500 });
    }

    return new Response(JSON.stringify({ job: data?.[0] || null }), { status: 200 });
  } catch (err) {
    console.error('enqueue handler error', err);
    return new Response('Internal Server Error', { status: 500 });
  }
}
