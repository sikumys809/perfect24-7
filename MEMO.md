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

## 売上/経費機能（2026-06-10 続き3・本番稼働）
- 同じ請求書/領収書でも **顧問先が発行=売上(sales) / 受領=経費(expense)** を自動判定。顧問先名を抽出プロンプトに渡しモデルが判定、不明時は発行元/宛名と顧問先名の一致でフォールバック＋⚠️要確認。migration 008（receipts.direction）適用済。
- ダッシュボード: 売上/経費バッジ・タブ・当月の売上/経費合計。取引先＝相手方（売上は宛名＝顧客、経費は発行元）。CSVに「売上経費/発行元/宛名」列。
- **⚠️オンボーディング要件（重要）**: 売上/経費判定は `clients.official_name` が実会社名と一致していることが前提。ダミー名（例:「株式会社テスト商事」）だと発行元と一致せず売上を経費に誤分類する。**新顧問先登録時は official_name に正式名称を正確に入れること。**
- 検証メモ: テスト顧問先C-00001を実名「株式会社シクミーズ」に修正→シクミーズ発行の請求書3件が正しく売上に。判定ロジック自体は正しく動作。

## 書類種別の拡張（2026-06-10 続き4・本番稼働）
決算のために顧問先が送る書類をほぼ網羅。実装は既存2パターン（単一金額型＝領収書 / 明細行型）の再利用が基本。
- **クレジットカード明細**（credit_card）: 通帳と同じ bank_transactions を再利用（移行不要）。利用金額=withdrawal、経費。
- **税金・社保の納付書/領収証書**（tax_payment）: 領収書型を再利用（移行不要）。tax_kind(税目)/period(対象期間)、経費。返信【納付】税目。
- **残高証明書**（balance_certificate）: 領収書型を再利用（移行不要）。口座ごと1件、direction=null（B/S項目）。返信【残高】。
- **棚卸表**（inventory）/ **借入金返済予定表**（loan_schedule）: 列構成が独自なので **document_lines テーブル新設（migration 009・適用済）**。inventory=品名/数量/単価/金額・total=期末在庫金額、loan=返済日/元金/利息/残高。direction=null。
- **給与明細(payslip)/賃金台帳(wage_ledger)**: 人件費の仕訳直結。専用テーブル **payroll_lines（migration 010・適用済）** に従業員行（総支給/健保/厚年/雇用/源泉/住民税/その他控除/控除合計/差引）。給与明細=1行、賃金台帳=複数行。direction=経費、total=総支給合計。検算: 総支給-控除合計=差引／控除内訳合計=控除合計。
- 数表の手書き誤読対策: 返済予定表(返済額=元金+利息／前残高-元金=当残高)・棚卸(数量×単価=金額)・給与(上記)の検算で不整合行を要確認。プロンプトも手書きは推測で埋めず confidence を下げる方針を明記。
- **固定資産(fixed_asset)/EC入金(ec_payout)/小口現金出納帳(petty_cash)**: いずれもマイグレーション不要（既存パターン再利用）。
  - petty_cash = 通帳と同じ bank_transactions（saveBankTransactions を docType 引数化して再利用）。残高検算あり。
  - fixed_asset = 領収書型再利用。資産名/区分/耐用年数/取得価額、direction=null（資産計上で経費でない）。返信【資産】。
  - ec_payout = 領収書型再利用。総売上=total/手数料=fee/入金額=net_amount、direction=売上、vendor=プラットフォーム名。
  - ⚠️実機未検証（コミット bd9cd8f でpush・本番反映済だが、実際の固定資産/EC/小口現金の書類でまだテストしていない）。
- 全種別: ダッシュボードに種別タブ＋専用テーブル表示、CSVは種別ごとに明細/書類レベルで出力。document_type 一覧: receipt/invoice/bankbook/credit_card/tax_payment/balance_certificate/inventory/loan_schedule/payslip/wage_ledger/fixed_asset/ec_payout/petty_cash/other。明細系の表示判定(isMeaningful)は明細行(bank_transactions/document_lines/payroll_lines)の有無も見る（dashboard/export両方）。
- 設計指針（ユーザー方針）: サービスの核は「顧問先は楽・事務所はLINEのデータを管理画面→会計ソフトにアップロード」。余計なものは足さず、痒いところ（=決算書類の網羅・種別フィルタ）は完璧に。

## 次の候補（未着手・優先順は要相談）
- 事務所が「確認済み」をワンタップで付けるUI（要 書き込み＋認証。Phase 2 人チェック工程の核）
- 古いテストデータのクリーンアップ（破棄するなら要バックアップ確認）
- 正解付き回帰テスト集（プロンプト変更の安全網。ユーザーは「後回し」と明言）
- 事務所トークンのDB移行＋暗号化、2社目オンボーディング手順

