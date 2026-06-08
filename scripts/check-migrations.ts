#!/usr/bin/env ts-node
// マイグレーション確認スクリプト
// 使用方法: npx ts-node scripts/check-migrations.ts

import { createClient } from '@supabase/supabase-js';

const SUPABASE_URL = process.env.SUPABASE_URL || '';
const SUPABASE_KEY = process.env.SUPABASE_KEY || '';

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

async function checkMigrations() {
  console.log('チェック中: マイグレーション状態...\n');

  const tables = ['users', 'vendors', 'receipts', 'receipt_images', 'extracted_fields', 'processing_jobs', 'line_events'];

  for (const table of tables) {
    try {
      const { data, error } = await supabase.from(table).select('*').limit(1);
      if (error && error.code === 'PGRST116') {
        console.log(`✓ ${table} - テーブルが存在します（空）`);
      } else if (error) {
        console.log(`✗ ${table} - エラー: ${error.message}`);
      } else {
        console.log(`✓ ${table} - テーブルが存在します`);
      }
    } catch (err) {
      console.log(`✗ ${table} - 接続エラー`);
    }
  }

  console.log('\n関数チェック:');
  try {
    const { data, error } = await supabase.rpc('lock_next_processing_job');
    if (error && error.code === 'PGRST3001') {
      console.log(`✗ lock_next_processing_job - 関数が見つかりません`);
    } else if (!error) {
      console.log(`✓ lock_next_processing_job - 関数が存在します`);
    }
  } catch (err) {
    console.log(`✗ lock_next_processing_job - エラー`);
  }

  console.log('\nチェック完了！');
}

checkMigrations().catch((e) => {
  console.error('Error:', e.message);
  process.exit(1);
});
