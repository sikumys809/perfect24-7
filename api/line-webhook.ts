import type { VercelRequest, VercelResponse } from '@vercel/node';
import crypto from 'node:crypto';
import { waitUntil } from '@vercel/functions';
import { createClient } from '@supabase/supabase-js';
import Anthropic from '@anthropic-ai/sdk';

// LINE署名を生データで検証するため、Vercelの自動body解析を無効化
// 大きめPDFの解析に時間がかかるため実行上限を延長（Hobbyの上限60秒）
export const config = { api: { bodyParser: false }, maxDuration: 60 };

// マルチテナントのフォールバック。事務所ごとのトークンが DB(offices)に無い場合に使う
// （検証中は1事務所＝env のトークンをそのまま使用）
const ENV_LINE_CHANNEL_SECRET = process.env.LINE_CHANNEL_SECRET ?? '';
const ENV_LINE_CHANNEL_ACCESS_TOKEN = process.env.LINE_CHANNEL_ACCESS_TOKEN ?? '';
// supabase-js はベースURL (https://xxxx.supabase.co) を期待するため、
// 末尾に "/rest/v1" が付いていても剥がして渡す
const SUPABASE_URL = (process.env.SUPABASE_URL ?? '').replace(/\/rest\/v1\/?$/, '');
const SUPABASE_KEY = process.env.SUPABASE_KEY ?? '';
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY ?? '';

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);
const anthropic = new Anthropic({ apiKey: ANTHROPIC_API_KEY });

