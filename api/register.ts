import type { VercelRequest, VercelResponse } from '@vercel/node';
import { createClient } from '@supabase/supabase-js';

// LIFF 登録フォーム。友達追加後に LINE 内で開き、基本情報を入力 → 顧問先を作成・LINE紐付け →
// 登録（ログイン）コードを LINE にプッシュ。なりすまし防止に LIFF の ID トークンをサーバ検証する。
//  GET  /api/register  … LIFFページ（フォーム）
//  POST /api/register  … {idToken, 基本情報} を受けて登録
export const config = { maxDuration: 20 };

const SUPABASE_URL = (process.env.SUPABASE_URL ?? '').replace(/\/rest\/v1\/?$/, '');
const SUPABASE_KEY = process.env.SUPABASE_KEY ?? '';
const ENV_LINE_TOKEN = process.env.LINE_CHANNEL_ACCESS_TOKEN ?? '';
const LIFF_ID = process.env.LIFF_ID || '2010381453-fQ4q2Hlc';
const LOGIN_CHANNEL_ID = LIFF_ID.split('-')[0]; // ID トークン検証の client_id
const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

function esc(s: unknown): string {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] as string);
}
function fm(v: unknown): number | null {
  const n = Number(String(v ?? '').replace(/[^0-9.-]/g, ''));
  return !Number.isNaN(n) && n >= 1 && n <= 12 ? Math.round(n) : null;
}
async function pushLine(officeId: string | null, toUserId: string, text: string): Promise<void> {
  let token = ENV_LINE_TOKEN;
  if (officeId) {
    const { data } = await supabase.from('offices').select('line_channel_access_token').eq('id', officeId).limit(1);
    if (data && data.length && data[0].line_channel_access_token) token = data[0].line_channel_access_token;
  }
  if (!token) return;
  try {
    await fetch('https://api.line.me/v2/bot/message/push', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({ to: toUserId, messages: [{ type: 'text', text }] }),
    });
  } catch {
    /* プッシュ失敗は致命的でない（画面側にもコードを表示する） */
  }
}

