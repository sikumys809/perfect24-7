import type { VercelRequest, VercelResponse } from '@vercel/node';
import crypto from 'node:crypto';
import { createClient } from '@supabase/supabase-js';

// 顧問先の設定変更（事務所側）。経理方式 税込/税抜・基本情報。
//  POST /api/settings  body: client, tax_accounting, view, month, key
// 更新後はレポート画面へ 303 リダイレクトする。
export const config = { maxDuration: 30 };

const SUPABASE_URL = (process.env.SUPABASE_URL ?? '').replace(/\/rest\/v1\/?$/, '');
const SUPABASE_KEY = process.env.SUPABASE_KEY ?? '';
const DASHBOARD_KEY = process.env.DASHBOARD_KEY ?? '';
const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

const OFFICE_AUTH = process.env.OFFICE_AUTH === 'on';
function officeSession(req: VercelRequest): string | null {
  const raw = req.headers.cookie;
  if (!raw) return null;
  let val: string | undefined;
  for (const part of raw.split(';')) {
    const i = part.indexOf('=');
    if (i > 0 && part.slice(0, i).trim() === 'p247_office') val = decodeURIComponent(part.slice(i + 1).trim());
  }
  if (!val) return null;
  const j = val.lastIndexOf('.');
  if (j < 0) return null;
  const id = val.slice(0, j);
  const exp = crypto.createHmac('sha256', SUPABASE_KEY).update(id).digest('base64url');
  const a = Buffer.from(val.slice(j + 1));
  const b = Buffer.from(exp);
  return a.length === b.length && crypto.timingSafeEqual(a, b) ? id : null;
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'POST') return res.status(405).send('Method Not Allowed');

  const officeId = officeSession(req);
  if (OFFICE_AUTH && !officeId) return res.status(401).send('ログインが必要です。');

  const b = req.body ?? {};
  if (!OFFICE_AUTH && DASHBOARD_KEY.length > 0 && b.key !== DASHBOARD_KEY) {
    return res.status(401).send('アクセスキーが必要です（?key=...）。');
  }

  const clientId = String(b.client ?? '');
  res.setHeader('Cache-Control', 'no-store');

  // 所有チェック: 他事務所の顧問先は更新不可
  if (officeId && clientId) {
    const { data: own } = await supabase.from('clients').select('office_id').eq('id', clientId).single();
    if (!own || own.office_id !== officeId) return res.status(403).send('この顧問先を更新する権限がありません。');
  }

  // 事務所側からの顧問先 基本情報の保存
  if (b.action === 'saveinfo' && clientId) {
    const fm = (v: unknown) => {
      const n = Number(String(v ?? '').replace(/[^0-9.-]/g, ''));
      return !Number.isNaN(n) && n >= 1 && n <= 12 ? Math.round(n) : null;
    };
    // 事務所側は 会社名・屋号(official_name)/担当者/決算月のみ編集可。
    // メール・携帯は顧問先本人の連絡先なので顧問先側(/api/my?info=1)でのみ編集する。
    await supabase
      .from('clients')
      .update({
        official_name: String(b.official_name ?? '').trim() || '（未設定）',
        contact_name: String(b.contact_name ?? '').trim() || null,
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
