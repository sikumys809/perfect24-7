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
  res.setHeader('Cache-Control', 'no-store');

  // 事務所側からの顧問先 基本情報の保存
  if (b.action === 'saveinfo' && clientId) {
    const fm = (v: unknown) => {
      const n = Number(String(v ?? '').replace(/[^0-9.-]/g, ''));
      return !Number.isNaN(n) && n >= 1 && n <= 12 ? Math.round(n) : null;
    };
    await supabase
      .from('clients')
      .update({
        official_name: String(b.official_name ?? '').trim() || '（未設定）',
        trade_name: String(b.trade_name ?? '').trim() || null,
        contact_name: String(b.contact_name ?? '').trim() || null,
        email: String(b.email ?? '').trim() || null,
        phone: String(b.phone ?? '').trim() || null,
        fiscal_start_month: fm(b.fiscal_start_month),
        fiscal_end_month: fm(b.fiscal_end_month),
      })
      .eq('id', clientId);
    return res.redirect(303, '/api/dashboard?view=clients' + (b.key ? `&key=${encodeURIComponent(String(b.key))}` : ''));
  }

  // 経理方式（税込/税抜）の保存
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
  return res.redirect(303, '/api/reports?' + p.toString());
}
