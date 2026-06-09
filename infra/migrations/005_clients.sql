-- 005_clients.sql
-- 顧問先（クライアント企業）マスタと、友達追加時の登録コードによるひもづけ。
-- 方針: 1顧問先=1 LINEアカウント(1:1) / 顧問先IDは自動採番 / 未登録ユーザーの書類は受け付けない。

-- 顧問先IDの自動採番用シーケンス（C-00001 形式）
CREATE SEQUENCE IF NOT EXISTS clients_code_seq;

CREATE TABLE IF NOT EXISTS clients (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  -- 顧問先ID（自動採番）: C-00001, C-00002, ...
  client_code text UNIQUE NOT NULL
    DEFAULT ('C-' || lpad(nextval('clients_code_seq')::text, 5, '0')),
  -- 正式名称（事務所が登録）
  official_name text NOT NULL,
  -- 友達追加後に本人が送る登録コード（自動生成・16進6桁）。ひもづけ後も保持
  registration_code text UNIQUE NOT NULL
    DEFAULT upper(substr(md5(gen_random_uuid()::text), 1, 6)),
  -- ひもづいた LINE userId（1:1。未ひもづけは null）
  linked_line_user_id text UNIQUE,
  linked_at timestamptz,
  created_at timestamptz DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_clients_line_user ON clients(linked_line_user_id);

-- どの顧問先の書類かを receipts に記録
ALTER TABLE receipts ADD COLUMN IF NOT EXISTS client_id uuid REFERENCES clients(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS idx_receipts_client_id ON receipts(client_id);
