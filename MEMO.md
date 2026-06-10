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

---

# 作業メモ（2026-06-10）— 引き継ぎ

## 今日完了したこと（すべて main に push 済み・Vercel 自動デプロイ済み）
- **通帳(bankbook)対応**：領収書/請求書/通帳 × 4入力モード（1枚写真 / 1枚に複数 / 1枚PDF / 複数枚PDF）を完成。通帳は `bank_transactions` テーブルに明細を行単位で保存（migration 004）
- **通帳の残高検算**：隣接行で「前残高 + 入金 − 出金 = 当残高」を検証し、合わない行を needs_review として記録＋LINE返信に「⚠️N行目の残高が合いません」。複写など低品質PDFの誤読検出用
- **顧問先登録**：`clients` テーブル新設（migration 005）。友達追加(follow)→登録案内、登録コード送信→LINE userIdを顧問先にひもづけ。登録済みのみ書類受付、`receipts.client_id` で自動ひもづけ。顧問先IDは自動採番(C-00001…)、1顧問先=1アカウント

## 確定した方針：製品化（マルチテナント）
- このサービスは**複数の税理士事務所向けに製品化**する。まず1事務所（森下敦史税理士事務所）で検証→検証後に事務所を増やす
- **A方式に確定**：事務所ごとにLINE公式アカウントを分け、webhookの `destination`（botのuserID）で事務所を振り分ける。webhook URLは全事務所共通の1エンドポイント。共通1botは情報漏洩・ブランディング・LINE上限共有の点で却下
- **効率方針**：検証も最初からマルチテナントの本番コードで動かす＝2社目は offices に1行INSERTするだけ、コード変更ゼロ
- **MVP割り切り**：新事務所登録は当面SQL直打ち（管理画面は事務所が増える直前）。トークンは検証中は平文DB保存、外部事務所を入れる直前に暗号化
- **LINE制約**：公式アカウント＋Messaging APIチャネルの新規作成はAPI不可＝手作業必須。トークン発行・webhook URL設定はAPIで自動化可。多数スケール時はLINE「Module」機能で認可式オンボーディングを検討

## 次にやること（ここから再開）
- **Phase 1（非破壊）**：`offices`テーブル新設、`clients.office_id`/`receipts.office_id`追加、今の事務所を office#1 登録＆既存データ紐づけ
- **Phase 2（振り分け）**：webhookで `destination`→事務所特定、署名検証・返信を事務所ごとのトークンで実行。env のトークンをDB管理へ移行
- office#1 作成に必要な `line_destination`（botのuserID）は、保存済みアクセストークンで `GET https://api.line.me/v2/bot/info` を叩けば取得できる

## 運用メモ
- 本番デプロイ：main へ push すると Vercel が自動デプロイ
- DBマイグレーション：`infra/migrations/*.sql` を Supabase SQL Editor に貼って手動適用（004・005は適用済み）
- 秘密情報は `.env`（gitignore済み）。`.env.example` はプレースホルダのみ

---
Generated on 2026-06-10
