import { Job } from 'bullmq';
import { pool } from '../db/pool';
import { runAllChecks } from '../checks';

export const processImageJob = async (job: Job) => {
  const { jobId, filepath } = job.data;
  
  const client = await pool.connect();
  try {
    await client.query(
      'UPDATE jobs SET status = $1, updated_at = NOW() WHERE id = $2', 
      ['processing', jobId]
    );

    const results = await runAllChecks(filepath, jobId);


    await client.query('BEGIN');
    
    for (const res of results) {
      await client.query(
        'INSERT INTO results (job_id, check_name, passed, confidence, detail) VALUES ($1, $2, $3, $4, $5)',
        [jobId, res.check_name, res.passed, res.confidence, res.detail]
      );
    }

    await client.query(
      'UPDATE jobs SET status = $1, updated_at = NOW() WHERE id = $2', 
      ['completed', jobId]
    );
    
    await client.query('COMMIT');

  } catch (error: any) {
    await client.query('ROLLBACK');
    
    await client.query(
      'UPDATE jobs SET status = $1, failure_reason = $2, updated_at = NOW() WHERE id = $3',
      ['failed', error.message || 'Unknown processing error', jobId]
    );
    throw error;
  } finally {
    client.release();
  }
};
