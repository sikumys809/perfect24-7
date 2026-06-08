#!/usr/bin/env ts-node
// ダミーデータ生成スクリプト（開発用）
// 使用方法: npx ts-node scripts/seed-dummy-data.ts

import { createClient } from '@supabase/supabase-js';

const SUPABASE_URL = process.env.SUPABASE_URL || '';
const SUPABASE_KEY = process.env.SUPABASE_KEY || '';

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

async function seedData() {
  console.log('ダミーデータを生成中...\n');

  try {
    // 1. ダミーユーザー
    const { data: user, error: userError } = await supabase
      .from('users')
      .insert([
        { line_user_id: 'U1234567890abcdef', display_name: 'テストユーザー1' },
        { line_user_id: 'U9876543210fedcba', display_name: 'テストユーザー2' },
      ])
      .select()
      .limit(1);

    if (userError) throw userError;
    console.log('✓ ユーザーを作成しました');

    // 2. ダミーベンダー
    const { data: vendor, error: vendorError } = await supabase
      .from('vendors')
      .insert([
        { name: 'テスト商店A', address: '東京都渋谷区' },
        { name: 'テスト商店B', address: '大阪府大阪市' },
      ])
      .select()
      .limit(1);

    if (vendorError) throw vendorError;
    console.log('✓ ベンダーを作成しました');

    // 3. ダミー領収書
    if (user && vendor) {
      const { data: receipt, error: receiptError } = await supabase
        .from('receipts')
        .insert([
          {
            user_id: user.id,
            vendor_id: vendor.id,
            amount: 5000,
            currency: 'JPY',
            tax_amount: 500,
            total_amount: 5500,
            issued_date: new Date().toISOString().split('T')[0],
            source: 'test',
          },
        ])
        .select()
        .limit(1);

      if (receiptError) throw receiptError;
      console.log('✓ 領収書を作成しました');

      // 4. ダミー処理ジョブ
      if (receipt) {
        const { error: jobError } = await supabase
          .from('processing_jobs')
          .insert([{ receipt_id: receipt.id, status: 'pending' }]);

        if (jobError) throw jobError;
        console.log('✓ 処理ジョブを作成しました');
      }
    }

    console.log('\nダミーデータ生成完了！');
  } catch (err: any) {
    console.error('エラー:', err.message);
    process.exit(1);
  }
}

seedData();
