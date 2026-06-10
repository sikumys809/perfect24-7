-- 010_payroll_lines.sql
-- 給与明細（payslip）・賃金台帳（wage_ledger）の従業員1名×1期間=1行を格納。
-- 人件費の仕訳に直結し、支給/控除の内訳（社保・源泉・住民税＝預り金）が会計で重要なので専用列を持つ。
--   給与明細 = 1行、賃金台帳 = 従業員×月の複数行。親 receipts.document_type で区別。
CREATE TABLE IF NOT EXISTS payroll_lines (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  receipt_id uuid REFERENCES receipts(id) ON DELETE CASCADE,
  line_no int,                    -- 並び順
  employee text,                  -- 従業員名
  pay_month text,                 -- 対象支給月（例: 2024-05 / 令和6年5月分）
  gross numeric,                  -- 総支給額（人件費）
  health_insurance numeric,       -- 健康保険料（本人負担）
  pension numeric,                -- 厚生年金保険料（本人負担）
  employment_insurance numeric,   -- 雇用保険料（本人負担）
  income_tax numeric,             -- 源泉所得税（預り金）
  resident_tax numeric,           -- 住民税（預り金）
  other_deduction numeric,        -- その他控除
  total_deduction numeric,        -- 控除合計
  net numeric,                    -- 差引支給額
  confidence numeric,             -- その行の抽出自信度 0.0-1.0
  source text DEFAULT 'claude-opus-4-8',
  created_at timestamptz DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_payroll_lines_receipt ON payroll_lines(receipt_id);
