-- 007_seed_office_1.sql
-- 現事務所（森下敦史税理士事務所）を office#1 として登録し、既存データを紐づける（Phase 1 backfill）。
-- 検証中は1事務所のみ。2社目以降は offices に1行 INSERT するだけ（コード変更ゼロ）。
--
-- line_destination は GET https://api.line.me/v2/bot/info の userId（= webhook の destination）。
-- 認証情報（line_channel_secret / line_channel_access_token）は検証中は env を使うため、
-- ここでは NULL のまま。Phase 2（DB管理へ移行）で投入する。

-- 1) office#1 を登録（既に同一 destination があれば二重登録しない）
INSERT INTO offices (name, line_destination)
SELECT '森下敦史税理士事務所', 'U50dbe9322ddef634d7883912ab7b6c20'
WHERE NOT EXISTS (
  SELECT 1 FROM offices WHERE line_destination = 'U50dbe9322ddef634d7883912ab7b6c20'
);

-- 2) 既存の clients / receipts のうち、まだ事務所未設定の行を office#1 に紐づける
--    （検証中は1事務所なので、未設定行はすべて森下事務所のもの）
UPDATE clients
SET office_id = (SELECT id FROM offices WHERE line_destination = 'U50dbe9322ddef634d7883912ab7b6c20')
WHERE office_id IS NULL;

UPDATE receipts
SET office_id = (SELECT id FROM offices WHERE line_destination = 'U50dbe9322ddef634d7883912ab7b6c20')
WHERE office_id IS NULL;
