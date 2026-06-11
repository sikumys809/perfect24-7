-- 011_account_titles.sql
-- 勘定科目マスタ（科目表）と、書類への科目付け用カラム。
-- 税理士の要望: 勘定科目を自動で割り振り、間違っていれば事務所が修正できるようにする。
-- さらに、付与した科目から「簡易複式」で総勘定元帳・月次試算表(BS/PL)を導出する。
--
-- 方針（簡易複式）:
--   receipts に主たる勘定科目(account_code)と相手科目(payment_account_code)を持たせ、
--   元帳・試算表はこの2科目＋金額から仕訳を「その場で導出」して集計する（単一の真実=receipts）。
--   科目マスタは office_id=NULL を共通標準とし、事務所ごとの追加・編集は office_id 付きで行う。

-- ───────────────────────────── 科目マスタ ─────────────────────────────
CREATE TABLE IF NOT EXISTS account_titles (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  office_id uuid REFERENCES offices(id) ON DELETE CASCADE, -- NULL = 共通標準。事務所固有は office_id 付き
  code text NOT NULL,                 -- 科目コード（例: 6110）
  name text NOT NULL,                 -- 科目名（例: 消耗品費）
  category text NOT NULL,             -- asset | liability | equity | revenue | expense
  statement text NOT NULL,            -- BS | PL（試算表の表示先）
  normal_balance text NOT NULL,       -- debit | credit（残高の通常側）
  sort_order int,                     -- 表示順
  is_active boolean DEFAULT true,
  created_at timestamptz DEFAULT now()
);

-- 共通標準は code で一意、事務所固有は (office_id, code) で一意（部分インデックスで両立）
CREATE UNIQUE INDEX IF NOT EXISTS uq_account_titles_global_code
  ON account_titles(code) WHERE office_id IS NULL;
CREATE UNIQUE INDEX IF NOT EXISTS uq_account_titles_office_code
  ON account_titles(office_id, code) WHERE office_id IS NOT NULL;

-- ───────────────────────── 標準科目セットの seed ─────────────────────────
-- 中小企業でよく使う科目を一通り。共通標準(office_id=NULL)として投入（冪等）。
INSERT INTO account_titles (office_id, code, name, category, statement, normal_balance, sort_order)
SELECT NULL, v.code, v.name, v.category, v.statement, v.normal_balance, v.sort_order
FROM (VALUES
  -- 資産（BS / 借方）
  ('1010','現金','asset','BS','debit',101),
  ('1020','普通預金','asset','BS','debit',102),
  ('1030','当座預金','asset','BS','debit',103),
  ('1040','売掛金','asset','BS','debit',104),
  ('1050','棚卸資産','asset','BS','debit',105),
  ('1060','立替金','asset','BS','debit',106),
  ('1070','仮払金','asset','BS','debit',107),
  ('1080','仮払消費税','asset','BS','debit',108),
  ('1510','建物','asset','BS','debit',151),
  ('1520','建物附属設備','asset','BS','debit',152),
  ('1530','機械装置','asset','BS','debit',153),
  ('1540','車両運搬具','asset','BS','debit',154),
  ('1550','工具器具備品','asset','BS','debit',155),
  ('1560','ソフトウェア','asset','BS','debit',156),
  -- 負債（BS / 貸方）
  ('2010','買掛金','liability','BS','credit',201),
  ('2020','未払金','liability','BS','credit',202),
  ('2030','未払費用','liability','BS','credit',203),
  ('2040','預り金','liability','BS','credit',204),
  ('2050','未払消費税','liability','BS','credit',205),
  ('2060','短期借入金','liability','BS','credit',206),
  ('2070','長期借入金','liability','BS','credit',207),
  ('2080','仮受消費税','liability','BS','credit',208),
  -- 純資産（BS / 貸方。事業主貸のみ借方）
  ('3010','資本金','equity','BS','credit',301),
  ('3020','繰越利益剰余金','equity','BS','credit',302),
  ('3030','事業主借','equity','BS','credit',303),
  ('3040','事業主貸','equity','BS','debit',304),
  -- 収益（PL / 貸方）
  ('4010','売上高','revenue','PL','credit',401),
  ('4020','雑収入','revenue','PL','credit',402),
  ('4030','受取利息','revenue','PL','credit',403),
  ('4040','受取手数料','revenue','PL','credit',404),
  -- 売上原価（PL / 借方）
  ('5010','仕入高','expense','PL','debit',501),
  -- 販売費及び一般管理費（PL / 借方）
  ('6010','役員報酬','expense','PL','debit',601),
  ('6020','給料手当','expense','PL','debit',602),
  ('6030','雑給','expense','PL','debit',603),
  ('6040','法定福利費','expense','PL','debit',604),
  ('6050','福利厚生費','expense','PL','debit',605),
  ('6060','外注費','expense','PL','debit',606),
  ('6070','旅費交通費','expense','PL','debit',607),
  ('6080','接待交際費','expense','PL','debit',608),
  ('6090','会議費','expense','PL','debit',609),
  ('6100','通信費','expense','PL','debit',610),
  ('6110','消耗品費','expense','PL','debit',611),
  ('6120','事務用品費','expense','PL','debit',612),
  ('6130','水道光熱費','expense','PL','debit',613),
  ('6140','地代家賃','expense','PL','debit',614),
  ('6150','賃借料','expense','PL','debit',615),
  ('6160','支払手数料','expense','PL','debit',616),
  ('6170','租税公課','expense','PL','debit',617),
  ('6180','減価償却費','expense','PL','debit',618),
  ('6190','広告宣伝費','expense','PL','debit',619),
  ('6200','修繕費','expense','PL','debit',620),
  ('6210','保険料','expense','PL','debit',621),
  ('6220','新聞図書費','expense','PL','debit',622),
  ('6230','諸会費','expense','PL','debit',623),
  ('6240','荷造運賃','expense','PL','debit',624),
  ('6250','車両費','expense','PL','debit',625),
  ('6260','雑費','expense','PL','debit',626),
  -- 営業外損益・税金（PL）
  ('8010','支払利息','expense','PL','debit',801),
  ('8020','雑損失','expense','PL','debit',802),
  ('9010','法人税等','expense','PL','debit',901)
) AS v(code, name, category, statement, normal_balance, sort_order)
WHERE NOT EXISTS (SELECT 1 FROM account_titles WHERE office_id IS NULL LIMIT 1);

-- ───────────────────────── receipts への科目カラム ─────────────────────────
-- account_code         = 主たる勘定科目（経費/売上/資産。例: 消耗品費=6110, 売上高=4010）
-- payment_account_code = 相手科目（支払・入金側。現金1010 / 未払金2020 / 普通預金1020 / 預り金2040 等）
-- account_source       = 'auto'（自動付与）/ 'manual'（事務所が修正済み）
ALTER TABLE receipts ADD COLUMN IF NOT EXISTS account_code text;
ALTER TABLE receipts ADD COLUMN IF NOT EXISTS payment_account_code text;
ALTER TABLE receipts ADD COLUMN IF NOT EXISTS account_source text;
CREATE INDEX IF NOT EXISTS idx_receipts_account_code ON receipts(account_code);
