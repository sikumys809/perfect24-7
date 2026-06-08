# Worker 実行手順（ローカル）

このドキュメントはローカルで `src/workers/processor.ts` を動かすための手順です。

準備
1. Node.js と npm をインストールします。
2. 依存関係をインストールします：

```bash
npm install
```

3. `.env` をルートに作り、`SUPABASE_URL` と `SUPABASE_KEY`（サービスキー）を設定します。

ローカルで実行（テスト的）

```bash
# 開発用に ts-node を使う
npx ts-node src/workers/processor.ts

# もしくはビルドして実行する
npm run build
node dist/workers/processor.js
```

注意
- 実運用では `SUPABASE_KEY` はサービスロールキーなど強力なキーを使用するため、環境管理を厳格にしてください。