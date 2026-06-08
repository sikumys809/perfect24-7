# Edge Function / Webhook テスト手順

このドキュメントは `src/server/enqueueJob` と `src/server/lineWebhook` の雛形をローカルまたはデプロイ済みでテストする手順です。

1) Supabase Functions を使う場合（デプロイ済み）
- Enqueue (デプロイ先):

```bash
curl -X POST \
  -H "Content-Type: application/json" \
  -H "apikey: $SUPABASE_KEY" \
  -d '{"receipt_id":"<RECEIPT_UUID>"}' \
  "https://<project>.supabase.co/functions/v1/enqueueJob"
```

2) ローカルでテストする場合（簡易）
- Node で簡易サーバーを立てるか、Supabase CLI の `supabase functions serve` を使って関数をローカルで動かしてください。

3) LINE webhook テスト（ローカル）
- `src/server/lineWebhook` を受けるためにトンネリング（例: `ngrok`）を使い、LINE Developers の Webhook URL をローカルに向けます。
- テスト用のイベントは curl で送れます（署名検証を無効化している場合のみ簡易テスト可能）：

```bash
curl -X POST -H "Content-Type: application/json" -d '{"events": []}' https://<your-tunnel-url>/webhook
```

注意
- 本番環境では `X-Line-Signature` の検証を必ず実装してください。
- Supabase Functions と Edge Runtime の違いに注意し、ランタイムに応じてコードを調整してください。