*Generated on 2026-06-10*

---

# 作業メモ（2026-06-12）— 引き継ぎ（MacBook Pro → Mac Studio へ戻る）

> このセッションは MacBook Pro。**次回は Mac Studio で再開**。すべて main に push 済み・Vercel 本番反映済み。
> マイグレーション **011→012→013 は本番Supabaseに適用済み**（動作確認済み）。

## 今日やったこと（税理士フィードバック対応 → 顧問先ダッシュまで）
1. **勘定科目の自動付与＋修正**（migration 011）: 標準科目マスタ `account_titles`（約50科目・BS/PL区分・貸借区分）を新設。書類受信時に科目を自動付与（モデル提案＋種別/キーワード規則）。`receipts.account_code`/`payment_account_code`/`account_source` 追加。012で既存データへ保守的に backfill。
2. **書類の編集画面** `/api/edit`: 科目・相手科目・売上経費・日付・税込金額・**消費税額・税率・インボイス登録番号・番号・手数料**・取引先・摘要・確認済みを修正可。保存で `account_source='manual'`。ダッシュボードのカードに「✎編集」リンク＋科目バッジ（自動=青/手修正=緑）。
3. **月次試算表(BS/PL)＋総勘定元帳** `/api/reports?view=trial|ledger&month=YYYY-MM&client=`: 受信書類に付けた科目から**簡易複式の仕訳をその場で導出**して集計。各仕訳は貸借一致＝「借方合計=貸方合計」が整合チェック。期首残高なし＝BSは均衡しない旨を明記。
4. **税込/税抜 経理方式**（migration 013）: `clients.tax_accounting`（inclusive/exclusive・既定inclusive）＋ `offices.default_tax_accounting`。reports のヘッダーで顧問先ごとに切替（`/api/settings` がPOSTで保存）。税抜は仮払/仮受消費税(1080/2080)を分離。**保存は税込合計＋税額のまま、レポート側で都度導出 → 方式切替に再取込不要**。
5. **顧問先ダッシュ** `/api/my`（**登録コードでログイン**）: 自分の書類だけ表示（client_idで厳格に絞る）。Cookieは `SUPABASE_KEY` でHMAC署名（HttpOnly/Secure）＝偽造不可。登録コードは正規化（全角→半角・空白/ハイフン除去）。
6. **顧問先ダッシュに「経営の見える化（参考値）」**: 今月の売上/経費/利益・**今月の経費の科目別内訳**・**直近6ヶ月の推移**。税込概算・「正式な試算表は事務所に」と注記。損益対象は receipt/invoice/tax_payment/ec_payout/payslip/wage_ledger（通帳・カード・固定資産は除外）。

## ⚠️ 重要な技術的ハマり（次回も必ず踏む）
- **Vercel: `api/` 内のファイル相互 import は実行時に解決されない。** この設定（vercel.json で buildCommand=echo・outputDirectory=public）では各 `.ts` が個別トランスパイルされ兄弟ファイルがバンドルされない。共有モジュール（`api/_lib/...` も `api/lib/...` も）を import すると **FUNCTION_INVOCATION_FAILED でデプロイ後にクラッシュ**する。dashboard だけ無傷だったのは唯一 import していなかったから。
  - **対策＝各エンドポイントに会計ロジックをインライン**（loadAccounts/autoAccount/deriveEntries を edit・reports・line-webhook に複製）。共有したくなっても今の構成では不可。変える場合はバンドル方式の見直しが要る。
- **Vercel が push を時々取りこぼす**（連続 push 時に最新コミットが反映されないことがあった）。数分待っても反映されなければ **空コミット `git commit --allow-empty` で再トリガー**すると直る。コード側の問題ではない。
- 認証なし500 注意: dashboard/reports/edit/export は新カラムを直接 select するので、**マイグレ未適用だと500**。webhook 側は try/catch で握りつぶし済み。

## 本番URL・アクセス
- 事務所ダッシュ: `/api/dashboard`（ヘッダーに📊試算表・📒総勘定元帳リンク）
- 試算表/元帳: `/api/reports`、CSV: `/api/export`、書類編集: `/api/edit`、設定: `/api/settings`
- **顧問先ダッシュ: https://perfect24-7.vercel.app/api/my** （登録コードを入力。例: C-00001=シクミーズ の code は `E824BB`）
- Serverless Function 数 = 7（Hobby上限12内）
- `DASHBOARD_KEY` は未設定のまま（事務所側は誰でも閲覧可）。外部に渡す前に必須設定。

