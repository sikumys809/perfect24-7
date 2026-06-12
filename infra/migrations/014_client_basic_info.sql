-- 014_client_basic_info.sql
-- 顧問先の基本情報（会社名は既存 official_name）＋ OTPログイン用カラムを clients に追加。
-- 営業期間: fiscal_start_month=期首月, fiscal_end_month=期末月(=決算月)。1〜12。
ALTER TABLE clients ADD COLUMN IF NOT EXISTS trade_name text;          -- 屋号
ALTER TABLE clients ADD COLUMN IF NOT EXISTS contact_name text;        -- 担当者名
ALTER TABLE clients ADD COLUMN IF NOT EXISTS email text;
ALTER TABLE clients ADD COLUMN IF NOT EXISTS phone text;               -- 携帯電話番号
ALTER TABLE clients ADD COLUMN IF NOT EXISTS fiscal_start_month int;   -- 期首月 1-12
ALTER TABLE clients ADD COLUMN IF NOT EXISTS fiscal_end_month int;     -- 期末月(決算月) 1-12

-- OTP（ワンタイムパス）ログイン用。登録コード入力 → LINEにOTPプッシュ → OTPでログイン。
ALTER TABLE clients ADD COLUMN IF NOT EXISTS otp_code text;
ALTER TABLE clients ADD COLUMN IF NOT EXISTS otp_expires timestamptz;
ALTER TABLE clients ADD COLUMN IF NOT EXISTS otp_attempts int DEFAULT 0;
