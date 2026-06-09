-- 003_image_hash.sql
-- 完全同一画像の重複検知用に SHA-256 ハッシュ列を追加

ALTER TABLE receipt_images ADD COLUMN IF NOT EXISTS image_sha256 text;

-- 同一ハッシュの二重登録を防ぐ部分ユニークインデックス（NULL は対象外なので既存行に影響なし）
CREATE UNIQUE INDEX IF NOT EXISTS idx_receipt_images_sha256
  ON receipt_images(image_sha256) WHERE image_sha256 IS NOT NULL;
