import { Worker } from 'bullmq';
import IORedis from 'ioredis';
import dotenv from 'dotenv';
import { processImageJob } from './processor';

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
  console.log(`✅ Job ${job.id} (DB ID: ${job.data.jobId}) completed successfully.`);
});

imageWorker.on('failed', (job, err) => {
  console.error(`❌ Job ${job?.id} (DB ID: ${job?.data?.jobId}) failed: ${err.message}`);
});

console.log('Worker listening for jobs on queue "image-processing"...');
