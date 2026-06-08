# DB スキーマ設計（草案）

このドキュメントは、領収書・請求書画像を受け取り解析した結果を保存するための Supabase(Postgres) 向けスキーマ草案です。

## 概要（日本語一言）
- 受信した画像と抽出したデータを関連付けて保存します。

## ER 概要
- users 1---* receipts
- receipts 1---* receipt_images
- receipts *---1 vendors
- receipts 1---* extracted_fields
- receipts 1---* processing_jobs

---

## テーブル定義（Postgres SQL）

-- users: LINE ユーザー情報
CREATE TABLE IF NOT EXISTS users (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  line_user_id text UNIQUE,
  display_name text,
  avatar_url text,
  email text,
  created_at timestamptz DEFAULT now()
);

-- vendors: 発行元（任意）
CREATE TABLE IF NOT EXISTS vendors (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL,
  address text,
  tax_id text,
  created_at timestamptz DEFAULT now()
);

-- receipts: 抽出した請求書/領収書のメタデータ
CREATE TABLE IF NOT EXISTS receipts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid REFERENCES users(id) ON DELETE SET NULL,
  vendor_id uuid REFERENCES vendors(id) ON DELETE SET NULL,
  original_filename text,
  amount numeric,
  currency varchar(8) DEFAULT 'JPY',
  tax_amount numeric,
  total_amount numeric,
  issued_date date,
  detected_date timestamptz DEFAULT now(),
  description text,
  source text, -- 例: LINE, upload, api
  created_at timestamptz DEFAULT now()
);

-- receipt_images: 実際の画像ファイル（Supabase Storage のパスを格納）
CREATE TABLE IF NOT EXISTS receipt_images (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  receipt_id uuid REFERENCES receipts(id) ON DELETE CASCADE,
  storage_path text NOT NULL,
  content_type text,
  size_bytes bigint,
  width int,
  height int,
  uploaded_at timestamptz DEFAULT now()
);

-- extracted_fields: LLM/解析で得た個々のフィールド（正規化前／別ソース保持可）
CREATE TABLE IF NOT EXISTS extracted_fields (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  receipt_id uuid REFERENCES receipts(id) ON DELETE CASCADE,
  field_name text NOT NULL,
  field_value text,
  confidence numeric, -- 0.0 - 1.0
  source text, -- 例: ocr, llm, manual
  created_at timestamptz DEFAULT now()
);

-- processing_jobs: 画像解析や後処理のジョブ管理
CREATE TABLE IF NOT EXISTS processing_jobs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  receipt_id uuid REFERENCES receipts(id) ON DELETE CASCADE,
  status text NOT NULL DEFAULT 'pending', -- pending, processing, done, failed
  attempts int DEFAULT 0,
  error text,
  queued_at timestamptz DEFAULT now(),
  started_at timestamptz,
  finished_at timestamptz
);

-- line_events: LINE からの受信イベントログ（デバッグ用）
CREATE TABLE IF NOT EXISTS line_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  line_event_id text UNIQUE,
  user_id uuid REFERENCES users(id) ON DELETE SET NULL,
  event_type text,
  raw_payload jsonb,
  received_at timestamptz DEFAULT now()
);

-- インデックス例
CREATE INDEX IF NOT EXISTS idx_receipts_user_id ON receipts(user_id);
CREATE INDEX IF NOT EXISTS idx_receipts_issued_date ON receipts(issued_date);

---

## 備考・運用メモ
- Supabase の SQL エディタに貼るか、`infra/migrations` にマイグレーションファイルを作成する予定です。
- セキュリティ: Supabase のサービスキーは安全に管理し、公開クライアントキーと混同しないこと。
- 将来的には `extracted_fields` を正規化して `amounts` や `dates` 等の専用カラムを増やすことを検討します。

