-- 009_document_lines.sql
-- 棚卸表・借入金返済予定表など、通帳/カードとは列構成が異なる「構造化明細」を格納する汎用テーブル。
-- 1書類(receipts) = 複数行(document_lines)。line_type で書類種別を区別し、
-- 用途に応じて列を使い分ける（未使用列は null）。
--   inventory(棚卸):       label=品名, quantity=数量, unit_price=単価, amount=金額
--   loan_schedule(返済表): line_date=返済日, label=回/摘要, amount=返済額, principal=元金, interest=利息, balance=残高

CREATE TABLE IF NOT EXISTS document_lines (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  receipt_id uuid REFERENCES receipts(id) ON DELETE CASCADE,
  line_no int,                 -- 並び順（読み取り順）
  line_type text,              -- 'inventory' | 'loan_schedule'
  label text,                  -- 品名 / 摘要 / 回
  line_date date,              -- 返済日 等
  quantity numeric,            -- 数量
  unit_price numeric,          -- 単価
  amount numeric,              -- 金額 / 返済額
  principal numeric,           -- 元金
  interest numeric,            -- 利息
  balance numeric,             -- 残高
  confidence numeric,          -- その行の抽出自信度 0.0-1.0
  source text DEFAULT 'claude-opus-4-8',
  created_at timestamptz DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_document_lines_receipt ON document_lines(receipt_id);
CREATE INDEX IF NOT EXISTS idx_document_lines_type ON document_lines(line_type);
