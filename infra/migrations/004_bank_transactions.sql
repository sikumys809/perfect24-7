-- 004_bank_transactions.sql
-- 銀行通帳（預金通帳）の取引明細を保存するテーブルを新設。
-- 領収書/請求書は1件=1金額だが、通帳は1ページに取引明細が複数行あるため別テーブルにする。

-- 書類種別（receipt / invoice / bankbook / other）を receipts に記録
ALTER TABLE receipts ADD COLUMN IF NOT EXISTS document_type text;

-- bank_transactions: 通帳の取引明細1行=1レコード
CREATE TABLE IF NOT EXISTS bank_transactions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  receipt_id uuid REFERENCES receipts(id) ON DELETE CASCADE, -- 親=その通帳画像/PDF（receipts行を書類コンテナとして流用）
  line_no int,            -- ページ内の行順（読み取り順）
  txn_date date,          -- 取引日
  description text,        -- 摘要・お取扱内容（振込/カード/ATM 等）
  withdrawal numeric,      -- お支払金額（出金）
  deposit numeric,         -- お預り金額（入金）
  balance numeric,         -- 差引残高
  confidence numeric,      -- その行の抽出自信度 0.0-1.0
  source text DEFAULT 'claude-opus-4-8',
  created_at timestamptz DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_bank_txn_receipt ON bank_transactions(receipt_id);
CREATE INDEX IF NOT EXISTS idx_bank_txn_date ON bank_transactions(txn_date);
