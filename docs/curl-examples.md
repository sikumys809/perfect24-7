# デバッグ用 curl コマンド集

開発時に API をテストするための curl コマンド例です。

## 環境変数の設定（まず実行）

```bash
export SUPABASE_URL="https://xxxxx.supabase.co"
export SUPABASE_KEY="xxxxx-service-key"
export LINE_WEBHOOK_URL="https://xxxxx.example.com/webhook" # ローカルトンネルの場合
```

---

## Enqueue Job

receipt_id をジョブキューに追加します。

```bash
RECEIPT_ID="550e8400-e29b-41d4-a716-446655440000"
curl -X POST \
  -H "Content-Type: application/json" \
  -H "apikey: $SUPABASE_KEY" \
  -d "{\"receipt_id\":\"$RECEIPT_ID\"}" \
  "$SUPABASE_URL/functions/v1/enqueueJob"
```

---

## LINE Webhook テスト（ローカル）

`ngrok` や `localtunnel` でローカルサーバーをトンネルして、実際の LINE からのテストイベントを受けます。

```bash
# 簡易テスト（署名検証を無効にしている場合）
curl -X POST \
  -H "Content-Type: application/json" \
  -d '{"events":[{"type":"message","message":{"type":"image","id":"100001"},"userId":"U1234567890abcdef","replyToken":"token"}]}' \
  "$LINE_WEBHOOK_URL/lineWebhook"
```

---

## Supabase RPC テスト

ジョブロック関数をテスト：

```bash
curl -X POST \
  -H "Content-Type: application/json" \
  -H "apikey: $SUPABASE_KEY" \
  -d '{}' \
  "$SUPABASE_URL/functions/v1/rpc?name=lock_next_processing_job"
```

---

## DB 直接確認（Supabase REST）

### users テーブル確認

```bash
curl -H "apikey: $SUPABASE_KEY" \
  "$SUPABASE_URL/rest/v1/users?select=*"
```

### receipts テーブル確認

```bash
curl -H "apikey: $SUPABASE_KEY" \
  "$SUPABASE_URL/rest/v1/receipts?select=*"
```

### processing_jobs ステータス確認

```bash
curl -H "apikey: $SUPABASE_KEY" \
  "$SUPABASE_URL/rest/v1/processing_jobs?select=*&status=eq.pending"
```

---

## ダミーデータ生成

```bash
npx ts-node scripts/seed-dummy-data.ts
```

---

## マイグレーション状態確認

```bash
npx ts-node scripts/check-migrations.ts
```
