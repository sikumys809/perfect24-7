/**
 * レシート読み取りモデル比較ツール（使い捨ての評価用スクリプト）
 *
 * Supabase の receipts バケットに保存済みのレシート画像を、
 * Gemini 2.5 Flash / Gemini 2.5 Pro / Claude Opus 4.8 の3モデルに
 * 同じ抽出指示・同じJSONスキーマで投げ、結果を並べて表示する。
 *
 * 実行: npm run compare:receipts            （最新3枚を比較）
 *       npm run compare:receipts -- 5        （最新5枚）
 *       npm run compare:receipts -- receipts/xxx_123 receipts/yyy_456  （パス指定）
 *
 * 必要な環境変数（.env）:
 *   SUPABASE_URL, SUPABASE_KEY, ANTHROPIC_API_KEY, GEMINI_API_KEY
 *   （ANTHROPIC_API_KEY / GEMINI_API_KEY が無いモデルは自動スキップ）
 */
import 'dotenv/config';
import { createClient } from '@supabase/supabase-js';
import Anthropic from '@anthropic-ai/sdk';
import { GoogleGenAI } from '@google/genai';

const SUPABASE_URL = (process.env.SUPABASE_URL ?? '').replace(/\/rest\/v1\/?$/, '');
const SUPABASE_KEY = process.env.SUPABASE_KEY ?? '';
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY ?? '';
const GEMINI_API_KEY = process.env.GEMINI_API_KEY ?? '';

const BUCKET = 'receipts';
const PREFIX = 'receipts'; // バケット内のフォルダ（保存パスは receipts/<timestamp>_<id>）

// 全モデル共通の抽出指示。日本語レシート（税務用途）向け。
const PROMPT = `あなたは日本語のレシート・領収書を読み取る専門家です。
画像から以下の項目を抽出し、JSONだけを出力してください（前後の説明文やコードフェンスは不要）。

スキーマ:
{
  "date": "YYYY-MM-DD 形式の発行日。不明なら null",
  "vendor": "店名・会社名。不明なら null",
  "total_incl_tax": "税込合計金額（数値のみ、カンマ・円記号なし）。不明なら null",
  "tax_amount": "消費税額（数値のみ）。不明なら null",
  "tax_rate": "税率。\\"10%\\" / \\"8%\\" / \\"mixed\\"（複数税率） / null のいずれか",
  "registration_number": "インボイス登録番号（T + 13桁）。無ければ null",
  "note": "但し書き（例: お品代として）。無ければ null",
  "confidence": "抽出全体の自信度を 0〜1 の数値で"
}
読み取れない項目は推測せず null にしてください。
チェックボックスは実際に印（チェック）が付いているもののみ採用し、印刷された選択肢を勝手に選ばないでください。`;

type Row = { name: string };

function stripJson(text: string): string {
  // ```json ... ``` のフェンスや前後の余計な文字を除去
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fenced) return fenced[1].trim();
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  return start >= 0 && end > start ? text.slice(start, end + 1) : text.trim();
}

function safeParse(text: string): unknown {
  try {
    return JSON.parse(stripJson(text));
  } catch {
    return { _parse_error: true, raw: text.slice(0, 500) };
  }
}

// --- 各モデル呼び出し --------------------------------------------------------

async function runGemini(model: string, base64: string, mimeType: string) {
  const ai = new GoogleGenAI({ apiKey: GEMINI_API_KEY });
  const res = await ai.models.generateContent({
    model,
    contents: [
      {
        role: 'user',
        parts: [{ inlineData: { mimeType, data: base64 } }, { text: PROMPT }],
      },
    ],
    config: { responseMimeType: 'application/json' },
  });
  return safeParse(res.text ?? '');
}

async function runClaude(base64: string, mediaType: string) {
  const anthropic = new Anthropic({ apiKey: ANTHROPIC_API_KEY });
  const res = await anthropic.messages.create({
    model: 'claude-opus-4-8',
    max_tokens: 2000,
    messages: [
      {
        role: 'user',
        content: [
          {
            type: 'image',
            source: { type: 'base64', media_type: mediaType as any, data: base64 },
          },
          { type: 'text', text: PROMPT },
        ],
      },
    ],
  });
  const text = res.content
    .filter((b) => b.type === 'text')
    .map((b: any) => b.text)
    .join('');
  return safeParse(text);
}

// --- メイン ------------------------------------------------------------------

function normalizeMediaType(t: string | undefined): string {
  const allowed = ['image/jpeg', 'image/png', 'image/gif', 'image/webp'];
  return t && allowed.includes(t) ? t : 'image/jpeg';
}

async function resolvePaths(supabase: ReturnType<typeof createClient>, args: string[]): Promise<string[]> {
  // 引数がパス（receipts/ を含む）ならそれを使う
  const explicit = args.filter((a) => a.includes('/'));
  if (explicit.length) return explicit;

  // それ以外は枚数指定（デフォルト3）として最新N枚を取得
  const count = Number(args.find((a) => /^\d+$/.test(a))) || 3;
  const { data, error } = await supabase.storage
    .from(BUCKET)
    .list(PREFIX, { limit: count, sortBy: { column: 'created_at', order: 'desc' } });
  if (error) throw error;
  return ((data as Row[]) ?? []).map((f) => `${PREFIX}/${f.name}`);
}

async function main() {
  if (!SUPABASE_URL || !SUPABASE_KEY) {
    throw new Error('SUPABASE_URL / SUPABASE_KEY が未設定です（.env を確認）');
  }
  const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);
  const args = process.argv.slice(2);
  const paths = await resolvePaths(supabase, args);

  if (!paths.length) {
    console.log('比較対象のレシート画像が見つかりませんでした。');
    return;
  }

  const models: { label: string; run: (b: string, m: string) => Promise<unknown> }[] = [];
  if (GEMINI_API_KEY) {
    models.push({ label: 'Gemini 2.5 Flash', run: (b, m) => runGemini('gemini-2.5-flash', b, m) });
    models.push({ label: 'Gemini 2.5 Pro', run: (b, m) => runGemini('gemini-2.5-pro', b, m) });
  } else {
    console.log('⚠️  GEMINI_API_KEY 未設定 → Gemini をスキップ');
  }
  if (ANTHROPIC_API_KEY) {
    models.push({ label: 'Claude Opus 4.8', run: (b, m) => runClaude(b, normalizeMediaType(m)) });
  } else {
    console.log('⚠️  ANTHROPIC_API_KEY 未設定 → Claude をスキップ');
  }
  if (!models.length) throw new Error('API キーが1つも設定されていません。');

  console.log(`\n比較対象 ${paths.length} 枚 × ${models.length} モデル\n`);

  for (const path of paths) {
    console.log('='.repeat(80));
    console.log(`📄 ${path}`);
    console.log('='.repeat(80));

    const { data: blob, error } = await supabase.storage.from(BUCKET).download(path);
    if (error || !blob) {
      console.log(`  ダウンロード失敗: ${error?.message}`);
      continue;
    }
    const buf = Buffer.from(await blob.arrayBuffer());
    const base64 = buf.toString('base64');
    const mimeType = normalizeMediaType((blob as Blob).type);

    for (const model of models) {
      const t0 = Date.now();
      try {
        const result = await model.run(base64, mimeType);
        const ms = Date.now() - t0;
        console.log(`\n--- ${model.label}  (${ms}ms) ---`);
        console.log(JSON.stringify(result, null, 2));
      } catch (err) {
        console.log(`\n--- ${model.label}  (ERROR) ---`);
        console.log(`  ${(err as Error).message}`);
      }
    }
    console.log('');
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