function page(): string {
  return `<!doctype html><html lang="ja"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>基本情報の登録｜パーフェクト24/7</title>
<style>
  body{margin:0;background:#f1f5f9;color:#0f172a;font-family:-apple-system,BlinkMacSystemFont,"Hiragino Kaku Gothic ProN","Noto Sans JP",sans-serif;}
  .wrap{max-width:480px;margin:0 auto;padding:18px;}
  .card{background:#fff;border:1px solid #e2e8f0;border-radius:16px;padding:20px;}
  h1{font-size:1.2rem;margin:0 0 4px;} .sub{color:#64748b;font-size:.85rem;margin:0 0 16px;line-height:1.6;}
  label{display:block;font-size:.82rem;font-weight:700;color:#334155;margin:12px 0 4px;}
  input,select{width:100%;font-size:1rem;padding:11px;border:1px solid #cbd5e1;border-radius:10px;box-sizing:border-box;}
  .row2{display:flex;gap:10px;} .row2>div{flex:1;}
  button{width:100%;margin-top:18px;font-size:1.05rem;font-weight:700;padding:13px;border:none;border-radius:11px;background:#2563eb;color:#fff;}
  .code{font-size:1.8rem;font-weight:800;letter-spacing:.1em;text-align:center;background:#eff6ff;color:#1e3a8a;padding:14px;border-radius:12px;margin:14px 0;}
  #loading,#done{text-align:center;color:#64748b;padding:24px;}
  #done h1{color:#0f172a;}
</style>
<script src="https://static.line-scdn.net/liff/edge/2/sdk.js"></script>
</head><body>
<div class="wrap"><div class="card">
  <div id="loading">読み込み中…</div>
  <form id="f" style="display:none">
    <h1>基本情報の登録</h1>
    <p class="sub">最初に会社の基本情報をご登録ください。決算月などの把握に使います。登録後はこのトークに領収書などを撮って送るだけでOKです。</p>
    <label>会社名 <span style="color:#dc2626">*</span></label>
    <input name="official_name" required placeholder="株式会社○○">
    <label>屋号</label>
    <input name="trade_name" placeholder="任意">
    <label>担当者名</label>
    <input name="contact_name">
    <label>メールアドレス</label>
    <input name="email" type="email" inputmode="email" autocapitalize="off">
    <label>携帯電話番号</label>
    <input name="phone" type="tel" inputmode="tel">
    <label>営業期間（決算月の把握用）</label>
    <div class="row2">
      <div><span style="font-size:.75rem;color:#64748b">期首</span><select name="fiscal_start_month"></select></div>
      <div><span style="font-size:.75rem;color:#64748b">期末（決算月）</span><select name="fiscal_end_month"></select></div>
    </div>
    <button type="submit">この内容で登録する</button>
  </form>
  <div id="done" style="display:none"></div>
</div></div>
<script>
  var LIFF_ID='${esc(LIFF_ID)}';
  // 月セレクト
  ['fiscal_start_month','fiscal_end_month'].forEach(function(n){
    var s=document.querySelector('[name='+n+']'); s.innerHTML='<option value="">—</option>';
    for(var m=1;m<=12;m++){var o=document.createElement('option');o.value=m;o.textContent=m+'月';s.appendChild(o);}
  });
  function showForm(){document.getElementById('loading').style.display='none';document.getElementById('f').style.display='block';}
  liff.init({liffId:LIFF_ID}).then(function(){
    if(!liff.isLoggedIn()){liff.login();return;}
    showForm();
  }).catch(function(e){document.getElementById('loading').textContent='初期化に失敗しました（'+(e&&e.message||e)+'）';});
  document.getElementById('f').addEventListener('submit',function(ev){
    ev.preventDefault();
    var btn=this.querySelector('button');btn.disabled=true;btn.textContent='登録中…';
    var data={accessToken:liff.getAccessToken()};
    var f=this;
    ['official_name','trade_name','contact_name','email','phone','fiscal_start_month','fiscal_end_month'].forEach(function(n){data[n]=(f.elements[n]||{}).value||'';});
    fetch('/api/register',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(data)})
      .then(function(r){return r.json();})
      .then(function(j){
        if(j.ok){
          document.getElementById('f').style.display='none';
          var d=document.getElementById('done');d.style.display='block';
          d.innerHTML='<h1>登録が完了しました 🎉</h1><p class="sub">あなたのログインコードです（LINEにも送りました）</p><div class="code">'+j.code+'</div><p class="sub">確認ページにログインするときに使います。<br>領収書・請求書はこのトークに撮って送るだけでOKです。</p><button onclick="try{liff.closeWindow()}catch(e){}">閉じる</button>';
        }else{btn.disabled=false;btn.textContent='この内容で登録する';alert(j.message||'登録に失敗しました');}
      }).catch(function(){btn.disabled=false;btn.textContent='この内容で登録する';alert('通信エラーが発生しました');});
  });
</script>
</body></html>`;
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method === 'GET') {
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.setHeader('Cache-Control', 'no-store');
    return res.status(200).send(page());
  }
  if (req.method !== 'POST') return res.status(405).json({ ok: false, message: 'POST only' });

  const b: any = req.body ?? {};
  const accessToken = b.accessToken;
  if (!accessToken || typeof accessToken !== 'string') return res.status(400).json({ ok: false, message: '認証情報がありません。LINE内で開き直してお試しください。' });

  // LIFF のアクセストークンをサーバ検証（profileスコープのみでOK）→ 本物の userId を取得。
  //  1) トークンが自分のチャネル(LOGIN_CHANNEL_ID)宛か検証（他アプリのトークン流用を防ぐ）
  //  2) /v2/profile で userId を取得
  let userId: string | null = null;
  try {
    const vr = await fetch('https://api.line.me/oauth2/v2.1/verify?access_token=' + encodeURIComponent(accessToken));
    const v: any = await vr.json();
    if (vr.ok && v && String(v.client_id) === LOGIN_CHANNEL_ID) {
      const pr = await fetch('https://api.line.me/v2/profile', { headers: { Authorization: `Bearer ${accessToken}` } });
      const p: any = await pr.json();
      if (pr.ok && p && typeof p.userId === 'string') userId = p.userId;
    }
  } catch {
    /* fallthrough */
  }
  if (!userId) return res.status(401).json({ ok: false, message: 'LINE認証に失敗しました。LINE内で開き直してお試しください。' });

  // 事務所（当面は単一。複数化時は LIFF/チャネルと offices の対応付けが必要）
  const { data: offices } = await supabase.from('offices').select('id').order('office_code', { ascending: true }).limit(1);
  const officeId = offices && offices.length ? offices[0].id : null;

  const basic = {
    official_name: String(b.official_name ?? '').trim() || '（未設定）',
    trade_name: String(b.trade_name ?? '').trim() || null,
    contact_name: String(b.contact_name ?? '').trim() || null,
    email: String(b.email ?? '').trim() || null,
    phone: String(b.phone ?? '').trim() || null,
    fiscal_start_month: fm(b.fiscal_start_month),
    fiscal_end_month: fm(b.fiscal_end_month),
  };

  let code = '';
  let clientCode = '';
  try {
    const { data: existing } = await supabase
      .from('clients')
      .select('id, client_code, registration_code')
      .eq('linked_line_user_id', userId)
      .limit(1);
    if (existing && existing.length) {
      await supabase.from('clients').update(basic).eq('id', existing[0].id);
      code = existing[0].registration_code;
      clientCode = existing[0].client_code;
    } else {
      const { data: created, error } = await supabase
        .from('clients')
        .insert({ ...basic, linked_line_user_id: userId, office_id: officeId, linked_at: new Date().toISOString() })
        .select('client_code, registration_code')
        .single();
      if (error || !created) throw error || new Error('insert failed');
      code = created.registration_code;
      clientCode = created.client_code;
    }
  } catch (e) {
    console.error('register error', e);
    return res.status(500).json({ ok: false, message: '登録の保存に失敗しました。時間をおいて再度お試しください。' });
  }

  await pushLine(
    officeId,
    userId,
    `ご登録ありがとうございます。\n\n【ログインコード】${code}\n\n確認ページにログインする時にこのコードを入力すると、LINEにワンタイムパスワードが届きます。\n\n領収書・請求書・通帳などは、このトークに撮って送るだけでOKです。`,
  );

  return res.status(200).json({ ok: true, code, client_code: clientCode });
}
