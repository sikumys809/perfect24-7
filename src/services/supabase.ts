import { createClient, SupabaseClient } from '@supabase/supabase-js';

const SUPABASE_URL = process.env.SUPABASE_URL || '';
const SUPABASE_KEY = process.env.SUPABASE_KEY || '';

let client: SupabaseClient | null = null;

export function getSupabaseClient(): SupabaseClient {
  if (!client) {
    client = createClient(SUPABASE_URL, SUPABASE_KEY);
  }
  return client;
}

// DB operations utilities

export async function getUserByLineId(lineUserId: string) {
  const supabase = getSupabaseClient();
  const { data, error } = await supabase
    .from('users')
    .select('*')
    .eq('line_user_id', lineUserId)
    .limit(1)
    .single();
  if (error && error.code !== 'PGRST116') throw error; // PGRST116 = no rows
  return data || null;
}

export async function createOrUpdateUser(lineUserId: string, displayName?: string, avatarUrl?: string) {
  const supabase = getSupabaseClient();
  const existing = await getUserByLineId(lineUserId);

  if (existing) {
    const { data, error } = await supabase
      .from('users')
      .update({ display_name: displayName, avatar_url: avatarUrl })
      .eq('id', existing.id)
      .select()
      .single();
    if (error) throw error;
    return data;
  } else {
    const { data, error } = await supabase
      .from('users')
      .insert([{ line_user_id: lineUserId, display_name: displayName, avatar_url: avatarUrl }])
      .select()
      .single();
    if (error) throw error;
    return data;
  }
}

export async function getReceipt(receiptId: string) {
  const supabase = getSupabaseClient();
  const { data, error } = await supabase.from('receipts').select('*').eq('id', receiptId).single();
  if (error && error.code !== 'PGRST116') throw error;
  return data || null;
}

export async function getReceiptImages(receiptId: string) {
  const supabase = getSupabaseClient();
  const { data, error } = await supabase.from('receipt_images').select('*').eq('receipt_id', receiptId);
  if (error) throw error;
  return data || [];
}

export async function uploadReceiptImage(
  receiptId: string,
  filename: string,
  buffer: Buffer,
  contentType: string
) {
  const supabase = getSupabaseClient();
  const { error: uploadError } = await supabase.storage
    .from('receipts')
    .upload(filename, buffer, { contentType });
  if (uploadError) throw uploadError;

  const { data: imgData, error: dbError } = await supabase
    .from('receipt_images')
    .insert([{ receipt_id: receiptId, storage_path: filename, content_type: contentType }])
    .select()
    .single();
  if (dbError) throw dbError;
  return imgData;
}

export async function createProcessingJob(receiptId: string) {
  const supabase = getSupabaseClient();
  const { data, error } = await supabase
    .from('processing_jobs')
    .insert([{ receipt_id: receiptId, status: 'pending' }])
    .select()
    .single();
  if (error) throw error;
  return data;
}

export async function updateProcessingJob(jobId: string, status: string, error?: string) {
  const supabase = getSupabaseClient();
  const update: any = { status };
  if (error) update.error = error;
  if (status === 'done' || status === 'failed') update.finished_at = new Date().toISOString();

  const { data, error: dbError } = await supabase
    .from('processing_jobs')
    .update(update)
    .eq('id', jobId)
    .select()
    .single();
  if (dbError) throw dbError;
  return data;
}
