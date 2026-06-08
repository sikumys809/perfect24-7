# processing_jobs ワークフロー設計

目的：`processing_jobs` テーブルを中心に、画像解析ジョブの発行・取得・再試行・監視を行うワークフロー設計。

1) ジョブの作成
- 画像保存処理が終わったら `processing_jobs` に `receipt_id` を指定して `status='pending'` のジョブを作成する。

2) ジョブの取得（ワーカー側）
- 競合を避けるため、ワーカーはトランザクション内で以下のようにジョブを取得してロックする。

```sql
-- 1件取得して processing に移す例
WITH c AS (
  SELECT id FROM processing_jobs
  WHERE status = 'pending'
  ORDER BY queued_at
  LIMIT 1
  FOR UPDATE SKIP LOCKED
)
UPDATE processing_jobs
SET status = 'processing', started_at = now(), attempts = attempts + 1
FROM c
WHERE processing_jobs.id = c.id
RETURNING processing_jobs.*;
```

- 取得結果が空なら待機または終了。

3) 処理と結果保存
- ワーカーは画像をSupabase Storageから取得して、LLM VisionやOCRに投げて解析する。
- 解析結果は `extracted_fields` に INSERT または UPDATE する。
- 成功したら `processing_jobs` の `status='done'`, `finished_at=now()` を更新する。

4) 失敗と再試行
- 失敗時は `error` を記録し `status='pending'` に戻すか `failed` にする。
- 再試行ポリシー例：最大 `max_attempts=5`、指数バックオフ（queued_at を次回試行時刻に更新）

5) 可観測性と通知
- 失敗頻度や平均処理時間を指標化する。
- 長時間 `processing` のままのジョブを検出する監視（例: started_at が古い場合は再割当）を入れる。

6) 実行形態の選択肢
- 常駐ワーカー（Node.js サービス / Docker コンテナ）
- サーバーレスワーカー（短いジョブであれば定期的に Edge Function を呼ぶ）
- 外部キュー（RabbitMQ / Redis Queue / Bull）を導入してスケーラブルにする

7) idempotency（冪等性）
- 同じ `receipt_id` に対する重複処理を避けるため、ジョブ作成時に重複チェックを行う。

8) セキュリティと権限
- Supabase のサービスキーはワーカーのみが持つ。クライアントには公開キーを使用。

---

次の実装候補：
- ワーカーの雛形コード（処理ループ＋ジョブ取得ロジック）を作成しますか？
- Supabase Edge Function からジョブを enqueue するサンプルを作りますか？
