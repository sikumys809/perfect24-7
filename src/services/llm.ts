// LLM Vision API ラッパー（複数のLLMプロバイダに対応可能）

const LLM_API_KEY = process.env.LLM_API_KEY || '';
const LLM_PROVIDER = process.env.LLM_PROVIDER || 'openai'; // 例: openai, claude, gemini

interface ExtractedReceiptData {
  vendorName?: string;
  amount?: number;
  currency?: string;
  taxAmount?: number;
  totalAmount?: number;
  issuedDate?: string;
  description?: string;
  confidence?: number;
}

/**
 * 画像（Base64またはURL）をLLM Vision APIに送信し、領収書データを抽出する
 * 実装はプロバイダによって異なるため、ここは汎用インターフェースを提供します。
 */
export async function analyzeReceiptImage(imageBase64: string): Promise<ExtractedReceiptData> {
  if (LLM_PROVIDER === 'openai') {
    return analyzeWithOpenAI(imageBase64);
  } else if (LLM_PROVIDER === 'claude') {
    return analyzeWithClaude(imageBase64);
  } else if (LLM_PROVIDER === 'gemini') {
    return analyzeWithGemini(imageBase64);
  } else {
    throw new Error(`Unknown LLM provider: ${LLM_PROVIDER}`);
  }
}

async function analyzeWithOpenAI(imageBase64: string): Promise<ExtractedReceiptData> {
  const url = 'https://api.openai.com/v1/chat/completions';
  const payload = {
    model: 'gpt-4-vision-preview',
    messages: [
      {
        role: 'user',
        content: [
          {
            type: 'image_url',
            image_url: { url: `data:image/jpeg;base64,${imageBase64}` },
          },
          {
            type: 'text',
            text: `この画像は領収書や請求書です。以下の情報をJSON形式で抽出してください（わからない項目はnullで構いません）:
            - vendorName: 発行元・店舗名
            - amount: 金額（数値）
            - currency: 通貨コード（JPY等）
            - taxAmount: 税金額
            - totalAmount: 合計額
            - issuedDate: 発行日（YYYY-MM-DD形式）
            - description: その他の説明
            - confidence: 抽出精度（0-1）
            
            JSONのみを返してください。`,
          },
        ],
      },
    ],
    max_tokens: 500,
  };

  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${LLM_API_KEY}` },
    body: JSON.stringify(payload),
  });

  if (!res.ok) throw new Error(`OpenAI API error: ${res.status}`);
  const json = await res.json();
  const content = json.choices?.[0]?.message?.content;
  return content ? JSON.parse(content) : {};
}

async function analyzeWithClaude(imageBase64: string): Promise<ExtractedReceiptData> {
  // Claude 用の実装（プレースホルダ）
  // 実装は Claude API のドキュメントに従ってください
  throw new Error('Claude implementation pending');
}

async function analyzeWithGemini(imageBase64: string): Promise<ExtractedReceiptData> {
  // Gemini 用の実装（プレースホルダ）
  // 実装は Google AI ドキュメントに従ってください
  throw new Error('Gemini implementation pending');
}

export function imageToBase64(buffer: Buffer): string {
  return buffer.toString('base64');
}
