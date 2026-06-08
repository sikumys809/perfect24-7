# perfect24-7

このプロジェクトは、LINEで送られてくる領収書・請求書の画像を受け取り、必要な情報を抽出してデータベースに保存するサービスの骨組みを作るためのリポジトリです。

## 概要
- ユーザーがLINEに画像を送信すると、受信した画像をLLMのVision機能で解析し、請求金額・日付・発行元などのメタデータを抽出する。
- 抽出したデータはSupabase（Postgres）に保存し、必要に応じて検索や一覧表示を行う。
- Supabase Edge FunctionsやLINE Messaging APIを用いて、受信→処理→保存のワークフローを実装する予定です。

## 使用技術（予定）
- Supabase (Postgres + Auth + Storage)
- Supabase Edge Functions (受信処理や簡易API)
- LINE Messaging API (Webhookで画像受信)
- LLM Vision（画像解析／OCR補助）

## 前提 / 必要なもの
- Node.js（推奨バージョンをここに記載予定）
- Supabaseプロジェクト（URLとサービスキー）
- LINE Developersでのチャネル（チャネルアクセストークン・チャネルシークレット）
- LLM提供ベンダーのAPIキー（画像解析用）

## セットアップ手順（骨組み）
1. このリポジトリをクローンする
2. `.env.example` をコピーして `.env` を作成し、各種キーを設定する
	- `LINE_CHANNEL_ACCESS_TOKEN`, `LINE_CHANNEL_SECRET`, `SUPABASE_URL`, `SUPABASE_KEY`, `LLM_API_KEY`
3. 依存パッケージをインストールする（例: `npm install` または `pnpm install`）
4. Supabaseへのマイグレーションやテーブル準備（後で具体化）
5. 開発用サーバーやエッジ関数のローカル起動（後で記載）

## 開発の流れ（高レベル）
1. LINEからのWebhook受信（Edge Functionまたはサーバー）
2. 画像をSupabase Storageに保存
3. LLM Visionで画像解析を呼び出し、必要データを抽出
4. 抽出データをSupabase/Postgresに保存

## 今後の作業（優先度順）
1. データベーススキーマ設計
2. LINE Webhook受信の受け口（Edge Function）実装
3. 画像ストレージと解析ワークフロー実装
4. フロントエンド（管理画面）・検索機能

---

（注）この時点では実装はまだ行いません。まずは秘密情報の雛形と無視設定、ドキュメントの骨組みを整えました。
