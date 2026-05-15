import { Worker } from 'bullmq';
import dotenv from 'dotenv';
import { redisConnection } from '../queue';
import { processImageJob } from './processor';
import { logger } from '../utils/logger';

dotenv.config();

export const imageWorker = new Worker(
  'image-processing',
  processImageJob,
  {
    connection:  redisConnection,
    concurrency: 5,          
  },
);

imageWorker.on('completed', (job) => {
  logger.info('Worker: job completed', {
    bullJobId: job.id,
    dbJobId:   job.data.jobId,
  });
});

imageWorker.on('failed', (job, err) => {
  logger.error('Worker: job failed', {
    bullJobId: job?.id,
    dbJobId:   job?.data?.jobId,
    attempt:   job?.attemptsMade,
    error:     err.message,
  });
});

imageWorker.on('error', (err) => {
  logger.error('Worker: unhandled worker error', { error: err.message });
});

logger.info('Worker started — listening on queue "image-processing"');