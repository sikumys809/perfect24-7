-- 012_backfill_accounts.sql
-- 011 以前に受信済みの書類には account_code が無く、試算表・元帳に出てこない。
-- 既存データにも保守的な既定科目を埋めて、レポートが空にならないようにする（後で事務所が修正可能）。
-- 対象は account_code が未設定の行のみ。通帳・カード・棚卸・返済表・残高証明は仕訳対象外なので触らない。

UPDATE receipts SET
  account_code = CASE
    WHEN document_type = 'ec_payout' THEN '4010'                                  -- 売上高
    WHEN document_type IN ('payslip','wage_ledger') THEN '6020'                   -- 給料手当
    WHEN document_type = 'fixed_asset' THEN '1550'                                -- 工具器具備品（既定）
    WHEN document_type = 'tax_payment' THEN '6170'                                -- 租税公課（既定）
    WHEN direction = 'sales' THEN '4010'                                          -- 売上高
    WHEN document_type IN ('receipt','invoice') THEN '6110'                       -- 消耗品費（既定の経費）
    ELSE account_code
  END,
  payment_account_code = CASE
    WHEN document_type = 'ec_payout' THEN '1020'                                  -- 普通預金
    WHEN document_type IN ('payslip','wage_ledger') THEN '1010'                   -- 現金
    WHEN document_type = 'fixed_asset' THEN '2020'                                -- 未払金
    WHEN document_type = 'tax_payment' THEN '1010'                                -- 現金
    WHEN direction = 'sales' AND document_type = 'invoice' THEN '1040'            -- 売掛金
    WHEN direction = 'sales' THEN '1010'                                          -- 現金
    WHEN document_type = 'invoice' THEN '2020'                                    -- 未払金
    WHEN document_type = 'receipt' THEN '1010'                                    -- 現金
    ELSE payment_account_code
  END,
  account_source = COALESCE(account_source, 'auto')
WHERE account_code IS NULL
  AND document_type IN ('receipt','invoice','tax_payment','fixed_asset','ec_payout','payslip','wage_ledger');
