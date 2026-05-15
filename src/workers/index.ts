import { Worker } from 'bullmq';
import IORedis from 'ioredis';
import dotenv from 'dotenv';
import { processImageJob } from './processor';
import { logger } from '../utils/logger';

dotenv.config();

const connection = new IORedis({
  host: process.env.REDIS_HOST || 'localhost',
  port: parseInt(process.env.REDIS_PORT || '6379'),
  maxRetriesPerRequest: null,
});

export const imageWorker = new Worker('image-processing', processImageJob, {
  connection,
  concurrency: 5, 
});

imageWorker.on('completed', (job) => {
  logger.info(`Job completed successfully`, { jobId: job.id, dbId: job.data.jobId });
});

imageWorker.on('failed', (job, err) => {
  logger.error(`Job failed`, { jobId: job?.id, dbId: job?.data?.jobId, error: err.message });
});

logger.info('Worker listening for jobs on queue "image-processing"...');
