import { Job } from 'bullmq';
import { pool } from '../db/pool';
import { runAllChecks, computeFileHash, computeDHash } from '../checks';
import { redisConnection } from '../queue';
import { logger } from '../utils/logger';
import sharp from 'sharp';
 
export const processImageJob = async (job: Job) => {
  const { jobId, filepath } = job.data as { jobId: string; filepath: string };
 
  const client = await pool.connect();
  try {
    const fileHash = await computeFileHash(filepath);
    const fileDHash = await computeDHash(filepath);
 
    await client.query(
      'UPDATE jobs SET hash = $1, dhash = $2, updated_at = NOW() WHERE id = $3',
      [fileHash, fileDHash, jobId],
    );
 
    await client.query('BEGIN');

    // Acquire an advisory lock on the hash to prevent concurrent duplicate processing
    const hashLockId = parseInt(fileHash.slice(0, 8), 16); 
    await client.query('SELECT pg_advisory_xact_lock($1)', [hashLockId]);

    await client.query(
      'UPDATE jobs SET status = $1, updated_at = NOW() WHERE id = $2',
      ['processing', jobId],
    );
    await redisConnection.publish(`job-status:${jobId}`, JSON.stringify({ status: 'processing' }));

    // File corruption handling: Validate image before running checks
    try {
      await sharp(filepath).metadata();
    } catch (err) {
      throw new Error('File corruption detected: Invalid image file');
    }

    const results = await runAllChecks(filepath, jobId, fileHash, fileDHash);

    for (const res of results) {
      await client.query(
        `INSERT INTO results (job_id, check_name, passed, confidence, detail)
         VALUES ($1, $2, $3, $4, $5)`,
        [jobId, res.check_name, res.passed, res.confidence, JSON.stringify(res.detail)],
      );
    }
 
    await client.query(
      'UPDATE jobs SET status = $1, updated_at = NOW() WHERE id = $2',
      ['completed', jobId],
    );
 
    await client.query('COMMIT');
    await redisConnection.publish(`job-status:${jobId}`, JSON.stringify({ status: 'completed' }));
 
    logger.info('Job processed successfully', {
      jobId,
      checks: results.map((r) => ({ name: r.check_name, passed: r.passed })),
    });

    const { webhookUrl } = job.data as { webhookUrl?: string };
    if (webhookUrl) {
      const payload = JSON.stringify({ jobId, status: 'completed', results });
      let attempts = 0;
      const maxRetries = 3;
      while (attempts < maxRetries) {
        try {
          const res = await fetch(webhookUrl, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: payload,
          });
          if (!res.ok) throw new Error(`HTTP ${res.status}`);
          logger.info('Webhook sent successfully', { jobId, webhookUrl, attempt: attempts + 1 });
          break;
        } catch (err) {
          attempts++;
          if (attempts >= maxRetries) {
            logger.error('Failed to send webhook after retries', { jobId, webhookUrl, error: err instanceof Error ? err.message : 'Unknown' });
          } else {
            await new Promise(resolve => setTimeout(resolve, 1000 * Math.pow(2, attempts - 1)));
          }
        }
      }
    }

  } catch (error: unknown) {
    try {
      await client.query('ROLLBACK');
    } catch (rollbackErr) {
      logger.error('Rollback failed', { jobId, rollbackErr });
    }
 
    const message =
      error instanceof Error ? error.message : 'Unknown processing error';
 
    await client.query(
      `UPDATE jobs
       SET status = $1, failure_reason = $2, updated_at = NOW()
       WHERE id = $3`,
      ['failed', message, jobId],
    ).catch((dbErr) =>
      logger.error('Could not persist failure_reason', { jobId, dbErr }),
    );
    await redisConnection.publish(`job-status:${jobId}`, JSON.stringify({ status: 'failed', reason: message }));
 
    logger.error('Job processing failed', { jobId, error: message });
    throw error; 
  } finally {
    client.release();
  }
};