## 戦略メモ（今日の気づき）
- 顧問先が自社の数字を見られる＝事業骨子の「二段ロケット②（可視化で単価UP）」。**事務所が顧問料で提供＝直販ではない**ので戦略に抵触しない。二重ロックが深まる。
- ただし「**freee不要**」と言い切るのは危険: ①データ完全性（今はLINEで送った分だけ。通帳が写真ベース＝全取引は拾えない）②freeeは申告・請求書発行・給与計算もやる ③精度・期待値（議事録の急所）。→ **当面は「おまけの見える化」、"freee代替"はデータ完全性が上がってからの本命**、という二段構え。

## 再開ポイント（Mac Studio で）
- 実機で `/api/my` の経営パネルの見え方・数値バランスを確認（調整候補: 科目の出し方・税抜表示切替・期間フィルタ）。
- 読み取り精度の作り込み（手書き等）は引き続き「後回し」（ユーザー方針）。
- 候補: 顧問先が毎回コード入力せず済むリンク（LINEリッチメニューに `/api/my`）、事務所「確認済み」ワンタップ、固定資産/EC入金/小口現金の実機検証（前回からの宿題）、`DASHBOARD_KEY` 設定。

*Generated on 2026-06-12*

---

# 作業メモ（2026-06-12 続き）— 管理画面からのアップロード

## 実装（main push 済み・本番反映・実機検証済み）
- **`/api/upload`**：顧問先ダッシュ(/api/my)からのファイルアップロード受け口。LINEと同じ抽出パイプライン（全14書類種別・科目付与・検算）を **line-webhook.ts からインライン複製**（Vercelの相互import不可制約のため。⚠️**変更時は line-webhook.ts と upload.ts の両方を直す**）。認証は /api/my と同じ署名付きCookie。リクエストは JSON `{filename, contentType, dataBase64}`、重複はSHA-256で弾く。
- **/api/my にハイブリッドUI**：大きなドロップゾーン＋12カテゴリのタイル（領収書/請求書/通帳/カード明細/給与明細/納付書/固定資産/EC入金/小口現金/棚卸表/返済予定表/残高証明）。種別は裏でAI自動判別、タイルはクリックでもアップ可。アップ後トースト→自動リロード。
- **制約**：クライアント側で **3MB上限**（base64×Vercel 4.5MBボディ制限のため）。超過は「LINEで送って」と誘導。大きいPDFはLINE経由（既存の60s/サイズ制約と同じ）。
- 検証：ログイン→アップローダー表示→1x1pngで pipeline 完走（auth/storage/抽出/保存）を確認。Serverless Function 数 = **8**（Hobby上限12内）。

## 重要：共有import問題の確証（今回プローブで確定）
- `lib/` （api/の外）からの import も **FUNCTION_INVOCATION_FAILED** で失敗を実機確認。この構成では共有モジュール化は不可。**会計/抽出ロジックは各エンドポイントにインライン複製が唯一の方法**。将来直すならビルド方式（bundling）の見直しが要る。
- ※npm パッケージ（@supabase/supabase-js, @anthropic-ai/sdk, **pdf-lib**）は問題なくバンドルされる。落ちるのは「自前の相対 import」だけ。

## 大きいファイル対応（2026-06-12 続き・本番検証済み）
- **① 直アップロード（転送3MB→20MB）**: `/api/upload-url` が署名付きアップロードURLを発行→ブラウザがSupabase Storageへ**直接PUT**（Vercelボディ4.5MB上限を回避）→`/api/upload`にpath+署名を渡す。pathはclientIdとHMAC署名し他人ファイル処理を防止。画像は送信前にブラウザでcanvas縮小(2200px/JPEG0.85)＝Claude5MB制限・速度・コスト対策。サーバ側20MBガード。Function数=10。
- **②-2 巨大PDF（ページ分割→並列抽出→マージ）**: 5ページ超のPDFは3ページずつ分割し各チャンクを並列Claude抽出、最多の document_type で配列(transactions/lines/receipts)を連結し1書類に統合。時間(60s)＋出力トークン(途中切れ)の両壁を回避。`extractDocumentMerged` を line-webhook/upload 両方にインライン、外側呼び出しのみ差し替え（画像・4ページ以下・分割失敗は従来どおり1回）。同時実行5。
  - **残課題（②-3）**: 40ページ超など極端に大きいPDFは並列でも60sを超え得る（真の非同期化=Cron/キューが必要）。通帳明細・賃金台帳・レシート束の現実的サイズはカバー済み。
  - 注意: 多ページに渡る「1枚の請求書」を>4ページで分割すると各チャンクが別レコード化し得る（稀）。閾値5ページで通常文書は保護。

