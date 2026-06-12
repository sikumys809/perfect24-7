-- 015_office_auth.sql
-- 税理士事務所側のログイン（マルチテナント認証）。メール＋パスワード、自己登録→承認制。
--   status: pending（承認待ち・ログイン不可）/ active（ログイン可）/ disabled（停止）
--   password_hash: 'scrypt$<salt>$<hash>'。NULL のときは初回ログインで設定（既存office#1の移行用）。
--   liff_id: ③ 事務所ごとのLIFF（登録フォーム）。当面はenv既定を使うが、将来のDB管理用に列だけ用意。
-- 認証の有効化は env OFFICE_AUTH=on で行う（適用直後は OFF のままで既存挙動を壊さない）。

ALTER TABLE offices ADD COLUMN IF NOT EXISTS email text;
ALTER TABLE offices ADD COLUMN IF NOT EXISTS password_hash text;
ALTER TABLE offices ADD COLUMN IF NOT EXISTS status text NOT NULL DEFAULT 'active';
ALTER TABLE offices ADD COLUMN IF NOT EXISTS liff_id text;

-- メールは大文字小文字を無視して一意
CREATE UNIQUE INDEX IF NOT EXISTS uq_offices_email ON offices(lower(email)) WHERE email IS NOT NULL;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'offices_status_chk') THEN
    ALTER TABLE offices ADD CONSTRAINT offices_status_chk CHECK (status IN ('pending', 'active', 'disabled'));
  END IF;
END $$;

-- 既存 office#1（森下敦史税理士事務所）にログイン用メールを付与。
-- パスワードは初回ログイン時に本人が設定する（password_hash は NULL のまま）。
UPDATE offices
SET email = 'mizuno@sikumys.co.jp', status = 'active'
WHERE line_destination = 'U50dbe9322ddef634d7883912ab7b6c20' AND email IS NULL;
