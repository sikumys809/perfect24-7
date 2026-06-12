-- 016_multi_company.sql
-- 1つのLINEユーザーが複数法人（顧問先）を持てるようにする。
-- 例: 1人が複数社を同じ税理士事務所に依頼。同じ LINE userId に複数 clients を紐づける。
--
-- 判別UX = ハイブリッド: 普段は「アクティブ会社」に入れ、送信直後に違えば選び直す（quick reply / postback）。
-- 1社しか無い人は従来どおり（プロンプト無し）。

-- 1:1 制約を外す（同じ linked_line_user_id を複数 clients が持てるように）。
-- 既存の通常インデックス idx_clients_line_user（005）は検索用に残る。
ALTER TABLE clients DROP CONSTRAINT IF EXISTS clients_linked_line_user_id_key;

-- 送信者ごとの状態: アクティブ会社、直近に作成した receipt 群（選び直し用）。
-- LINEユーザーは1つのbot（=1事務所）とやり取りするので line_user_id を主キーにする。
CREATE TABLE IF NOT EXISTS line_sender_state (
  line_user_id text PRIMARY KEY,
  office_id uuid,
  active_client_id uuid,
  last_receipt_ids uuid[],
  updated_at timestamptz DEFAULT now()
);
