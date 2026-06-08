#!/usr/bin/env node
// .env ファイル検証スクリプト
// 使用方法: node scripts/validate-env.js

const fs = require('fs');
const path = require('path');

const REQUIRED_VARS = [
  'SUPABASE_URL',
  'SUPABASE_KEY',
  'LINE_CHANNEL_ACCESS_TOKEN',
  'LINE_CHANNEL_SECRET',
];

const OPTIONAL_VARS = [
  'LLM_API_KEY',
  'LLM_PROVIDER',
  'NODE_ENV',
];

function validateEnv() {
  const envFile = path.join(__dirname, '..', '.env');
  
  if (!fs.existsSync(envFile)) {
    console.error('❌ .env ファイルが見つかりません。');
    console.log('   .env.example をコピーして .env を作成してください:');
    console.log('   $ cp .env.example .env');
    process.exit(1);
  }

  require('dotenv').config({ path: envFile });

  let hasError = false;

  // 必須変数を確認
  for (const varName of REQUIRED_VARS) {
    if (!process.env[varName]) {
      console.error(`❌ 必須: ${varName} が設定されていません`);
      hasError = true;
    } else {
      const value = process.env[varName];
      const display = value.substring(0, 10) + '...';
      console.log(`✓ ${varName} = ${display}`);
    }
  }

  // オプション変数を確認
  console.log('\nオプション:');
  for (const varName of OPTIONAL_VARS) {
    if (process.env[varName]) {
      console.log(`✓ ${varName} = ${process.env[varName]}`);
    } else {
      console.log(`⚠ ${varName} 未設定（デフォルト値を使用）`);
    }
  }

  if (hasError) {
    console.error('\n❌ 検証失敗。.env ファイルを確認してください。');
    process.exit(1);
  }

  console.log('\n✅ 環境変数の検証が完了しました。');
}

validateEnv();
