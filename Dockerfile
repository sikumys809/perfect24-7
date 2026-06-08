FROM node:18-alpine

WORKDIR /app

# 依存インストール
COPY package.json package-lock.json ./
RUN npm ci --only=production

# ビルド
COPY tsconfig.json ./
COPY src ./src
RUN npx tsc

# ワーカー起動
CMD ["node", "dist/workers/processor.js"]
