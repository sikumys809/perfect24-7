import type { VercelRequest, VercelResponse } from '@vercel/node';
import crypto from 'node:crypto';
import { createClient } from '@supabase/supabase-js';

// 顧問先（送る側）向けダッシュボード。
//  GET  /api/my            … セッションがあれば自分の書類一覧、無ければ登録コードのログイン画面
//  POST /api/my (login)    … 登録コードで本人確認 → 署名付き Cookie を発行
//  GET  /api/my?logout=1   … ログアウト
// 役割は事務所側と分離: ここは「送る動機・確認」に特化し、勘定科目や試算表は見せない。
// セキュリティ: ログイン後の全クエリは必ずセッションの client_id で絞る（URL値は信用しない）。
//   Cookie は SUPABASE_KEY（サーバ秘密）で HMAC 署名し偽造不可にする。
export const config = { maxDuration: 30 };

const SUPABASE_URL = (process.env.SUPABASE_URL ?? '').replace(/\/rest\/v1\/?$/, '');
const SUPABASE_KEY = process.env.SUPABASE_KEY ?? '';
const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

const COOKIE = 'p247_client';
const ENV_LINE_TOKEN = process.env.LINE_CHANNEL_ACCESS_TOKEN ?? '';

const DOC_LABEL: Record<string, string> = {
  receipt: '領収書', invoice: '請求書', bankbook: '通帳', credit_card: 'カード明細',
  tax_payment: '納付書', balance_certificate: '残高証明', inventory: '棚卸表',
  loan_schedule: '返済予定表', payslip: '給与明細', wage_ledger: '賃金台帳',
  fixed_asset: '固定資産', ec_payout: 'EC入金', petty_cash: '小口現金', other: 'その他',
};
const DOC_COLOR: Record<string, string> = {
  receipt: '#2563eb', invoice: '#7c3aed', bankbook: '#0d9488', credit_card: '#db2777',
  tax_payment: '#ea580c', balance_certificate: '#0891b2', inventory: '#65a30d',
  loan_schedule: '#9333ea', payslip: '#c026d3', wage_ledger: '#a21caf',
  fixed_asset: '#0369a1', ec_payout: '#16a34a', petty_cash: '#0d9488', other: '#6b7280',
};
const LINE_DOC_TYPES = ['bankbook', 'credit_card', 'inventory', 'loan_schedule', 'payslip', 'wage_ledger', 'petty_cash'];

function esc(s: unknown): string {
  return String(s ?? '').replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] as string,
  );
}
function yen(n: unknown): string {
  if (n === null || n === undefined || n === '') return '';
  const v = Number(n);
  return Number.isNaN(v) ? '' : '¥' + v.toLocaleString();
}
function fmtDate(d: unknown): string {
  return typeof d === 'string' && d ? d.slice(0, 10) : '—';
}

