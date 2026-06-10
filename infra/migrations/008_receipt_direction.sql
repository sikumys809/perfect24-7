-- 008_receipt_direction.sql
-- 売上(sales)／経費(expense)の向きを receipts に記録する。
-- 同じ「請求書・領収書」でも、顧問先が発行した側=売上、受け取った側=経費。
-- 顧問先名（clients.official_name）を抽出プロンプトに渡してモデルに direction を判定させ、
-- 不明時は発行元/宛名と顧問先名の一致でフォールバック推定（webhook 側ロジック）。
ALTER TABLE receipts ADD COLUMN IF NOT EXISTS direction text; -- 'sales' | 'expense' | null
CREATE INDEX IF NOT EXISTS idx_receipts_direction ON receipts(direction);