function readRawBody(req: VercelRequest): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function verifyLineSignature(body: Buffer, signature: string | undefined, secret: string): boolean {
  if (!signature || !secret) return false;
  const hash = crypto.createHmac('sha256', secret).update(body).digest('base64');
  const a = Buffer.from(hash);
  const b = Buffer.from(signature);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

async function fetchLineContent(accessToken: string, messageId: string) {
  const res = await fetch(`https://api-data.line.me/v2/bot/message/${messageId}/content`, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (!res.ok) throw new Error(`Failed to fetch content: ${res.status}`);
  const arrayBuffer = await res.arrayBuffer();
  const contentType = res.headers.get('content-type') || 'application/octet-stream';
  return { buffer: Buffer.from(arrayBuffer), contentType };
}

async function replyLineMessage(accessToken: string, replyToken: string, text: string) {
  await fetch('https://api.line.me/v2/bot/message/reply', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${accessToken}`,
    },
    body: JSON.stringify({ replyToken, messages: [{ type: 'text', text }] }),
  });
}

// レシート/領収書/請求書/通帳 抽出用プロンプト（日本語・税務用途）
// 1入力（画像/PDF）に複数枚・複数ページ含まれることがあるため、配列で全件返させる
const EXTRACTION_PROMPT = `あなたは日本語のレシート・領収書・請求書・銀行通帳（預金通帳）を読み取る専門家です。
1つの入力（画像またはPDF）に複数枚・複数ページが含まれることがあります（ノート台紙に複数枚貼付、PDFの複数ページ、通帳の見開きなど）。
出力はJSONオブジェクトのみ（前後の説明文やコードフェンスは不要）。読み取れない項目は推測せず null にしてください。
チェックボックスは実際に印（チェック）が付いているもののみ採用し、印刷された選択肢を勝手に選ばないでください。

まず書類の種類を判定してください:
- receipt = レシート/領収書全般。店舗のレジレシート、飲食店、コンビニ、交通費（電車・タクシー・バス）、駐車場、ICカードのチャージ控え、振込金受取書、各種利用控え・支払証明など「支払った事実を示す証憑」は基本これ。
- invoice = 請求書（これから支払う/受け取る請求。支払期日・振込先が記載されることが多い）。
- bankbook = 銀行・信用金庫の預金通帳（取引明細が行で並ぶ）。
- credit_card = クレジットカードのご利用明細書/利用代金明細（利用日・利用先・利用金額が行で並ぶ。「ご利用明細」「お支払金額」「カード」等）。通帳ではない。
- tax_payment = 税金・社会保険料の納付書/領収証書/納入告知書（法人税・所得税・消費税・源泉所得税・住民税・事業税・固定資産税・自動車税・印紙税・社会保険料・労働保険料 等）。納付先が税務署/都道府県/市区町村/年金事務所/労働局など。
- balance_certificate = 金融機関の残高証明書（決算日等の基準日の預金残高を証明。口座ごとに残高が記載）。
- other = 上記いずれにも当てはまらない場合のみ（名刺・メモ・証憑でない写真など）。判断に迷う支払系の紙は other ではなく receipt にしてください。

document_type が receipt / invoice / tax_payment / balance_certificate の場合のスキーマ（含まれる書類を1件ずつ全件。残高証明書は口座ごとに1件）:
{
  "document_type": "receipt | invoice | tax_payment | balance_certificate",
  "receipts": [
    {
      "date": "YYYY-MM-DD 形式の発行日/納付日（和暦は西暦に変換。インボイス登録番号があるなら2023年10月以降のはず）。不明なら null",
      "vendor": "発行元/納付先（この書類を発行した店名・会社名、納付書なら税務署/年金事務所等）。不明なら null",
      "recipient": "宛名・請求先・宛先・納付者（この書類を受け取る/支払う側の会社/個人名。例:「○○御中」「○○様」）。無ければ null",
      "direction": "提出者（顧問先）から見た向き。顧問先が発行した側=sales（売上）、顧問先が受け取った/支払う側=expense（経費）。納付書(tax_payment)は常に expense。判断できなければ null。下部の【提出者】の指示に従うこと",
      "total_incl_tax": "税込合計金額＝この取引の主たる金額（納付書なら納付額。数値のみ）。不明なら null。重要: 振込手数料などの付随する少額は主金額にしない（下記の fee に入れる）",
      "fee": "主金額とは別に併記された手数料（振込手数料・支払手数料・事務手数料など。数値のみ）。無ければ null",
      "tax_amount": "消費税額（数値のみ）。不明なら null",
      "tax_rate": "\\"10%\\" / \\"8%\\" / \\"mixed\\" / null のいずれか",
      "registration_number": "インボイス登録番号（T + 13桁）。無ければ null",
      "receipt_no": "レシート番号・取引番号・請求書番号。無ければ null",
      "tax_kind": "tax_payment のときの税目/保険種別（例: 源泉所得税, 消費税, 法人税, 住民税, 固定資産税, 社会保険料, 労働保険料）。それ以外は null",
      "period": "tax_payment のときの対象期間/納期（例: 令和6年4月分, 2024年度）。それ以外は null",
      "note": "但し書き（例: 御飲食代として）。無ければ null",
      "confidence": "その1件の抽出の自信度を 0〜1 の数値で"
    }
  ]
}

balance_certificate（残高証明書）の場合: 口座ごとに receipts[] の1件にする。vendor=金融機関名＋支店、note=口座種別・口座番号、date=基準日、total_incl_tax=残高、direction=null（売上でも経費でもない）。tax_amount/tax_rate は null。

重要（金額が複数ある書類）: 振込金受取書・振込明細・払込取扱票など、「お振込金額／お支払金額（主たる金額）」と「振込手数料（少額）」が別々に記載されている書類では、total_incl_tax には主たる金額（通常は大きい方＝実際の振込・支払額）を入れ、手数料は fee に入れてください。手数料の金額（例: 770円）を total_incl_tax にしないでください。

document_type が bankbook の場合のスキーマ（取引明細を上から順に1行ずつ全件。合計や見出し行は含めない）:
{
  "document_type": "bankbook",
  "transactions": [
    {
      "date": "YYYY-MM-DD 形式の取引日（和暦・2桁年は西暦へ変換）。不明なら null",
      "description": "摘要・お取扱内容（振込/カード/ATM/給与 等）。不明なら null",
      "withdrawal": "お支払金額（出金、数値のみ）。無ければ null",
      "deposit": "お預り金額（入金、数値のみ）。無ければ null",
      "balance": "差引残高（数値のみ）。不明なら null",
      "confidence": "その行の抽出の自信度を 0〜1 の数値で"
    }
  ]
}

document_type が credit_card の場合のスキーマ（利用明細を上から順に1行ずつ全件。合計・繰越・キャッシング枠などの集計行は含めない）:
{
  "document_type": "credit_card",
  "card_name": "カードの名称や発行会社（例: 楽天カード, 三井住友VISA）。不明なら null",
  "transactions": [
    {
      "date": "YYYY-MM-DD 形式の利用日（和暦・2桁年は西暦へ変換）。不明なら null",
      "description": "利用先・ご利用先店名（摘要）。不明なら null",
      "amount": "利用金額（数値のみ。支払=プラスの数値）。返金・マイナスは負の数値。不明なら null",
      "confidence": "その行の抽出の自信度を 0〜1 の数値で"
    }
  ]
}

該当する明細／レシートが1件も無ければ、その配列（receipts または transactions）は空配列にしてください。`;

function toNum(v: unknown): number | null {
  if (v === null || v === undefined) return null;
  if (typeof v === 'number') return Number.isNaN(v) ? null : v;
  const n = Number(String(v).replace(/[^0-9.-]/g, ''));
  return Number.isNaN(n) ? null : n;
}

function stripJson(text: string): string {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fenced) return fenced[1].trim();
  const s = text.indexOf('{');
  const e = text.lastIndexOf('}');
  return s >= 0 && e > s ? text.slice(s, e + 1) : text.trim();
}

// インボイス登録番号(T+法人番号13桁)のチェックディジット検証
// 戻り値: true=妥当 / false=不正(誤読の可能性) / null=未取得で判定不能
function validateRegistrationNumber(reg: unknown): boolean | null {
  if (typeof reg !== 'string') return null;
  const m = reg.match(/^T(\d{13})$/);
  if (!m) return false;
  const digits = m[1];
  const check = Number(digits[0]); // 先頭がチェックディジット
  const base = digits.slice(1); // 残り12桁
  let sum = 0;
  for (let i = 0; i < 12; i++) {
    const p = Number(base[11 - i]); // 下n桁目(n=i+1)
    const q = i % 2 === 0 ? 1 : 2; // nが奇数=1 / 偶数=2
    sum += p * q;
  }
  return check === 9 - (sum % 9);
}

// 抽出結果の検算。怪しい点があれば notes に積む（弾かず「要確認」フラグ用）
function validateExtraction(
  ex: any,
  total: number | null,
  tax: number | null,
  issued: string | null,
): { needsReview: boolean; notes: string[] } {
  const notes: string[] = [];

  const regValid = validateRegistrationNumber(ex?.registration_number);
  if (regValid === false) notes.push('登録番号の形式または検査数字が不正（誤読の可能性）');
  if (regValid === true && issued && issued < '2023-10-01') {
    notes.push(`日付 ${issued} が登録番号の存在(2023年10月以降)と矛盾（年の誤読の可能性）`);
  }

  const rateMap: Record<string, number> = { '10%': 0.1, '8%': 0.08 };
  const r = ex?.tax_rate ? rateMap[ex.tax_rate] : undefined;
  if (total != null && tax != null && r != null) {
    const expected = Math.round(total - total / (1 + r));
    if (Math.abs(tax - expected) > 2) {
      notes.push(`消費税額が税率${ex.tax_rate}と不整合（税込${total}なら約${expected}円のはず）`);
    }
  }

  const conf = toNum(ex?.confidence);
  if (conf != null && conf < 0.7) notes.push(`信頼度が低い(${conf})`);

  return { needsReview: notes.length > 0, notes };
}

type BankRow = {
  line_no: number;
  withdrawal: number | null;
  deposit: number | null;
  balance: number | null;
  confidence: number | null;
};

// 通帳明細の残高検算。「前残高 + 入金 - 出金 = 当残高」が成り立たない行を誤読候補として拾う。
// 弾かず needs_review フラグ用。残高が読めない行はスキップ（判定不能）。
function validateBankTransactions(rows: BankRow[]): {
  needsReview: boolean;
  notes: string[];
  badLines: number[];
} {
  const notes: string[] = [];
  const badLines: number[] = [];

  for (let i = 1; i < rows.length; i++) {
    const prev = rows[i - 1];
    const cur = rows[i];
    if (prev.balance == null || cur.balance == null) continue; // 残高未取得は判定不能
    const delta = cur.balance - prev.balance; // 残高の増減
    const txn = (cur.deposit ?? 0) - (cur.withdrawal ?? 0); // 取引額（入金+ / 出金-）
    if (Math.abs(delta - txn) > 1) {
      badLines.push(cur.line_no);
    }
  }
  if (badLines.length) {
    notes.push(`残高が不整合の行: ${badLines.join(', ')}行目（金額または残高の誤読の可能性）`);
  }

  const low = rows.filter((r) => r.confidence != null && (r.confidence as number) < 0.7).length;
  if (low > 0) notes.push(`信頼度が低い行が${low}件`);

  return { needsReview: notes.length > 0, notes, badLines };
}

// 画像/PDF を Claude Opus 4.8 に渡して構造化データ（複数件）を抽出
async function extractDocument(buffer: Buffer, contentType: string, clientName?: string): Promise<any> {
  const today = new Date().toISOString().slice(0, 10);
  // 提出者（顧問先）名が分かれば、売上/経費の向き判定に使わせる
  const directionHint = clientName
    ? `\n\n【提出者】この書類を送ってきた顧問先（提出者）は「${clientName}」です。各証憑の direction を次の基準で判定してください: 発行元（vendor）が「${clientName}」＝顧問先自身なら sales（売上）。宛名/支払側が「${clientName}」、または発行元が他社（仕入先・店舗など）なら expense（経費）。会社名は表記揺れ（株式会社/(株)/前株後株/支店名）があり得るので柔軟に判断。確信が持てなければ null。`
    : '';
  const prompt = `${EXTRACTION_PROMPT}

今日は ${today} です。日付の2桁年（例:「26」）は西暦の下2桁とみなし、今日に最も近い年として解釈してください（例: 今日が2026年なら「26-05-18」は 2026-05-18）。和暦（令和/平成）表記は西暦に変換してください。${directionHint}`;

  const isPdf = contentType.includes('pdf');
  const allowed = ['image/jpeg', 'image/png', 'image/gif', 'image/webp'];
  const block = isPdf
    ? {
        type: 'document',
        source: { type: 'base64', media_type: 'application/pdf', data: buffer.toString('base64') },
      }
    : {
        type: 'image',
        source: {
          type: 'base64',
          media_type: (allowed.includes(contentType) ? contentType : 'image/jpeg') as any,
          data: buffer.toString('base64'),
        },
      };

  // 多件数でも途中で切れないよう出力上限を確保し、ストリーミングでタイムアウトを回避
  const stream = anthropic.messages.stream({
    model: 'claude-opus-4-8',
    max_tokens: 16000,
    messages: [{ role: 'user', content: [block as any, { type: 'text', text: prompt }] }],
  });
  const final: any = await stream.finalMessage();
  const text = (final.content ?? [])
    .filter((b: any) => b.type === 'text')
    .map((b: any) => b.text)
    .join('');
  return JSON.parse(stripJson(text));
}

type SaveCtx = {
  messageId: string;
  path: string;
  contentType: string;
  imageHash: string | null; // 重複弾き用ハッシュ。代表1件のみ付与、他は null
  docType?: string | null; // receipt / invoice / bankbook / other
  clientId?: string | null; // どの顧問先の書類か
  clientName?: string | null; // 顧問先名（売上/経費の向き判定のフォールバック用）
  officeId?: string | null; // どの事務所宛か（未解決=null。後方互換のため null なら列を付けない）
};

// 会社名の表記揺れを吸収して比較するための正規化（法人格・空白を除去）
function normName(s: unknown): string {
  return String(s ?? '')
    .replace(/株式会社|有限会社|合同会社|（株）|\(株\)|㈱|（有）|\(有\)|㈲|（同）|\(同\)/g, '')
    .replace(/[\s　]/g, '')
    .toLowerCase();
}

// 売上(sales)か経費(expense)かを判定。まずモデルの direction を採用し、
// 無ければ顧問先名と発行元/宛名の一致で推定。判定不能なら null。
function resolveDirection(ex: any, clientName?: string | null): 'sales' | 'expense' | null {
  if (ex?.direction === 'sales' || ex?.direction === 'expense') return ex.direction;
  const cn = normName(clientName);
  if (!cn) return null;
  const iss = normName(ex?.vendor);
  const rcp = normName(ex?.recipient);
  const issuerIsClient = !!iss && (iss.includes(cn) || cn.includes(iss));
  const recipientIsClient = !!rcp && (rcp.includes(cn) || cn.includes(rcp));
  if (issuerIsClient && !recipientIsClient) return 'sales';
  if (recipientIsClient && !issuerIsClient) return 'expense';
  return null;
}

// receipts への共通 INSERT 値を組み立てる。office_id は解決済みのときだけ付与し、
// マイグレーション未適用（office_id 列なし）でも壊れないようにする
function receiptInsertValues(ctx: SaveCtx, docType: string | null) {
  const base: Record<string, unknown> = {
    original_filename: ctx.messageId,
    source: 'LINE',
    document_type: docType,
    client_id: ctx.clientId ?? null,
  };
  if (ctx.officeId) base.office_id = ctx.officeId;
  return base;
}

// 抽出1件分を保存し、返信用サマリ行を返す
async function saveReceipt(ex: any, ctx: SaveCtx): Promise<string> {
  const { data: receipt } = await supabase
    .from('receipts')
    .insert(receiptInsertValues(ctx, ctx.docType ?? null))
    .select()
    .single();

  await supabase.from('receipt_images').insert({
    receipt_id: receipt?.id ?? null,
    storage_path: ctx.path,
    content_type: ctx.contentType,
    image_sha256: ctx.imageHash,
  });

  const total = toNum(ex?.total_incl_tax);
  const tax = toNum(ex?.tax_amount);
  const fee = toNum(ex?.fee);
  const net = total != null && tax != null ? total - tax : null;
  const issued =
    typeof ex?.date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(ex.date) ? ex.date : null;
  const conf = toNum(ex?.confidence);

  // 売上/経費の向きと「取引先（顧問先から見た相手方）」を決める。
  // 残高証明書(balance_certificate)は B/S 項目で売上でも経費でもない→ direction=null。
  const isBalance = ctx.docType === 'balance_certificate';
  const dir = isBalance ? null : resolveDirection(ex, ctx.clientName);
  const direction = isBalance ? null : dir ?? 'expense'; // 不明は経費として仮置き（needs_review で拾う）
  const counterparty =
    direction === 'sales' ? ex?.recipient ?? ex?.vendor ?? null : ex?.vendor ?? ex?.recipient ?? null;

  await supabase
    .from('receipts')
    .update({
      amount: net,
      total_amount: total,
      tax_amount: tax,
      issued_date: issued,
      description: ex?.note ?? null,
    })
    .eq('id', receipt?.id);

  // direction は別ステートメントで更新（migration 008 未適用でも本体保存を壊さない。
  // 列が無ければこの update だけ失敗し、向きは extracted_fields 側に残る）。
  await supabase.from('receipts').update({ direction }).eq('id', receipt?.id);

  const fieldRows = (
    [
      ['vendor', ex?.vendor],
      ['recipient', ex?.recipient],
      ['direction', direction],
      ['counterparty', counterparty],
      ['registration_number', ex?.registration_number],
      ['tax_rate', ex?.tax_rate],
      ['receipt_no', ex?.receipt_no],
      ['tax_kind', ex?.tax_kind],
      ['period', ex?.period],
      ['note', ex?.note],
      ['date', ex?.date],
      ['total_incl_tax', total],
      ['fee', fee],
      ['tax_amount', tax],
    ] as [string, unknown][]
  )
    .filter(([, v]) => v !== null && v !== undefined && v !== '')
    .map(([field_name, value]) => ({
      receipt_id: receipt?.id ?? null,
      field_name,
      field_value: String(value),
      confidence: conf,
      source: 'claude-opus-4-8',
    }));

  const validation = validateExtraction(ex, total, tax, issued);
  // 向きが判定できなかった場合も要確認に含める（残高証明書は元々 direction なしなので除外）
  const dirAmbiguous = dir === null && !isBalance;
  const notes = [...validation.notes];
  if (dirAmbiguous) notes.push('売上/経費の自動判定ができず経費として仮置き');
  const needsReview = validation.needsReview || dirAmbiguous;
  fieldRows.push({
    receipt_id: receipt?.id ?? null,
    field_name: 'needs_review',
    field_value: String(needsReview),
    confidence: null,
    source: 'validation',
  });
  if (notes.length) {
    fieldRows.push({
      receipt_id: receipt?.id ?? null,
      field_name: 'validation_notes',
      field_value: notes.join(' / '),
      confidence: null,
      source: 'validation',
    });
  }
  if (fieldRows.length) await supabase.from('extracted_fields').insert(fieldRows);

  const now = new Date().toISOString();
  await supabase.from('processing_jobs').insert({
    receipt_id: receipt?.id ?? null,
    status: 'done',
    queued_at: now,
    started_at: now,
    finished_at: now,
  });

  const yen = total != null ? `¥${total.toLocaleString()}` : '金額不明';
  const feeStr = fee != null ? `（手数料¥${fee.toLocaleString()}）` : '';
  const warn = needsReview ? ' ⚠️要確認' : '';
  // 納付書は【納付】＋税目、残高証明は【残高】、それ以外は売上/経費
  const isTax = ctx.docType === 'tax_payment';
  const head = isTax
    ? `【納付】${ex?.tax_kind ?? '税金・社保'}`
    : isBalance
      ? '【残高】'
      : direction === 'sales'
        ? '【売上】'
        : '【経費】';
  const who = isBalance
    ? ex?.vendor ?? '口座不明'
    : isTax
      ? ex?.vendor ?? counterparty ?? '納付先不明'
      : counterparty ?? '取引先不明';
  return `${head}${head.endsWith('】') ? '' : ' '}${who} / ${issued ?? '日付不明'} / ${yen}${feeStr}${warn}`;
}

// 通帳1冊分（取引明細の配列）を保存し、件数と残高検算の結果を返す
async function saveBankTransactions(
  txns: any[],
  ctx: SaveCtx,
): Promise<{ count: number; validation: ReturnType<typeof validateBankTransactions> }> {
  const { data: receipt } = await supabase
    .from('receipts')
    .insert(receiptInsertValues(ctx, 'bankbook'))
    .select()
    .single();

  await supabase.from('receipt_images').insert({
    receipt_id: receipt?.id ?? null,
    storage_path: ctx.path,
    content_type: ctx.contentType,
    image_sha256: ctx.imageHash,
  });

  const rows = txns.map((t, i) => ({
    receipt_id: receipt?.id ?? null,
    line_no: i + 1,
    txn_date: typeof t?.date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(t.date) ? t.date : null,
    description: t?.description ?? null,
    withdrawal: toNum(t?.withdrawal),
    deposit: toNum(t?.deposit),
    balance: toNum(t?.balance),
    confidence: toNum(t?.confidence),
    source: 'claude-opus-4-8',
  }));
  if (rows.length) await supabase.from('bank_transactions').insert(rows);

  // 残高検算（誤読候補は弾かず needs_review として記録）
  const validation = validateBankTransactions(rows);
  const fieldRows = [
    {
      receipt_id: receipt?.id ?? null,
      field_name: 'needs_review',
      field_value: String(validation.needsReview),
      confidence: null,
      source: 'validation',
    },
  ];
  if (validation.notes.length) {
    fieldRows.push({
      receipt_id: receipt?.id ?? null,
      field_name: 'validation_notes',
      field_value: validation.notes.join(' / '),
      confidence: null,
      source: 'validation',
    });
  }
  await supabase.from('extracted_fields').insert(fieldRows);

  const now = new Date().toISOString();
  await supabase.from('processing_jobs').insert({
    receipt_id: receipt?.id ?? null,
    status: 'done',
    queued_at: now,
    started_at: now,
    finished_at: now,
  });

  return { count: rows.length, validation };
}

// クレジットカード明細1枚分を保存し、件数・合計を返す。
// 明細行は通帳と同じ bank_transactions に格納（利用金額=withdrawal=支出）。direction は経費固定。
async function saveCardStatement(
  txns: any[],
  ctx: SaveCtx,
  cardName: string | null,
): Promise<{ count: number; total: number }> {
  const values = receiptInsertValues(ctx, 'credit_card');
  const { data: receipt } = await supabase.from('receipts').insert(values).select().single();

  await supabase.from('receipt_images').insert({
    receipt_id: receipt?.id ?? null,
    storage_path: ctx.path,
    content_type: ctx.contentType,
    image_sha256: ctx.imageHash,
  });

  const rows = txns.map((t, i) => ({
    receipt_id: receipt?.id ?? null,
    line_no: i + 1,
    txn_date: typeof t?.date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(t.date) ? t.date : null,
    description: t?.description ?? null,
    withdrawal: toNum(t?.amount), // 利用金額=支出として通帳列を流用
    deposit: null,
    balance: null,
    confidence: toNum(t?.confidence),
    source: 'claude-opus-4-8',
  }));
  if (rows.length) await supabase.from('bank_transactions').insert(rows);

  const total = rows.reduce((s, r) => s + (r.withdrawal ?? 0), 0);
  const low = rows.filter((r) => r.confidence != null && (r.confidence as number) < 0.7).length;

  // カードは経費。集計の取り違え防止に direction=expense を付与（best-effort）
  await supabase.from('receipts').update({ direction: 'expense', total_amount: total }).eq('id', receipt?.id);

  const fieldRows: any[] = [
    { receipt_id: receipt?.id ?? null, field_name: 'direction', field_value: 'expense', source: 'claude-opus-4-8' },
    { receipt_id: receipt?.id ?? null, field_name: 'needs_review', field_value: String(low > 0), source: 'validation' },
  ];
  if (cardName) {
    fieldRows.push({ receipt_id: receipt?.id ?? null, field_name: 'vendor', field_value: cardName, source: 'claude-opus-4-8' });
    fieldRows.push({ receipt_id: receipt?.id ?? null, field_name: 'counterparty', field_value: cardName, source: 'claude-opus-4-8' });
  }
  if (low > 0) {
    fieldRows.push({ receipt_id: receipt?.id ?? null, field_name: 'validation_notes', field_value: `信頼度が低い行が${low}件`, source: 'validation' });
  }
  await supabase.from('extracted_fields').insert(fieldRows);

  const now = new Date().toISOString();
  await supabase.from('processing_jobs').insert({
    receipt_id: receipt?.id ?? null,
    status: 'done',
    queued_at: now,
    started_at: now,
    finished_at: now,
  });

  return { count: rows.length, total };
}

// 抽出失敗・該当なし時：画像は保存しつつハッシュは付けない（=再送で再処理できる）
async function saveUnprocessed(ctx: Omit<SaveCtx, 'imageHash'>, errorText: string) {
  const { data: r } = await supabase
    .from('receipts')
    .insert(receiptInsertValues({ ...ctx, imageHash: null }, ctx.docType ?? null))
    .select()
    .single();
  await supabase.from('receipt_images').insert({
    receipt_id: r?.id ?? null,
    storage_path: ctx.path,
    content_type: ctx.contentType,
  });
  const now = new Date().toISOString();
  await supabase.from('processing_jobs').insert({
    receipt_id: r?.id ?? null,
    status: 'failed',
    error: errorText,
    queued_at: now,
    finished_at: now,
  });
}

// 友達追加時・未登録時に送る案内文
const WELCOME_MESSAGE =
  'ご登録ありがとうございます。\nご利用には顧問先登録が必要です。事務所からお伝えした「登録コード」をこのトークに送信してください。\n登録後は領収書・請求書・通帳の画像/PDFを送るだけで自動で記帳されます。';

// 1リクエスト（=1事務所宛）の処理コンテキスト。署名検証後に確定する
type ReqCtx = { accessToken: string; officeId: string | null };

type Office = {
  id: string;
  name: string;
  line_channel_secret: string | null;
  line_channel_access_token: string | null;
};

// webhook payload の destination（botのuserID）から事務所を引く。
// offices テーブルが未作成（マイグレーション未適用）でも落ちないよう握りつぶして null を返す
// ＝その場合は env のトークンで従来どおり単一事務所として動作する。
async function findOfficeByDestination(destination: string | null): Promise<Office | null> {
  if (!destination) return null;
  try {
    const { data, error } = await supabase
      .from('offices')
      .select('id, name, line_channel_secret, line_channel_access_token')
      .eq('line_destination', destination)
      .eq('is_active', true)
      .limit(1);
    if (error) return null;
    return data && data.length > 0 ? (data[0] as Office) : null;
  } catch {
    return null;
  }
}

// LINE userId から登録済み顧問先を引く（未登録なら null）。
// 事務所が解決済みなら、その事務所の顧問先に限定する（マルチテナント分離）
async function findClientByLineUser(lineUserId: string, officeId: string | null) {
  let q = supabase
    .from('clients')
    .select('id, client_code, official_name')
    .eq('linked_line_user_id', lineUserId);
  if (officeId) q = q.eq('office_id', officeId);
  const { data } = await q.limit(1);
  return data && data.length > 0 ? data[0] : null;
}

// 顧問先が送り続けたくなる即時フィードバック用に、当月の登録件数・累計金額を返す。
// （回収率＝堀。送ると「今月N件目・累計¥X」が即返る）。失敗しても本処理は止めない。
async function monthlyTallyLine(clientId: string | null | undefined): Promise<string> {
  if (!clientId) return '';
  try {
    // JST での当月初日（00:00 JST）
    const jst = new Date(Date.now() + 9 * 3600 * 1000);
    const monthStart = `${jst.getUTCFullYear()}-${String(jst.getUTCMonth() + 1).padStart(2, '0')}-01T00:00:00+09:00`;
    const { data, count } = await supabase
      .from('receipts')
      .select('total_amount', { count: 'exact' })
      .eq('client_id', clientId)
      .gte('created_at', monthStart);
    const n = count ?? data?.length ?? 0;
    const total = (data ?? []).reduce((s, r) => s + (Number(r.total_amount) || 0), 0);
    return `\n📥 今月 ${n} 件目・累計 ¥${total.toLocaleString()}`;
  } catch {
    return '';
  }
}

// テキスト（=登録コード想定）を処理して顧問先をひもづける
async function handleRegistration(ev: any, lineUserId: string | null, ctx: ReqCtx) {
  if (!lineUserId) return;

  // 既にひもづいていれば案内のみ
  const existing = await findClientByLineUser(lineUserId, ctx.officeId);
  if (existing) {
    if (ev.replyToken) {
      await replyLineMessage(
        ctx.accessToken,
        ev.replyToken,
        `${existing.official_name} 様として登録済みです（顧問先ID: ${existing.client_code}）。\n領収書・請求書・通帳を送ってください。`,
      );
    }
    return;
  }

  const code = String(ev.message?.text ?? '').trim().toUpperCase();

  // 未ひもづけの顧問先を登録コードで検索（事務所が解決済みならその事務所内に限定）
  let q = supabase
    .from('clients')
    .select('id, client_code, official_name')
    .eq('registration_code', code)
    .is('linked_line_user_id', null);
  if (ctx.officeId) q = q.eq('office_id', ctx.officeId);
  const { data } = await q.limit(1);
  const client = data && data.length > 0 ? data[0] : null;

  if (!client) {
    if (ev.replyToken) {
      await replyLineMessage(
        ctx.accessToken,
        ev.replyToken,
        '登録コードが正しくないか、既に使用済みです。事務所にご確認ください。',
      );
    }
    return;
  }

  // ひもづけ（競合防止のため linked_line_user_id が null の行のみ更新）
  const { data: updated } = await supabase
    .from('clients')
    .update({ linked_line_user_id: lineUserId, linked_at: new Date().toISOString() })
    .eq('id', client.id)
    .is('linked_line_user_id', null)
    .select('id')
    .limit(1);

  if (ev.replyToken) {
    if (updated && updated.length > 0) {
      await replyLineMessage(
        ctx.accessToken,
        ev.replyToken,
        `${client.official_name} 様、登録が完了しました（顧問先ID: ${client.client_code}）。\n領収書・請求書・通帳の画像/PDFを送ってください。`,
      );
    } else {
      await replyLineMessage(
        ctx.accessToken,
        ev.replyToken,
        'この登録コードは既に使用済みです。事務所にご確認ください。',
      );
    }
  }
}

// 200を返した後にバックグラウンドで実行される処理。ctx は署名検証で確定した事務所の文脈
async function processWebhookEvents(bodyText: string, ctx: ReqCtx) {
  const payload = JSON.parse(bodyText);
  const events = payload.events || [];

  for (const ev of events) {
    try {
      const lineUserId = ev?.source?.userId ?? null;

      // 友達追加：登録の案内を返す
      if (ev.type === 'follow') {
        if (ev.replyToken) await replyLineMessage(ctx.accessToken, ev.replyToken, WELCOME_MESSAGE);
        continue;
      }

      if (ev.type !== 'message') continue;
      const msgType = ev.message?.type;

      // テキストは登録コードとして処理
      if (msgType === 'text') {
        await handleRegistration(ev, lineUserId, ctx);
        continue;
      }

      if (msgType !== 'image' && msgType !== 'file') continue;

      // 書類は登録済み顧問先のみ受付（未登録は登録を促す）
      const client = lineUserId ? await findClientByLineUser(lineUserId, ctx.officeId) : null;
      if (!client) {
        if (ev.replyToken) await replyLineMessage(ctx.accessToken, ev.replyToken, WELCOME_MESSAGE);
        continue;
      }

      const messageId = ev.message.id;
      const { buffer, contentType } = await fetchLineContent(ctx.accessToken, messageId);

      const isPdf = contentType.includes('pdf');
      const isImage = contentType.startsWith('image/');
      if (!isPdf && !isImage) {
        if (ev.replyToken) {
          await replyLineMessage(
            ctx.accessToken,
            ev.replyToken,
            '対応していない形式です（画像かPDFを送ってください）。',
          );
        }
        continue;
      }

      // 完全同一ファイルの重複弾き（SHA-256）。内容ベースでは弾かない
      const fileHash = crypto.createHash('sha256').update(buffer).digest('hex');
      const { data: dup } = await supabase
        .from('receipt_images')
        .select('id')
        .eq('image_sha256', fileHash)
        .limit(1);
      if (dup && dup.length > 0) {
        if (ev.replyToken)
          await replyLineMessage(ctx.accessToken, ev.replyToken, 'この画像は既に受信済みです。');
        continue;
      }

      // Storage に元ファイルを1回保存（キーに ":" "." は使えないため置換）
      const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
      const path = `receipts/${timestamp}_${messageId}${isPdf ? '.pdf' : ''}`;
      const { error: uploadError } = await supabase.storage
        .from('receipts')
        .upload(path, buffer, { contentType });
      if (uploadError) throw uploadError;

      const saveCtx = {
        messageId,
        path,
        contentType,
        clientId: client.id,
        clientName: client.official_name,
        officeId: ctx.officeId,
      };

      // 抽出（複数件）
      let doc: any;
      try {
        doc = await extractDocument(buffer, contentType, client.official_name);
      } catch (exErr) {
        console.error('Extraction error:', exErr);
        await saveUnprocessed(saveCtx, String(exErr));
        if (ev.replyToken) {
          await replyLineMessage(
            ctx.accessToken,
            ev.replyToken,
            'ファイルを受け取り保存しました。（解析でエラーが出たため後ほど再処理します）',
          );
        }
        continue;
      }

      const docType = typeof doc?.document_type === 'string' ? doc.document_type : null;

      // 通帳：取引明細を bank_transactions にまとめて保存
      if (docType === 'bankbook') {
        const txns: any[] = Array.isArray(doc?.transactions)
          ? doc.transactions.filter((t: any) => t && typeof t === 'object')
          : [];
        if (txns.length === 0) {
          await saveUnprocessed({ ...saveCtx, docType }, 'no_transactions_found');
          if (ev.replyToken) {
            await replyLineMessage(
              ctx.accessToken,
              ev.replyToken,
              '通帳から読み取れる取引明細が見つかりませんでした。',
            );
          }
          continue;
        }
        const { count, validation } = await saveBankTransactions(txns, {
          ...saveCtx,
          imageHash: fileHash,
          docType,
        });
        if (ev.replyToken) {
          const warn = validation.badLines.length
            ? `\n⚠️ ${validation.badLines.join(', ')}行目の残高が合いません（金額の誤読の可能性。要確認）`
            : '';
          const tally = await monthlyTallyLine(client.id);
          await replyLineMessage(
            ctx.accessToken,
            ev.replyToken,
            `通帳を登録しました（明細${count}件）${warn}${tally}`,
          );
        }
        continue;
      }

      // クレジットカード明細：利用明細を bank_transactions にまとめて保存（経費）
      if (docType === 'credit_card') {
        const txns: any[] = Array.isArray(doc?.transactions)
          ? doc.transactions.filter((t: any) => t && typeof t === 'object')
          : [];
        if (txns.length === 0) {
          await saveUnprocessed({ ...saveCtx, docType }, 'no_card_transactions_found');
          if (ev.replyToken) {
            await replyLineMessage(
              ctx.accessToken,
              ev.replyToken,
              'カード明細から読み取れる利用明細が見つかりませんでした。',
            );
          }
          continue;
        }
        const cardName = typeof doc?.card_name === 'string' ? doc.card_name : null;
        const { count, total } = await saveCardStatement(
          txns,
          { ...saveCtx, imageHash: fileHash, docType },
          cardName,
        );
        if (ev.replyToken) {
          const tally = await monthlyTallyLine(client.id);
          const head = cardName ? `カード明細（${cardName}）` : 'カード明細';
          await replyLineMessage(
            ctx.accessToken,
            ev.replyToken,
            `${head}を登録しました（${count}件・合計¥${total.toLocaleString()}）${tally}`,
          );
        }
        continue;
      }

      // レシート/領収書/請求書
      const receipts: any[] = Array.isArray(doc?.receipts)
        ? doc.receipts.filter((r: any) => r && typeof r === 'object')
        : [];

      if (receipts.length === 0) {
        await saveUnprocessed({ ...saveCtx, docType }, 'no_receipts_found');
        if (ev.replyToken) {
          await replyLineMessage(
            ctx.accessToken,
            ev.replyToken,
            '読み取れるレシート/領収書/請求書が見つかりませんでした。',
          );
        }
        continue;
      }

      // 各件を保存（ハッシュは代表1件のみに付与＝重複弾きは維持しつつ複数件を別レコード化）
      const summaries: string[] = [];
      for (let i = 0; i < receipts.length; i++) {
        const summary = await saveReceipt(receipts[i], {
          ...saveCtx,
          imageHash: i === 0 ? fileHash : null,
          docType,
        });
        summaries.push(summary);
      }

      if (ev.replyToken) {
        const head =
          receipts.length > 1 ? `登録しました（${receipts.length}件）\n` : '登録しました。\n';
        const tally = await monthlyTallyLine(client.id);
        await replyLineMessage(ctx.accessToken, ev.replyToken, head + summaries.join('\n') + tally);
      }
    } catch (err) {
      console.error('Event processing error:', err);
    }
  }
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'POST') {
    return res.status(405).send('Method Not Allowed');
  }

  try {
    const rawBody = await readRawBody(req);
    const signature = req.headers['x-line-signature'] as string | undefined;

    // 署名検証に使う事務所を特定するため、まず未検証のまま destination を読む。
    // （destination でチャネルを選び、その秘密で署名検証する＝偽造は秘密が無いと不可能）
    let destination: string | null = null;
    try {
      destination = JSON.parse(rawBody.toString('utf8'))?.destination ?? null;
    } catch {
      /* JSON でなければ destination なし→env にフォールバック */
    }
    const office = await findOfficeByDestination(destination);

    // 事務所ごとのトークンが DB にあればそれを、無ければ env を使う（検証中は env）
    const secret = office?.line_channel_secret || ENV_LINE_CHANNEL_SECRET;
    const accessToken = office?.line_channel_access_token || ENV_LINE_CHANNEL_ACCESS_TOKEN;

    if (!verifyLineSignature(rawBody, signature, secret)) {
      return res.status(401).send('Invalid signature');
    }

    // 200を即返し、保存処理は裏で最後までやりきる
    waitUntil(
      processWebhookEvents(rawBody.toString('utf8'), { accessToken, officeId: office?.id ?? null }),
    );
    return res.status(200).send('OK');
  } catch (err) {
    console.error('Webhook handler error', err);
    return res.status(500).send('Internal Server Error');
  }
}