// ───────── セッション（署名付き Cookie） ─────────
function sign(clientId: string): string {
  const sig = crypto.createHmac('sha256', SUPABASE_KEY).update(clientId).digest('base64url');
  return `${clientId}.${sig}`;
}
function verify(value: string | undefined): string | null {
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
// 登録コードの正規化: 全角英数字→半角、空白(全角含む)・ハイフン除去、大文字化。
// 日本語IMEで全角入力されても一致するようにする。
function normCode(s: unknown): string {
  return String(s ?? '')
    .replace(/[！-～]/g, (ch) => String.fromCharCode(ch.charCodeAt(0) - 0xfee0))
    .replace(/[\s　\-­]/g, '')
    .toUpperCase();
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

// ───────── OTP（ワンタイムパス）ログイン ─────────
function genOtp(): string {
  return String(crypto.randomInt(0, 1000000)).padStart(6, '0');
}
// 「コード入力 → OTP入力」間の受け渡し用 短命トークン（client_id + 期限を署名）
function otpToken(clientId: string): string {
  const payload = `${clientId}.${Date.now() + 10 * 60 * 1000}`;
  const sig = crypto.createHmac('sha256', SUPABASE_KEY).update('otp:' + payload).digest('base64url');
  return `${payload}.${sig}`;
}
function readOtpToken(token: unknown): string | null {
  const parts = String(token ?? '').split('.');
  if (parts.length !== 3) return null;
  const [clientId, exp, sig] = parts;
  const expect = crypto.createHmac('sha256', SUPABASE_KEY).update('otp:' + clientId + '.' + exp).digest('base64url');
  const a = Buffer.from(sig);
  const b = Buffer.from(expect);
  if (!(a.length === b.length && crypto.timingSafeEqual(a, b))) return null;
  if (Number(exp) < Date.now()) return null;
  return clientId;
}
// OTP を顧問先の LINE にプッシュ（事務所トークン→env フォールバック）
async function pushLineOtp(client: any, otp: string): Promise<boolean> {
  let token = ENV_LINE_TOKEN;
  if (client.office_id) {
    const { data: off } = await supabase
      .from('offices')
      .select('line_channel_access_token')
      .eq('id', client.office_id)
      .limit(1);
    if (off && off.length && off[0].line_channel_access_token) token = off[0].line_channel_access_token;
  }
  if (!token || !client.linked_line_user_id) return false;
  try {
    const r = await fetch('https://api.line.me/v2/bot/message/push', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({
        to: client.linked_line_user_id,
        messages: [
          {
            type: 'text',
            text: `【ログイン用ワンタイムパスワード】\n${otp}\n\n5分以内に画面へ入力してください。\nお心当たりがない場合はこのメッセージを無視してください。`,
          },
        ],
      }),
    });
    return r.ok;
  } catch {
    return false;
  }
}

const PAGE_HEAD = `<meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<style>
  :root { --bg:#f1f5f9; --card:#fff; --line:#e2e8f0; --text:#0f172a; --muted:#64748b; }
  * { box-sizing:border-box; }
  body { margin:0; background:var(--bg); color:var(--text); font-family:-apple-system,BlinkMacSystemFont,"Hiragino Kaku Gothic ProN","Noto Sans JP",sans-serif; }
  header { position:sticky; top:0; background:#0f172a; color:#fff; padding:14px 16px; display:flex; align-items:center; gap:10px; flex-wrap:wrap; z-index:10; }
  header h1 { font-size:1.05rem; margin:0; font-weight:700; }
  header .who { color:#cbd5e1; font-size:.85rem; }
  header .logout { margin-left:auto; color:#94a3b8; text-decoration:none; font-size:.78rem; }
  .wrap { max-width:680px; margin:0 auto; padding:14px; }
  .tally { display:flex; gap:10px; margin-bottom:14px; }
  .tally .box { flex:1; background:var(--card); border:1px solid var(--line); border-radius:14px; padding:12px 14px; text-align:center; }
  .tally .box .n { font-size:1.5rem; font-weight:800; }
  .tally .box .l { font-size:.72rem; color:var(--muted); margin-top:2px; }
  .filterbar { display:flex; gap:6px; overflow-x:auto; padding-bottom:8px; margin-bottom:8px; -webkit-overflow-scrolling:touch; }
  .tab { white-space:nowrap; text-decoration:none; color:var(--muted); font-size:.82rem; padding:5px 12px; border-radius:999px; border:1px solid var(--line); background:#fff; }
  .tab.active { background:#0f172a; color:#fff; border-color:#0f172a; }
  .tab b { color:#94a3b8; } .tab.active b { color:#cbd5e1; }
  .card { display:flex; gap:12px; background:var(--card); border:1px solid var(--line); border-radius:14px; padding:12px; margin-bottom:10px; }
  .thumb { flex:0 0 88px; }
  .thumb img { width:88px; height:88px; object-fit:cover; border-radius:10px; border:1px solid var(--line); background:#f8fafc; }
  .thumb .pdf, .thumb .noimg { width:88px; height:88px; display:flex; align-items:center; justify-content:center; border-radius:10px; border:1px dashed var(--line); color:var(--muted); font-size:.72rem; text-align:center; text-decoration:none; }
  .info { flex:1; min-width:0; }
  .top { display:flex; align-items:center; gap:7px; flex-wrap:wrap; margin-bottom:5px; }
  .badge { color:#fff; font-size:.7rem; font-weight:700; padding:2px 8px; border-radius:999px; }
  .side { font-size:.7rem; font-weight:700; padding:2px 8px; border-radius:999px; }
  .side.sales { color:#047857; background:#d1fae5; } .side.expense { color:#1e40af; background:#dbeafe; }
  .review { color:#b45309; background:#fef3c7; font-size:.7rem; font-weight:700; padding:2px 8px; border-radius:999px; }
  .cedit { color:#047857; background:#d1fae5; font-size:.7rem; font-weight:700; padding:2px 8px; border-radius:999px; }
  .editlink { display:inline-block; margin-top:8px; font-size:.82rem; color:#2563eb; text-decoration:none; border:1px solid #bfdbfe; background:#eff6ff; padding:5px 12px; border-radius:9px; }
  .editform { max-width:520px; margin:8px auto; background:#fff; border:1px solid var(--line); border-radius:14px; padding:18px; }
  .editform h2 { margin:0 0 4px; font-size:1.1rem; }
  .editform .sub { color:var(--muted); font-size:.82rem; margin:0 0 14px; }
  .editform label { display:block; font-size:.82rem; font-weight:700; color:#334155; margin:12px 0 4px; }
  .editform input, .editform textarea { width:100%; font-size:1rem; padding:10px; border:1px solid #cbd5e1; border-radius:9px; }
  .editform .row2 { display:flex; gap:10px; } .editform .row2 > div { flex:1; }
  .editform .btns { display:flex; gap:10px; margin-top:18px; }
  .editform button { flex:1; font-size:1rem; font-weight:700; padding:12px; border:none; border-radius:10px; background:#2563eb; color:#fff; }
  .editform a.cancel { flex:0 0 auto; align-self:center; color:var(--muted); text-decoration:none; font-size:.9rem; padding:12px; }
  .editform .note { color:#94a3b8; font-size:.76rem; margin-top:12px; line-height:1.5; }
  .saved { max-width:520px; margin:10px auto 0; background:#d1fae5; color:#047857; font-weight:700; text-align:center; padding:10px; border-radius:10px; font-size:.9rem; }
  .vendor { font-size:1rem; font-weight:700; }
  .amount { font-size:1.25rem; font-weight:800; margin:2px 0; }
  .date { color:var(--muted); font-size:.8rem; }
  .empty { text-align:center; color:var(--muted); padding:50px 18px; }
  .login { max-width:380px; margin:8vh auto; background:#fff; border:1px solid var(--line); border-radius:16px; padding:24px; }
  .login h2 { margin:0 0 6px; font-size:1.15rem; }
  .login p { color:var(--muted); font-size:.85rem; margin:0 0 16px; line-height:1.6; }
  .login input { width:100%; font-size:1.15rem; letter-spacing:.15em; text-align:center; padding:12px; border:1px solid #cbd5e1; border-radius:10px; text-transform:uppercase; }
  .login button { width:100%; margin-top:12px; font-size:1rem; font-weight:700; padding:12px; border:none; border-radius:10px; background:#2563eb; color:#fff; cursor:pointer; }
  .login .err { color:#dc2626; font-size:.85rem; margin-top:10px; text-align:center; }
  .mgmt { background:var(--card); border:1px solid var(--line); border-radius:14px; padding:14px; margin-bottom:14px; }
  .pnl { display:flex; gap:8px; }
  .pnl .p { flex:1; text-align:center; }
  .pnl .pl { font-size:.72rem; color:var(--muted); }
  .pnl .pv { font-size:1.2rem; font-weight:800; margin-top:2px; }
  .pnl .pv.sales { color:#047857; } .pnl .pv.expense { color:#1e40af; } .pnl .pv.profit { color:#0f172a; } .pnl .pv.neg { color:#dc2626; }
  .note { font-size:.72rem; color:#b45309; background:#fffbeb; border:1px solid #fde68a; border-radius:8px; padding:6px 9px; margin:10px 0 4px; line-height:1.5; }
  .msec { margin-top:12px; }
  .mh { font-size:.82rem; font-weight:700; color:#334155; margin-bottom:7px; display:flex; align-items:center; }
  .leg { margin-left:auto; font-size:.7rem; color:var(--muted); font-weight:400; }
  .leg i { display:inline-block; width:9px; height:9px; border-radius:2px; vertical-align:middle; margin:0 3px 0 8px; }
  .leg .ls { background:#10b981; } .leg .le { background:#3b82f6; }
  .brow { display:flex; align-items:center; gap:8px; margin-bottom:5px; }
  .brow .bn { flex:0 0 90px; font-size:.8rem; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
  .brow .bbar { flex:1; background:#f1f5f9; border-radius:5px; height:10px; overflow:hidden; }
  .brow .bbar i { display:block; height:100%; background:#3b82f6; }
  .brow .ba { flex:0 0 auto; font-size:.82rem; font-weight:700; font-variant-numeric:tabular-nums; }
  .trow { display:flex; align-items:center; gap:8px; margin-bottom:6px; }
  .trow .tm { flex:0 0 36px; font-size:.78rem; color:var(--muted); }
  .trow .tbars { flex:1; display:flex; flex-direction:column; gap:2px; }
  .trow .tbar { background:#f1f5f9; border-radius:3px; height:7px; overflow:hidden; }
  .trow .tbar i { display:block; height:100%; }
  .trow .tbar .bs { background:#10b981; } .trow .tbar .be { background:#3b82f6; }
  .trow .tp { flex:0 0 64px; text-align:right; font-size:.8rem; font-weight:700; font-variant-numeric:tabular-nums; color:#047857; }
  .trow .tp.neg { color:#dc2626; }
  .subtally { margin-top:10px; font-size:.78rem; color:var(--muted); text-align:right; }
  .muted { color:var(--muted); font-size:.82rem; }
  .uploader { background:var(--card); border:1px solid var(--line); border-radius:14px; padding:14px; margin-bottom:14px; }
  .dropzone { border:2px dashed #cbd5e1; border-radius:12px; padding:22px 14px; text-align:center; color:var(--muted); cursor:pointer; transition:.15s; }
  .dropzone.drag { border-color:#2563eb; background:#eff6ff; color:#2563eb; }
  .dropzone .big { font-size:1.6rem; line-height:1; }
  .dropzone .t { font-weight:800; color:var(--text); margin-top:6px; font-size:1rem; }
  .dropzone .s { font-size:.8rem; margin-top:4px; line-height:1.6; }
  .uphint { font-size:.76rem; color:var(--muted); margin:12px 2px 6px; }
  .tiles { display:grid; grid-template-columns:repeat(auto-fill,minmax(98px,1fr)); gap:8px; }
  .tile { border:1px solid var(--line); border-radius:12px; padding:10px 6px; text-align:center; cursor:pointer; background:#f8fafc; transition:.12s; }
  .tile:hover, .tile:active { border-color:#2563eb; background:#eff6ff; }
  .tile .ic { font-size:1.35rem; line-height:1; }
  .tile .nm { font-size:.76rem; font-weight:700; margin-top:4px; }
  .tile .ds { font-size:.66rem; color:var(--muted); margin-top:2px; line-height:1.3; }
  .upbusy { opacity:.55; pointer-events:none; }
  .uptoast { position:fixed; left:50%; bottom:20px; transform:translateX(-50%); background:#0f172a; color:#fff; padding:12px 18px; border-radius:12px; font-size:.85rem; max-width:90%; box-shadow:0 6px 20px rgba(0,0,0,.28); z-index:50; white-space:pre-line; display:none; text-align:center; }
  .uptoast.show { display:block; }
  .uptoast.err { background:#b91c1c; }
  /* PC幅: 一覧ダッシュのみ2カラム（左=経営パネル固定／右=アップロード+書類）。スマホは縦積みのまま */
  .layout { display:block; }
  @media (min-width:880px){
    .wrap.wide { max-width:1080px; }
    .wrap.wide .layout { display:grid; grid-template-columns:340px 1fr; gap:22px; align-items:start; }
    .wrap.wide .col-side { position:sticky; top:64px; }
    .wrap.wide .mgmt { margin-bottom:0; }
  }
</style>`;

// アップローダー（ハイブリッド: 大きなドロップゾーン＋カテゴリタイル。種別は裏でAIが自動判別）。
const UPLOAD_TILES: [string, string, string][] = [
  ['🧾', '領収書', 'レシート'],
  ['📄', '請求書', '受取/発行'],
  ['🏦', '通帳', '預金の記帳'],
  ['💳', 'カード明細', 'クレカ利用'],
  ['👥', '給与明細', '明細/賃金台帳'],
  ['🧾', '納付書', '税金/社保'],
  ['🏢', '固定資産', '車/機械/PC等'],
  ['🛒', 'EC入金', 'Amazon/楽天等'],
  ['💴', '小口現金', '出納帳'],
  ['🧮', '棚卸表', '期末在庫'],
  ['📉', '返済予定表', '借入金'],
  ['📑', '残高証明', '銀行'],
];
const UPLOADER = `
  <div class="uploader" id="up">
    <div class="dropzone" id="dz">
      <div class="big">⬆</div>
      <div class="t">書類をアップロード</div>
      <div class="s">タップして写真/PDFを選択（PCはドラッグ＆ドロップ）<br>種類はAIが自動で判別します</div>
    </div>
    <div class="uphint">迷ったら↓から（タップでもアップできます）</div>
    <div class="tiles">${UPLOAD_TILES.map(
      ([ic, nm, ds]) => `<div class="tile"><div class="ic">${ic}</div><div class="nm">${nm}</div><div class="ds">${ds}</div></div>`,
    ).join('')}</div>
    <input type="file" id="upfile" accept="image/*,application/pdf" style="display:none">
  </div>
  <div class="uptoast" id="uptoast"></div>
  <script>(function(){
    var dz=document.getElementById('dz'),inp=document.getElementById('upfile'),up=document.getElementById('up'),toast=document.getElementById('uptoast');
    function show(m,e){toast.textContent=m;toast.className='uptoast show'+(e?' err':'');}
    function hide(){toast.className='uptoast';}
    function pick(){inp.click();}
    dz.addEventListener('click',pick);
    Array.prototype.forEach.call(document.querySelectorAll('.tile'),function(t){t.addEventListener('click',pick);});
    ['dragover','dragenter'].forEach(function(e){dz.addEventListener(e,function(ev){ev.preventDefault();dz.classList.add('drag');});});
    ['dragleave','dragend','drop'].forEach(function(e){dz.addEventListener(e,function(ev){ev.preventDefault();dz.classList.remove('drag');});});
    dz.addEventListener('drop',function(ev){var f=ev.dataTransfer&&ev.dataTransfer.files&&ev.dataTransfer.files[0];if(f)send(f);});
    inp.addEventListener('change',function(){if(inp.files&&inp.files[0])send(inp.files[0]);inp.value='';});

    // 画像は送信前にブラウザで縮小（Claudeの5MB制限・速度・コストに効く）。PDFはそのまま。
    function prepare(file){
      return new Promise(function(resolve){
        if(!/^image\\//.test(file.type)){resolve({blob:file,contentType:file.type||'application/pdf',filename:file.name});return;}
        var url=URL.createObjectURL(file),img=new Image();
        img.onload=function(){
          URL.revokeObjectURL(url);
          var max=2200,w=img.width,h=img.height,mx=Math.max(w,h);
          if(mx<=max&&file.size<=1.5*1024*1024){resolve({blob:file,contentType:file.type,filename:file.name});return;}
          var s=Math.min(1,max/mx),cw=Math.round(w*s),ch=Math.round(h*s);
          var cv=document.createElement('canvas');cv.width=cw;cv.height=ch;
          cv.getContext('2d').drawImage(img,0,0,cw,ch);
          cv.toBlob(function(b){if(b)resolve({blob:b,contentType:'image/jpeg',filename:(file.name.replace(/\\.[^.]+$/,'')||'photo')+'.jpg'});else resolve({blob:file,contentType:file.type,filename:file.name});},'image/jpeg',0.85);
        };
        img.onerror=function(){URL.revokeObjectURL(url);resolve({blob:file,contentType:file.type,filename:file.name});};
        img.src=url;
      });
    }
    function send(file){
      if(file.size>20*1024*1024){show('ファイルが大きすぎます（20MBまで）。分割してお送りください。',true);setTimeout(hide,6000);return;}
      up.classList.add('upbusy');show('準備中…\\n「'+file.name+'」');
      var prep;
      prepare(file).then(function(p){
        prep=p;show('アップロード中…\\n「'+p.filename+'」');
        return fetch('/api/upload-url',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({contentType:p.contentType})}).then(function(r){return r.json();});
      }).then(function(u){
        if(!u||!u.ok)throw (u&&u.message)||'URL発行に失敗';
        return fetch(u.signedUrl,{method:'PUT',headers:{'Content-Type':prep.contentType,'x-upsert':'true'},body:prep.blob}).then(function(pr){
          if(!pr.ok)throw 'アップロードに失敗';
          show('解析中…（少々お待ちください）');
          return fetch('/api/upload',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({path:u.path,sig:u.sig,contentType:prep.contentType,filename:prep.filename})}).then(function(r){return r.json().catch(function(){return {ok:false,message:'通信エラー'};});});
        });
      }).then(function(j){
        up.classList.remove('upbusy');show((j.ok?'✓ ':'⚠️ ')+(j.message||''),!j.ok);
        if(j.ok){setTimeout(function(){location.reload();},1800);}else{setTimeout(hide,6000);}
      }).catch(function(e){
        up.classList.remove('upbusy');show('⚠️ '+(typeof e==='string'?e:'アップロードに失敗しました'),true);setTimeout(hide,6000);
      });
    }
  })();</script>`;

function loginPage(error?: string): string {
  return `<!doctype html><html lang="ja"><head>${PAGE_HEAD}<title>顧問先ログイン｜パーフェクト24/7</title></head><body>
<div class="login">
  <h2>書類かんたん確認</h2>
  <p>事務所からお伝えした<b>登録コード</b>を入力してください。<br>確認のため、お使いの<b>LINEにワンタイムパスワード</b>をお送りします。</p>
  <form method="post" action="/api/my">
    <input type="hidden" name="action" value="requestotp">
    <input name="code" placeholder="登録コード" autocomplete="off" autocapitalize="characters" required>
    <button type="submit">次へ（パスワードを送る）</button>
    ${error ? `<div class="err">${esc(error)}</div>` : ''}
  </form>
</div>
</body></html>`;
}

// ステップ2: LINEに届いたOTPを入力
function renderOtpPage(token: string, error?: string): string {
  return `<!doctype html><html lang="ja"><head>${PAGE_HEAD}<title>ワンタイムパスワード｜パーフェクト24/7</title></head><body>
<div class="login">
  <h2>ワンタイムパスワード</h2>
  <p>あなたの<b>LINE</b>に6桁のパスワードをお送りしました。<br>5分以内に入力してください。</p>
  <form method="post" action="/api/my">
    <input type="hidden" name="action" value="verifyotp">
    <input type="hidden" name="token" value="${esc(token)}">
    <input name="otp" placeholder="6桁の数字" inputmode="numeric" autocomplete="one-time-code" maxlength="6" required>
    <button type="submit">ログイン</button>
    ${error ? `<div class="err">${esc(error)}</div>` : ''}
  </form>
  <form method="post" action="/api/my" style="margin-top:10px;text-align:center">
    <input type="hidden" name="action" value="resendotp">
    <input type="hidden" name="token" value="${esc(token)}">
    <button type="submit" style="background:none;color:#64748b;border:none;font-size:.85rem;text-decoration:underline;cursor:pointer">パスワードを再送する</button>
  </form>
</div>
</body></html>`;
}

type Row = Record<string, any>;

async function renderDashboard(clientId: string, fType: string): Promise<string> {
  const { data: client } = await supabase
    .from('clients')
    .select('id, client_code, official_name')
    .eq('id', clientId)
    .single();
  if (!client) return loginPage('セッションが無効です。もう一度ログインしてください。');

  // 自分の書類のみ（最新200件）
  const { data: receipts } = await supabase
    .from('receipts')
    .select('id, document_type, direction, total_amount, issued_date, created_at, account_code')
    .eq('client_id', clientId)
    .order('created_at', { ascending: false })
    .limit(400);
  const recs: Row[] = receipts ?? [];
  const ids = recs.map((r) => r.id);

  const [fieldsRes, imgRes, acctRes] = await Promise.all([
    ids.length
      ? supabase.from('extracted_fields').select('receipt_id, field_name, field_value').in('receipt_id', ids)
      : Promise.resolve({ data: [] as Row[] }),
    ids.length
      ? supabase.from('receipt_images').select('receipt_id, storage_path, content_type').in('receipt_id', ids)
      : Promise.resolve({ data: [] as Row[] }),
    supabase.from('account_titles').select('code, name').then((r) => r, () => ({ data: [] as Row[] })),
  ]);
  const accountName: Record<string, string> = {};
  for (const a of acctRes.data ?? []) accountName[a.code] = a.name;
  const fieldsByRec: Record<string, Record<string, string>> = {};
  for (const f of fieldsRes.data ?? []) (fieldsByRec[f.receipt_id] ??= {})[f.field_name] = f.field_value;
  const imgByRec: Record<string, Row> = {};
  for (const im of imgRes.data ?? []) imgByRec[im.receipt_id] ??= im;

  const paths = Object.values(imgByRec).map((im) => im.storage_path).filter(Boolean);
  const signed: Record<string, string> = {};
  if (paths.length) {
    const { data: list } = await supabase.storage.from('receipts').createSignedUrls(paths, 3600);
    for (const s of list ?? []) if (s.path && s.signedUrl) signed[s.path] = s.signedUrl;
  }

  // 解析できた書類のみ（金額/取引先あり、または明細系の種別）
  const meaningful = recs.filter(
    (r) =>
      r.total_amount != null ||
      Boolean(fieldsByRec[r.id]?.['vendor']) ||
      LINE_DOC_TYPES.includes(r.document_type),
  );

  // 今月（JST）の件数・経費/売上累計
  const jst = new Date(Date.now() + 9 * 3600 * 1000);
  const ym = `${jst.getUTCFullYear()}-${String(jst.getUTCMonth() + 1).padStart(2, '0')}`;
  // 「今月の提出」件数は受信日(created_at)基準＝今月LINEで送った書類の数。
  const thisMonth = meaningful.filter((r) => String(r.created_at).slice(0, 7) === ym);
  const monthCount = thisMonth.length;

  // ───────── 経営の見える化（参考値）─────────
  // 損益に効く書類のみ（通帳・カード・固定資産・残高証明などは二重計上/資産のため除外）。
  // 税込ベースの概算。正式な試算表は事務所側で算出する。
  const PNL_TYPES = new Set(['receipt', 'invoice', 'tax_payment', 'ec_payout', 'payslip', 'wage_ledger']);
  const pnl = meaningful.filter((r) => PNL_TYPES.has(r.document_type));
  const monthKey = (r: Row) => String(r.issued_date ?? r.created_at ?? '').slice(0, 7);

  // 今月の売上/経費は「書類の日付(issued_date)」基準で損益対象書類(pnl)から集計。
  // → 下の「経費の内訳」「月次推移」と同じ基準・同じ対象なので数字が一致する。
  const monthSales = pnl
    .filter((r) => r.direction === 'sales' && monthKey(r) === ym)
    .reduce((s, r) => s + (Number(r.total_amount) || 0), 0);
  const monthExpense = pnl
    .filter((r) => r.direction === 'expense' && monthKey(r) === ym)
    .reduce((s, r) => s + (Number(r.total_amount) || 0), 0);

  // 直近6ヶ月の推移
  const months: string[] = [];
  for (let i = 5; i >= 0; i--) {
    const d = new Date(Date.UTC(jst.getUTCFullYear(), jst.getUTCMonth() - i, 1));
    months.push(`${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`);
  }
  const trend: Record<string, { sales: number; expense: number }> = {};
  for (const m of months) trend[m] = { sales: 0, expense: 0 };
  for (const r of pnl) {
    const m = monthKey(r);
    if (!(m in trend)) continue;
    const amt = Number(r.total_amount) || 0;
    if (r.direction === 'sales') trend[m].sales += amt;
    else if (r.direction === 'expense') trend[m].expense += amt;
  }

  // 今月の科目別 経費内訳
  const expByAcct: Record<string, number> = {};
  for (const r of pnl) {
    if (r.direction !== 'expense' || monthKey(r) !== ym) continue;
    const code = r.account_code || 'other';
    expByAcct[code] = (expByAcct[code] ?? 0) + (Number(r.total_amount) || 0);
  }
  const expBreakdown = Object.entries(expByAcct)
    .map(([code, amt]) => ({ name: accountName[code] ?? '未分類', amt }))
    .sort((a, b) => b.amt - a.amt);
  const monthProfit = monthSales - monthExpense;

  // 種別タブ
  const present = [...new Set(meaningful.map((r) => r.document_type ?? 'other'))];
  const typeDefs: [string, string][] = [['', 'すべて'], ...present.map((t) => [t, DOC_LABEL[t] ?? t] as [string, string])];
  const tabs = typeDefs
    .map(([val, label]) => {
      const n = val === '' ? meaningful.length : meaningful.filter((r) => (r.document_type ?? 'other') === val).length;
      return `<a class="tab${fType === val ? ' active' : ''}" href="/api/my${val ? '?type=' + encodeURIComponent(val) : ''}">${esc(label)} <b>${n}</b></a>`;
    })
    .join('');

  const display = fType ? meaningful.filter((r) => (r.document_type ?? 'other') === fType) : meaningful;

  const cards = display.length
    ? display
        .map((r) => {
          const f = fieldsByRec[r.id] ?? {};
          const docType = r.document_type ?? 'other';
          const img = imgByRec[r.id];
          const url = img ? signed[img.storage_path] : undefined;
          const isImg = (img?.content_type ?? '').startsWith('image/');
          const thumb = url && isImg
            ? `<a href="${esc(url)}" target="_blank" rel="noopener"><img src="${esc(url)}" loading="lazy" alt=""></a>`
            : url
              ? `<a class="pdf" href="${esc(url)}" target="_blank" rel="noopener">📄 PDF</a>`
              : `<div class="noimg">画像なし</div>`;
          const who = f['counterparty'] ?? f['vendor'] ?? (LINE_DOC_TYPES.includes(docType) ? DOC_LABEL[docType] : '取引先不明');
          const review = f['needs_review'] === 'true';
          // 単一金額型のみ顧問先が事実項目を修正できる（明細行型・科目は事務所側）
          const editable = !LINE_DOC_TYPES.includes(docType) && docType !== 'other';
          const clientEdited = Boolean(f['client_edited']);
          return `<div class="card">
            <div class="thumb">${thumb}</div>
            <div class="info">
              <div class="top">
                <span class="badge" style="background:${DOC_COLOR[docType] ?? '#6b7280'}">${esc(DOC_LABEL[docType] ?? docType)}</span>
                ${r.direction && docType !== 'bankbook' ? `<span class="side ${r.direction}">${r.direction === 'sales' ? '売上' : '経費'}</span>` : ''}
                ${review ? `<span class="review">確認中</span>` : ''}
                ${clientEdited ? `<span class="cedit">修正済み</span>` : ''}
              </div>
              <div class="vendor">${esc(who)}</div>
              ${r.total_amount != null ? `<div class="amount">${yen(r.total_amount)}</div>` : ''}
              <div class="date">${esc(fmtDate(r.issued_date))}</div>
              ${editable ? `<a class="editlink" href="/api/my?edit=${esc(r.id)}">✎ 内容を修正</a>` : ''}
            </div>
          </div>`;
        })
        .join('')
    : '<div class="empty">まだ書類がありません。LINE で領収書・請求書を撮って送ってください。</div>';

  // 経営の見える化パネル（参考値）
  const maxTrend = Math.max(1, ...months.map((m) => Math.max(trend[m].sales, trend[m].expense)));
  const trendRows = months
    .map((m) => {
      const t = trend[m];
      const profit = t.sales - t.expense;
      return `<div class="trow">
        <span class="tm">${esc(m.slice(5))}月</span>
        <div class="tbars">
          <div class="tbar"><i class="bs" style="width:${((t.sales / maxTrend) * 100).toFixed(1)}%"></i></div>
          <div class="tbar"><i class="be" style="width:${((t.expense / maxTrend) * 100).toFixed(1)}%"></i></div>
        </div>
        <span class="tp ${profit < 0 ? 'neg' : ''}">${profit >= 0 ? '+' : '−'}${Math.abs(Math.round(profit)).toLocaleString()}</span>
      </div>`;
    })
    .join('');
  const maxExp = Math.max(1, ...expBreakdown.map((e) => e.amt));
  const breakdownRows =
    expBreakdown
      .slice(0, 6)
      .map(
        (e) => `<div class="brow">
        <span class="bn">${esc(e.name)}</span>
        <div class="bbar"><i style="width:${((e.amt / maxExp) * 100).toFixed(1)}%"></i></div>
        <span class="ba">${yen(e.amt)}</span>
      </div>`,
      )
      .join('') || '<div class="muted">今月の経費はまだありません。</div>';
  const mgmt = `<div class="mgmt">
    <div class="pnl">
      <div class="p"><div class="pl">今月の売上</div><div class="pv sales">${monthSales ? '¥' + monthSales.toLocaleString() : '—'}</div></div>
      <div class="p"><div class="pl">今月の経費</div><div class="pv expense">${monthExpense ? '¥' + monthExpense.toLocaleString() : '—'}</div></div>
      <div class="p"><div class="pl">今月の利益</div><div class="pv ${monthProfit < 0 ? 'neg' : 'profit'}">${(monthProfit >= 0 ? '¥' : '−¥') + Math.abs(Math.round(monthProfit)).toLocaleString()}</div></div>
    </div>
    <div class="note">※ LINEで送っていただいた書類からの概算（税込）です。正式な試算表・申告は事務所にご確認ください。</div>
    <div class="msec"><div class="mh">今月の経費の内訳</div>${breakdownRows}</div>
    <div class="msec"><div class="mh">月次の推移（直近6ヶ月）<span class="leg"><i class="ls"></i>売上<i class="le"></i>経費</span></div>${trendRows}</div>
    <div class="subtally">今月の提出 ${monthCount} 件</div>
  </div>`;

  return `<!doctype html><html lang="ja"><head>${PAGE_HEAD}<title>マイ書類｜パーフェクト24/7</title></head><body>
<header>
  <h1>マイ書類</h1>
  <span class="who">${esc(client.official_name)}</span>
  <a class="logout" href="/api/my?info=1">基本情報</a>
  <a class="logout" href="/api/my?logout=1">ログアウト</a>
</header>
<div class="wrap wide">
  <div class="layout">
    <aside class="col-side">${mgmt}</aside>
    <div class="col-main">
      ${UPLOADER}
      <div class="filterbar">${tabs}</div>
      ${cards}
    </div>
  </div>
</div>
</body></html>`;
}

// ───────── 顧問先による内容修正（事実項目のみ） ─────────
function num(v: unknown): number | null {
  if (v === null || v === undefined || String(v).trim() === '') return null;
  const n = Number(String(v).replace(/[^0-9.-]/g, ''));
  return Number.isNaN(n) ? null : n;
}
// extracted_fields の1項目を upsert
async function setField(receiptId: string, name: string, value: string | null) {
  const { data } = await supabase
    .from('extracted_fields')
    .select('id')
    .eq('receipt_id', receiptId)
    .eq('field_name', name)
    .limit(1);
  if (data && data.length) {
    await supabase.from('extracted_fields').update({ field_value: value, source: 'client' }).eq('id', data[0].id);
  } else if (value !== null && value !== '') {
    await supabase.from('extracted_fields').insert({ receipt_id: receiptId, field_name: name, field_value: value, source: 'client' });
  }
}
// 顧問先が編集できる書類か（単一金額型のみ。明細行型・other は不可）
const isClientEditable = (t: string | null | undefined) => !!t && !LINE_DOC_TYPES.includes(t) && t !== 'other';

function renderEditPage(rec: Row, f: Record<string, string>): string {
  const counterparty = f['counterparty'] ?? f['vendor'] ?? '';
  return `<!doctype html><html lang="ja"><head>${PAGE_HEAD}<title>内容を修正｜パーフェクト24/7</title></head><body>
<header>
  <h1>内容を修正</h1>
  <a class="logout" href="/api/my">← 一覧へ戻る</a>
</header>
<div class="wrap">
  <form class="editform" method="post" action="/api/my">
    <input type="hidden" name="action" value="edit">
    <input type="hidden" name="id" value="${esc(rec.id)}">
    <h2>${esc(DOC_LABEL[rec.document_type] ?? '書類')}の修正</h2>
    <p class="sub">読み取りに間違いがあれば直してください。勘定科目など会計の判断は事務所が行います。</p>
    <label>取引先</label>
    <input name="counterparty" value="${esc(counterparty)}" autocomplete="off" placeholder="お店・会社名">
    <label>日付</label>
    <input type="date" name="issued_date" value="${esc(rec.issued_date ?? '')}">
    <div class="row2">
      <div><label>税込金額</label><input type="number" name="total_amount" value="${esc(rec.total_amount ?? '')}" step="1" inputmode="numeric"></div>
      <div><label>うち消費税</label><input type="number" name="tax_amount" value="${esc(rec.tax_amount ?? '')}" step="1" inputmode="numeric"></div>
    </div>
    <label>メモ・但し書き（何の支払いか等）</label>
    <textarea name="note" rows="2" placeholder="例: ○○社との打合せ">${esc(f['note'] ?? '')}</textarea>
    <div class="btns">
      <a class="cancel" href="/api/my">キャンセル</a>
      <button type="submit">保存する</button>
    </div>
    <p class="note">※ 保存すると事務所に「顧問先修正」として伝わります。原本（写真）は変わりません。</p>
  </form>
</div>
<script>(function(){
  var fm=document.querySelector('.editform');
  if(!fm)return;
  fm.addEventListener('submit',function(){
    var b=fm.querySelector('button[type=submit]');
    if(b){b.disabled=true;b.textContent='保存中…';b.style.opacity='.7';}
  });
})();</script>
</body></html>`;
}

// 基本情報ページ（顧問先が自分の会社情報を編集）
function renderInfoPage(c: Row, saved: boolean): string {
  const monthOpts = (sel: unknown) =>
    `<option value="">—</option>` +
    Array.from({ length: 12 }, (_, i) => i + 1)
      .map((m) => `<option value="${m}"${Number(sel) === m ? ' selected' : ''}>${m}月</option>`)
      .join('');
  return `<!doctype html><html lang="ja"><head>${PAGE_HEAD}<title>基本情報｜パーフェクト24/7</title></head><body>
<header>
  <h1>基本情報</h1>
  <a class="logout" href="/api/my">← 一覧へ戻る</a>
</header>
<div class="wrap">
  ${saved ? `<div class="saved">✓ 保存しました</div>` : ''}
  <form class="editform" method="post" action="/api/my">
    <input type="hidden" name="action" value="saveinfo">
    <h2>会社の基本情報</h2>
    <p class="sub">決算月などの把握に使います。変更があればいつでも直してください。（登録コード: ${esc(c.client_code)}）</p>
    <label>会社名・屋号</label>
    <input name="official_name" value="${esc(c.official_name ?? '')}" required placeholder="株式会社○○ ／ ○○商店">
    <label>担当者名</label>
    <input name="contact_name" value="${esc(c.contact_name ?? '')}">
    <label>メールアドレス</label>
    <input type="email" name="email" value="${esc(c.email ?? '')}" inputmode="email" autocapitalize="off">
    <label>携帯電話番号</label>
    <input type="tel" name="phone" value="${esc(c.phone ?? '')}" inputmode="tel">
    <label>営業期間（決算月の把握用）</label>
    <div class="row2">
      <div><label style="font-weight:400;color:#64748b">期首</label><select name="fiscal_start_month">${monthOpts(c.fiscal_start_month)}</select></div>
      <div><label style="font-weight:400;color:#64748b">期末（決算月）</label><select name="fiscal_end_month">${monthOpts(c.fiscal_end_month)}</select></div>
    </div>
    <div class="btns">
      <a class="cancel" href="/api/my">戻る</a>
      <button type="submit">保存する</button>
    </div>
  </form>
</div>
<script>(function(){var f=document.querySelector('.editform');if(f)f.addEventListener('submit',function(){var b=f.querySelector('button[type=submit]');if(b){b.disabled=true;b.textContent='保存中…';b.style.opacity='.7';}});})();</script>
</body></html>`;
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  // ログアウト
  if (req.method === 'GET' && req.query.logout) {
    res.setHeader('Set-Cookie', `${COOKIE}=; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=0`);
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    return res.status(200).send(loginPage());
  }

  // ① 登録コード入力 / 再送 → そのLINEにOTPをプッシュ
  if (req.method === 'POST' && (req.body?.action === 'requestotp' || req.body?.action === 'resendotp')) {
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    const sel = 'id, client_code, official_name, office_id, linked_line_user_id';
    let client: any = null;
    if (req.body.action === 'resendotp') {
      const cid = readOtpToken(req.body?.token);
      if (cid) {
        const { data } = await supabase.from('clients').select(sel).eq('id', cid).limit(1);
        client = data && data.length ? data[0] : null;
      }
    } else {
      const code = normCode(req.body?.code);
      if (!code) return res.status(400).send(loginPage('登録コードを入力してください。'));
      const { data } = await supabase.from('clients').select(sel).eq('registration_code', code).limit(1);
      client = data && data.length ? data[0] : null;
    }
    if (!client) return res.status(401).send(loginPage('登録コードが正しくありません。事務所にご確認ください。'));
    if (!client.linked_line_user_id) {
      return res.status(400).send(loginPage('このコードにLINE連携がありません。事務所にご連絡ください。'));
    }
    const otp = genOtp();
    await supabase
      .from('clients')
      .update({ otp_code: otp, otp_expires: new Date(Date.now() + 5 * 60 * 1000).toISOString(), otp_attempts: 0 })
      .eq('id', client.id);
    const ok = await pushLineOtp(client, otp);
    if (!ok) return res.status(500).send(loginPage('パスワードの送信に失敗しました。時間をおいて再度お試しください。'));
    return res.status(200).send(renderOtpPage(otpToken(client.id)));
  }

  // ② OTP照合 → ログイン（Cookie発行）
  if (req.method === 'POST' && req.body?.action === 'verifyotp') {
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.setHeader('Cache-Control', 'no-store');
    const cid = readOtpToken(req.body?.token);
    if (!cid) return res.status(401).send(loginPage('有効期限が切れました。もう一度コードを入力してください。'));
    const { data } = await supabase.from('clients').select('id, otp_code, otp_expires, otp_attempts').eq('id', cid).limit(1);
    const c = data && data.length ? data[0] : null;
    if (!c || !c.otp_code) return res.status(401).send(loginPage('もう一度ログインしてください。'));
    if ((c.otp_attempts ?? 0) >= 5) {
      await supabase.from('clients').update({ otp_code: null }).eq('id', cid);
      return res.status(401).send(loginPage('試行回数の上限に達しました。もう一度コードを入力してください。'));
    }
    if (!c.otp_expires || new Date(c.otp_expires).getTime() < Date.now()) {
      return res.status(401).send(renderOtpPage(String(req.body.token), 'パスワードの有効期限が切れました。再送してください。'));
    }
    const entered = String(req.body?.otp ?? '').replace(/[^0-9]/g, '');
    if (entered !== c.otp_code) {
      await supabase.from('clients').update({ otp_attempts: (c.otp_attempts ?? 0) + 1 }).eq('id', cid);
      return res.status(401).send(renderOtpPage(String(req.body.token), 'パスワードが違います。'));
    }
    // 成功 → OTP無効化＋セッションCookie
    await supabase.from('clients').update({ otp_code: null, otp_expires: null, otp_attempts: 0 }).eq('id', cid);
    res.setHeader('Set-Cookie', `${COOKIE}=${encodeURIComponent(sign(cid))}; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=2592000`);
    return res.redirect(303, '/api/my');
  }

  const clientId = verify(parseCookies(req)[COOKIE]);
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  if (!clientId) return res.status(200).send(loginPage());

  // 顧問先による内容修正の保存（事実項目のみ。科目・確認済みは触らない）
  if (req.method === 'POST' && req.body?.action === 'edit') {
    const id = String(req.body?.id ?? '');
    const { data: own } = await supabase
      .from('receipts')
      .select('id, document_type')
      .eq('id', id)
      .eq('client_id', clientId) // 必ず本人の書類のみ
      .limit(1);
    const rec = own && own.length ? own[0] : null;
    if (!rec || !isClientEditable(rec.document_type)) return res.redirect(303, '/api/my');
    const total = num(req.body?.total_amount);
    const tax = num(req.body?.tax_amount);
    const net = total != null && tax != null ? total - tax : total;
    const issued = typeof req.body?.issued_date === 'string' && req.body.issued_date ? req.body.issued_date : null;
    // 「顧問先修正」マーク（事務所側で見える）。書き込みは並列で速く
    const stamp = new Date(Date.now() + 9 * 3600 * 1000).toISOString().replace('T', ' ').slice(0, 16);
    await Promise.all([
      supabase
        .from('receipts')
        .update({ total_amount: total, tax_amount: tax, amount: net, issued_date: issued, description: req.body?.note || null })
        .eq('id', id),
      setField(id, 'counterparty', String(req.body?.counterparty ?? '').trim() || null),
      setField(id, 'note', String(req.body?.note ?? '').trim() || null),
      setField(id, 'tax_amount', tax != null ? String(tax) : null),
      setField(id, 'client_edited', stamp),
    ]);
    return res.redirect(303, '/api/my');
  }

  // 基本情報の保存（本人の clients 行のみ）
  if (req.method === 'POST' && req.body?.action === 'saveinfo') {
    const b = req.body ?? {};
    const fm = (v: unknown) => {
      const n = num(v);
      return n != null && n >= 1 && n <= 12 ? Math.round(n) : null;
    };
    await supabase
      .from('clients')
      .update({
        official_name: String(b.official_name ?? '').trim() || '（未設定）',
        contact_name: String(b.contact_name ?? '').trim() || null,
        email: String(b.email ?? '').trim() || null,
        phone: String(b.phone ?? '').trim() || null,
        fiscal_start_month: fm(b.fiscal_start_month),
        fiscal_end_month: fm(b.fiscal_end_month),
      })
      .eq('id', clientId);
    return res.redirect(303, '/api/my?info=1&saved=1');
  }

  // 基本情報ページ
  if (req.method === 'GET' && req.query.info) {
    const { data } = await supabase
      .from('clients')
      .select('id, client_code, official_name, trade_name, contact_name, email, phone, fiscal_start_month, fiscal_end_month')
      .eq('id', clientId)
      .single();
    if (!data) return res.status(200).send(loginPage('セッションが無効です。'));
    return res.status(200).send(renderInfoPage(data, !!req.query.saved));
  }

  // 編集フォーム表示
  if (req.method === 'GET' && typeof req.query.edit === 'string' && req.query.edit) {
    const { data: own } = await supabase
      .from('receipts')
      .select('id, document_type, total_amount, tax_amount, issued_date, client_id')
      .eq('id', req.query.edit)
      .eq('client_id', clientId)
      .limit(1);
    const rec = own && own.length ? own[0] : null;
    if (!rec || !isClientEditable(rec.document_type)) return res.redirect(303, '/api/my');
    const { data: frows } = await supabase.from('extracted_fields').select('field_name, field_value').eq('receipt_id', rec.id);
    const f: Record<string, string> = {};
    for (const x of frows ?? []) f[x.field_name] = x.field_value;
    return res.status(200).send(renderEditPage(rec, f));
  }

  // 表示
  const fType = typeof req.query.type === 'string' ? req.query.type : '';
  try {
    return res.status(200).send(await renderDashboard(clientId, fType));
  } catch (err) {
    console.error('my dashboard error', err);
    return res.status(500).send(loginPage('表示中にエラーが発生しました。もう一度お試しください。'));
  }
}
