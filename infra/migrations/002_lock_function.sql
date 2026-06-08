-- 002_lock_function.sql
-- ジョブを原子的に取得して processing に移す関数

CREATE OR REPLACE FUNCTION lock_next_processing_job()
RETURNS SETOF processing_jobs AS $$
WITH c AS (
  SELECT id FROM processing_jobs
  WHERE status = 'pending'
  ORDER BY queued_at
  LIMIT 1
  FOR UPDATE SKIP LOCKED
)
UPDATE processing_jobs
SET status = 'processing', started_at = now(), attempts = processing_jobs.attempts + 1
FROM c
WHERE processing_jobs.id = c.id
RETURNING processing_jobs.*;
$$ LANGUAGE sql;
