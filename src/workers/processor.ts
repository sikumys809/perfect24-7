// ワーカー雛形（Node.js）
// 実運用では型定義やエラーハンドリング、監視を強化してください。

import { createClient } from '@supabase/supabase-js';

const SUPABASE_URL = process.env.SUPABASE_URL || '';
const SUPABASE_KEY = process.env.SUPABASE_KEY || '';

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

function sleep(ms: number) {
  return new Promise((res) => setTimeout(res, ms));
}

async function lockNextJob() {
  // この雛形は、infra/migrations/002_lock_function.sql で作成した
  // lock_next_processing_job() 関数を呼び出すことを前提としています。
  const { data, error } = await supabase.rpc('lock_next_processing_job');
  if (error) throw error;
  // RPC で戻る型は配列（SETOF）になるため、最初の要素を取り出します。
  return Array.isArray(data) && data.length > 0 ? data[0] : null;
}

async function processJob(job: any) {
  // ここに実際の処理を実装します。
  // 例:
  // - receipt_images から画像パスを取得
  // - 画像をダウンロードして LLM Vision / OCR に投げる
  // - 解析結果を extracted_fields に保存
  // - processing_jobs を done に更新
  console.log('Processing job', job.id);

  // ダミー処理（実装して置き換えてください）
  await sleep(1000);

  await supabase
    .from('processing_jobs')
    .update({ status: 'done', finished_at: new Date().toISOString() })
    .eq('id', job.id);
}

export async function startWorker() {
  console.log('Worker started');
  while (true) {
    try {
      const job = await lockNextJob();
      if (!job) {
        // 待機して再試行
        await sleep(2000);
        continue;
      }

      try {
        await processJob(job);
      } catch (procErr) {
        console.error('Job processing failed', procErr);
        // 失敗時は attempts を確認して再試行するか failed にするロジックを入れる
        await supabase
          .from('processing_jobs')
          .update({ status: 'failed', error: String(procErr), finished_at: new Date().toISOString() })
          .eq('id', job.id);
      }
    } catch (err) {
      console.error('Worker loop error', err);
      await sleep(5000);
    }
  }
}

// ローカルでテスト的に実行する場合
if (require.main === module) {
  startWorker().catch((e) => console.error(e));
}
