# 作業メモ（2026-06-08）

## 完了したこと
- 開発環境の初期セットアップ（Node/TypeScript など）をリポジトリに整備
- GitHub への初回コミット（CI ワークフローは現在無効化）
- Supabase プロジェクトのセットアップ（DB スキーマ、`infra/migrations` の作成）
- Supabase Storage バケット `receipts` の準備（インフラ側で作成済み）
- LINE チャネル設定：Webhook URL を `https://jzvolsztklgyyyfedjwi.functions.supabase.co/lineWebhook` に設定、Webhook 利用を ON に変更
- Supabase CLI を用いて `LINE_CHANNEL_SECRET` と `LINE_CHANNEL_ACCESS_TOKEN` を `supabase secrets set --env-file .env.secrets` で登録（`.env.secrets` は `.gitignore` に追加し、登録後ローカルから削除）
- Edge Function（`lineWebhook`）のソースを作成・調整し、Deno 用 import としてデプロイ用に調整

## 未解決の問題
- Edge Function の実行時にタイムアウトが発生する（POST で 15s 後にタイムアウト）
- 一時的に `WORKER_RESOURCE_LIMIT` エラーが確認され、関数が外部から応答しない状態
  - 最小化したハンドラ（OK を返す簡易関数）や別名のテスト関数を作成・デプロイしても同様のタイムアウトが発生
  - ローカルでのデバッグではなく Supabase Edge Functions のランタイム側（リソース制限または一時障害）が原因である可能性が高い

## 次回の選択肢（優先順）
1. Supabase ダッシュボードの Functions ログを確認し、`WORKER_RESOURCE_LIMIT` やタイムアウトに関する詳細を取得する
2. しばらく待ってから再デプロイ／再試行（プラットフォームの一時障害の可能性）
3. （代替案）Vercel / Netlify / Heroku などの軽量なサーバレスプラットフォームへ webhook の受け口を一時移す
   - 迅速に稼働を再開したい場合はこの選択肢が最も確実
   - 後で Supabase 側の復旧後に処理を戻すことが可能

## 注意事項（今回の方針）
- 今日はここで区切る。これ以上の自動デプロイ試行や新規ファイルの大量生成は行わない。
- 次回はダッシュボードのログを確認した結果を共有してください。必要なら Supabase サポートへログ情報を添えて連絡する支援を行います。

---
Generated on 2026-06-08
