import { Job } from 'bullmq';
import { pool } from '../db/pool';
import { runAllChecks, computeFileHash } from '../checks';
import { logger } from '../utils/logger';
 
export const processImageJob = async (job: Job) => {
  const { jobId, filepath } = job.data as { jobId: string; filepath: string };
 
  const client = await pool.connect();
  try {
    const fileHash = await computeFileHash(filepath);
 
    await client.query(
      'UPDATE jobs SET hash = $1, updated_at = NOW() WHERE id = $2',
      [fileHash, jobId],
    );
 
    await client.query('BEGIN');
 
    await client.query(
      'UPDATE jobs SET status = $1, updated_at = NOW() WHERE id = $2',
      ['processing', jobId],
    );
 
    const results = await runAllChecks(filepath, jobId, fileHash);
 
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
 
    logger.info('Job processed successfully', {
      jobId,
      checks: results.map((r) => ({ name: r.check_name, passed: r.passed })),
    });
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
 
    logger.error('Job processing failed', { jobId, error: message });
    throw error; 
  } finally {
    client.release();
  }
};