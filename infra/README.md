# Migrations README

目的：`infra/migrations/` にある SQL ファイルを Supabase/Postgres に適用する手順を記載します。

方法 A — psql（推奨、CIや手元から適用する場合）
1. `DATABASE_URL` 環境変数に接続文字列を設定します（Supabase プロジェクトのDatabase > Settings で確認できる接続文字列）。
2. 以下コマンドを実行してすべてのマイグレーションを順に適用します：

```bash
export DATABASE_URL="postgresql://user:password@db.host:5432/dbname"
for f in infra/migrations/*.sql; do
  echo "Applying $f"
  psql "$DATABASE_URL" -f "$f"
done
```

方法 B — Supabase SQL Editor（GUI）
- Supabase コンソールの `SQL` > `New query` に SQL ファイルの中身を貼り付けて実行します。

注意点
- マイグレーション実行には適切な権限（サービスロールまたはDBユーザーの権限）が必要です。
- `pgcrypto` 拡張の有効化を行うため、管理者権限が必要になる場合があります。

