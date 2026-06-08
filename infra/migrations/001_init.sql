-- 001_init.sql
-- 初期テーブル定義（Supabase / Postgres 用）

-- 拡張機能（UUID 生成）
CREATE EXTENSION IF NOT EXISTS "pgcrypto";

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
  source text,
  created_at timestamptz DEFAULT now()
);

-- receipt_images: 画像ファイル情報（Supabase Storage のパス）
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

-- extracted_fields: 解析で得たフィールド
CREATE TABLE IF NOT EXISTS extracted_fields (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  receipt_id uuid REFERENCES receipts(id) ON DELETE CASCADE,
  field_name text NOT NULL,
  field_value text,
  confidence numeric,
  source text,
  created_at timestamptz DEFAULT now()
);

-- processing_jobs: 画像解析/後処理のジョブ管理
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

-- line_events: LINE 受信イベントログ
CREATE TABLE IF NOT EXISTS line_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  line_event_id text UNIQUE,
  user_id uuid REFERENCES users(id) ON DELETE SET NULL,
  event_type text,
  raw_payload jsonb,
  received_at timestamptz DEFAULT now()
);

-- インデックス
CREATE INDEX IF NOT EXISTS idx_receipts_user_id ON receipts(user_id);
CREATE INDEX IF NOT EXISTS idx_receipts_issued_date ON receipts(issued_date);
CREATE INDEX IF NOT EXISTS idx_processing_jobs_status ON processing_jobs(status);
