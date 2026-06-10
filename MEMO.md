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

---

# 作業メモ（2026-06-10 続き）— マルチテナント Phase 1+2 実装

## 今日実装したこと（コードは main にコミット済み・**マイグレーション未適用**）
- **Phase 1（非破壊・migration 006/007）**
  - `offices` テーブル新設（`office_code` 自動採番 O-001…、`name`、`line_destination`、`line_channel_secret`/`line_channel_access_token`（検証中NULL）、`is_active`）
  - `clients.office_id`（ON DELETE CASCADE）/ `receipts.office_id`（ON DELETE SET NULL）追加
  - 007 で森下敦史税理士事務所を office#1 登録（`line_destination` = `U50dbe9322ddef634d7883912ab7b6c20`、`GET /v2/bot/info` で取得済）＋既存 clients/receipts を backfill。冪等
- **Phase 2（振り分け・api/line-webhook.ts）**
  - webhook の `destination`（botのuserID）→ `offices` 引き当て → その事務所のチャネル秘密で署名検証、トークンで返信
  - 顧問先の引き当て・登録コード照合を事務所スコープに限定（マルチテナント分離）
  - receipts/bank_transactions に `office_id` を付与
  - **完全後方互換**：`offices` 行が無い／未解決なら env のトークンで従来どおり単一事務所動作（`office_id` 列は付けない）。よってマイグレーション未適用でも本番は壊れない
  - 事務所トークンは DB にあれば優先・無ければ env フォールバック（＝Phase 2の「env→DB移行」は DB に値を入れた時点で自動的に切替）

## 次にやること（ここから再開）
- **マイグレーション適用**：Supabase SQL Editor で `006_offices.sql` → `007_seed_office_1.sql` の順に実行（適用後、PostgREST のスキーマキャッシュ反映を待つ）
- 適用後、LINE で実機テスト（友達追加→登録コード→領収書/通帳送信）して office_id が付くか確認
- 事務所トークンの DB 移行（検証が落ち着いたら office#1 の secret/token を offices に投入し、env 依存をなくす）。外部事務所を入れる直前に暗号化
- 2社目の追加手順：LINE公式アカウント＋Messaging APIチャネルを手作業作成 → `GET /v2/bot/info` で destination 取得 → `offices` に1行 INSERT（コード変更ゼロ）

## 運用メモ（追加）
- DBマイグレーション適用状況：001〜005 適用済み、**006・007 も適用済み**（Supabase SQL Editorで実行・成功確認）
- office#1 の line_destination 取得は `.env` のアクセストークンで `curl GET https://api.line.me/v2/bot/info`（displayName=森下敦史税理士事務所 を確認済）
- 本番ドメイン：**https://perfect24-7.vercel.app**（webhook=/api/line-webhook はPOST専用）

---
Generated on 2026-06-10

---

# 作業メモ（2026-06-10 続き2）— 税理士デモ向け作り込み

## 今日さらに実装（すべて main に push 済み・本番反映）
- **事務所ダッシュボード `/api/dashboard`**（読み取り専用）：LINEで届いた書類をカード一覧（サムネ＝署名URL／取引先・日付・金額・手数料・税・登録番号・顧問先・⚠️要確認＋検算メモ）。通帳はカード内に明細テーブル。20秒オートリフレッシュ。
  - **絞り込み**：種別タブ（領収書/請求書/通帳・件数付き）／顧問先ドロップダウン／取引先テキスト検索。フィルタはURLパラメータで自動更新後も維持。
  - 解析できた書類だけ表示（未処理・空カードは非表示。`?all=1`で全件）。
  - **簡易認証**：env `DASHBOARD_KEY` 設定時は `?key=` 必須。未設定なら公開（デモ用）。**外部に渡すなら必ず設定すること**。
- **CSVエクスポート `/api/export`**：ダッシュボードと同じ絞り込みで証憑をCSV出力（BOM付き＝Excel文字化けなし）。「会計ソフトに取り込む」導線。`type=bankbook` は通帳明細を行単位で出力。
- **抽出精度の改善**：
  - 振込金受取書など「主金額＋手数料」併記書類で手数料を合計に誤選択する問題を修正（`fee`フィールド追加・主金額をtotalに）。
  - 分類プロンプト強化：交通費/タクシー/駐車場/ICチャージ/振込受取書等を `other` ではなく `receipt` に寄せる（※既存の古いレコードは other のまま。新規送信に効く）。
- **回収率の堀（即時フィードバック）**：送信時のLINE返信に「📥 今月N件目・累計¥X」を付与（顧問先が送り続ける動機。集計失敗は無視して本処理継続）。

## デモの状態（明日）
- 流れ：ダッシュボードを開く→LINEで撮って送る→数秒で返信「登録しました…📥今月N件目」→ページ自動更新でカード追加→CSVダウンロードで会計ソフト取込を見せる。
- 注意：DBに古いテストデータ（顧問先=株式会社テスト商事 C-00001、その他分類多数）が残存。当日は顧問先フィルタ／種別タブ／新規送信で綺麗に見せる。データ全消しはユーザー判断で保留中。

## 次の候補（未着手・優先順は要相談）
- 事務所が「確認済み」をワンタップで付けるUI（要 書き込み＋認証。Phase 2 人チェック工程の核）
- 古いテストデータのクリーンアップ（破棄するなら要バックアップ確認）
- 正解付き回帰テスト集（プロンプト変更の安全網。ユーザーは「後回し」と明言）
- 事務所トークンのDB移行＋暗号化、2社目オンボーディング手順

*Generated on 2026-06-10*
