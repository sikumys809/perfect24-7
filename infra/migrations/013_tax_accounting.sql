-- 013_tax_accounting.sql
-- 経理方式（税込経理 / 税抜経理）の初期設定。
-- 日本では消費税の経理方式は事業者（顧問先）ごとに選ぶため、clients に持たせる。
-- 事務所の既定（新規顧問先のデフォルト）は offices に持たせる。
--   inclusive = 税込経理（消費税を分けず税込のまま。既定）
--   exclusive = 税抜経理（経費/売上の消費税を 仮払/仮受消費税 に分ける）
-- 試算表・元帳の仕訳導出（api/_lib/accounting.ts deriveEntries）がこの値を反映する。

ALTER TABLE offices ADD COLUMN IF NOT EXISTS default_tax_accounting text NOT NULL DEFAULT 'inclusive';
ALTER TABLE clients ADD COLUMN IF NOT EXISTS tax_accounting text NOT NULL DEFAULT 'inclusive';

-- 値の妥当性を担保（inclusive / exclusive のみ）
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'clients_tax_accounting_chk') THEN
    ALTER TABLE clients ADD CONSTRAINT clients_tax_accounting_chk
      CHECK (tax_accounting IN ('inclusive', 'exclusive'));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'offices_default_tax_accounting_chk') THEN
    ALTER TABLE offices ADD CONSTRAINT offices_default_tax_accounting_chk
      CHECK (default_tax_accounting IN ('inclusive', 'exclusive'));
  END IF;
END $$;