## CSV全ジャンルZIP（2026-06-12 続き・本番検証済み）
- 旧: 「すべて」DLが単一金額型(領収書等)のみで、通帳/カード/給与/賃金台帳/棚卸/返済表/小口現金が漏れていた。
- 新: `/api/export` は**種別未選択(すべて)なら全ジャンルのCSVをZIP**で返す（documents.csv/bankbook.csv/petty_cash.csv/credit_card.csv/payroll.csv/inventory.csv/loan_schedule.csv＋README.txt、データのあるものだけ同梱）。列構成がジャンルで違うのでファイル分け。種別タブ選択時は従来どおり単一CSV。jszip 追加（npmパッケージなのでバンドルOK）。ダッシュのボタン表記も「全ジャンルCSV（ZIP）」に切替。
- 注意: Vercelのデプロイ伝播ラグでpush直後はエッジ間で新旧が混在することがある（数回リロードで安定）。

## 顧問先による内容修正（2026-06-12 続き・本番検証済み・相互扶助）
- 顧問先ダッシュ(/api/my)から、自分の書類の**事実項目のみ**修正可: 取引先・日付・税込金額・消費税・但し書き。**勘定科目・売上経費の最終判定・確認済みは事務所専用**（仕分け=税理士の判断）。明細行型(通帳/給与等)は対象外。
- 実装: /api/my に GET `?edit=<id>`(編集フォーム)＋ POST `action=edit`(保存)。新規Function不要。署名Cookie＋`receipts.client_id===session`で本人の書類のみ（他人IDはリダイレクト）。
- 修正は extracted_fields に `source=client`、`client_edited`=JST時刻を記録。事務所ダッシュに緑「顧問先修正」バッジ。金額編集時 amount=税込−消費税 を再計算。
- 設計: 「顧問先=事実を直す／事務所=判断を持つ」。顧問先が直すほど事務所が楽＝回収率・二重ロックを深める相互扶助。

## 基本情報＋OTPログイン（2026-06-12 続き・本番検証済み）
- **migration 014適用済**: clients に trade_name/contact_name/email/phone/fiscal_start_month/fiscal_end_month(決算月)＋OTP用(otp_code/otp_expires/otp_attempts)。
- **基本情報編集(P1)**: 顧問先側 /api/my?info=1（本人のみ）／事務所側 /api/dashboard?view=clients（保存は /api/settings の action=saveinfo）。両方で会社名/屋号/担当/email/携帯/期首期末を編集。
- **OTPログイン(P3・本番稼働)**: 「コードだけログイン」を廃止。登録コード入力→そのLINEに6桁OTPプッシュ(5分)→OTP入力でCookie。コード→OTPはHMAC署名トークン(client_id+期限)で受け渡し。試行5回で無効化・再送あり。LINEプッシュは事務所トークン→env(LINE_CHANNEL_ACCESS_TOKEN)フォールバック。**LINE未連携のコードは拒否**（OTP届かないため）。
- **LIFF自己登録(P2・実装済/実機テスト待ち)**: LINEログインチャネル(ID 2010381130)＋LIFF(`2010381130-ZERK9yVI`)。`/api/register` GET=LIFFフォーム(会社名/屋号/担当/email/携帯/期首期末)、POST=登録。LIFF id_token をサーバ検証(client_id=2010381130)し本物のuserId取得→client作成・LINE紐付け→登録コードをLINEプッシュ。既存userIdは更新(重複作成しない)。webhook follow/未登録時の返信を LIFF ボタンに変更。LIFF_ID は env 上書き可。
  - **⚠️重要な検証ポイント**: LINEログインチャネルが Messaging API と**同一プロバイダー**(パーフェクト24/7)ならLINE userIDが一致し、mizuno が登録すると既存シクミーズ(linked_line_user_id=U01bf...)を**更新**する。別プロバイダーだとuserIDが違い**新規重複clientが作られる**→その場合はチャネルを同一プロバイダーで作り直す。
  - 実機テスト: LINEで `https://liff.line.me/2010381130-ZERK9yVI` を開く（or bot を一度ブロック→再追加でボタン表示）→フォーム送信→コードがLINEに届くか＋重複clientが出ないか確認。
  - これで P1(基本情報)＋P2(自己登録)＋P3(OTPログイン) のオンボーディング一式が完成。

*Generated on 2026-06-12*
