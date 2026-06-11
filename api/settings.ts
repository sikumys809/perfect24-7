import type { VercelRequest, VercelResponse } from '@vercel/node';
import { createClient } from '@supabase/supabase-js';

// 顧問先の設定変更（現状は経理方式 税込/税抜）。
//  POST /api/settings  body: client, tax_accounting, view, month, key
// 更新後はレポート画面へ 303 リダイレクトする。
export const config = { maxDuration: 30 };

const SUPABASE_URL = (process.env.SUPABASE_URL ?? '').replace(/\/rest\/v1\/?$/, '');
const SUPABASE_KEY = process.env.SUPABASE_KEY ?? '';
const DASHBOARD_KEY = process.env.DASHBOARD_KEY ?? '';
const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'POST') return res.status(405).send('Method Not Allowed');

  const b = req.body ?? {};
  if (DASHBOARD_KEY.length > 0 && b.key !== DASHBOARD_KEY) {
    return res.status(401).send('アクセスキーが必要です（?key=...）。');
  }

  const clientId = String(b.client ?? '');
  const mode = b.tax_accounting === 'exclusive' ? 'exclusive' : 'inclusive';
  if (clientId) {
    await supabase.from('clients').update({ tax_accounting: mode }).eq('id', clientId);
  }

  // レポート画面へ戻る（フィルタ維持）
  const p = new URLSearchParams();
  p.set('view', b.view === 'ledger' ? 'ledger' : 'trial');
  if (b.month) p.set('month', String(b.month));
  if (clientId) p.set('client', clientId);
  if (b.key) p.set('key', String(b.key));

  res.setHeader('Cache-Control', 'no-store');
  return res.redirect(303, '/api/reports?' + p.toString());
}
