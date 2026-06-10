-- 006_offices.sql
-- 税理士事務所マスタ（マルチテナント化のための非破壊フェーズ Phase 1）。
-- 方針(A方式): 事務所ごとにLINE公式アカウントを分け、webhook payload の destination（botのuserID）で
--              事務所を振り分ける。webhook URL は全事務所共通の1本。
-- このマイグレーションはスキーマのみ（テーブル新設＋既存テーブルへの office_id 追加）。
-- 既存データの紐づけ（現事務所を office#1 として backfill）は 007_seed_office_1.sql で行う。

-- 事務所IDの自動採番用シーケンス（O-001 形式）
CREATE SEQUENCE IF NOT EXISTS offices_code_seq;

CREATE TABLE IF NOT EXISTS offices (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  -- 事務所ID（自動採番）: O-001, O-002, ...
  office_code text UNIQUE NOT NULL
    DEFAULT ('O-' || lpad(nextval('offices_code_seq')::text, 3, '0')),
  -- 事務所の正式名称
  name text NOT NULL,
  -- 振り分けキー: webhook payload の destination（= botのuserID）。GET https://api.line.me/v2/bot/info で取得可
  line_destination text UNIQUE,
  -- LINEチャネル認証情報（検証中は平文保存。外部事務所を入れる直前に暗号化する）
  line_channel_secret text,
  line_channel_access_token text,
  -- 受付可否（停止事務所を弾く用）
  is_active boolean DEFAULT true,
  created_at timestamptz DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_offices_destination ON offices(line_destination);

-- 既存テーブルに所属事務所を付与
-- clients: 顧問先は必ずどこかの事務所に属する（事務所削除で顧問先も消す）
ALTER TABLE clients ADD COLUMN IF NOT EXISTS office_id uuid REFERENCES offices(id) ON DELETE CASCADE;
-- receipts: 書類はどの事務所宛か（事務所削除でも書類自体は残す）
ALTER TABLE receipts ADD COLUMN IF NOT EXISTS office_id uuid REFERENCES offices(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_clients_office_id ON clients(office_id);
CREATE INDEX IF NOT EXISTS idx_receipts_office_id ON receipts(office_id);
