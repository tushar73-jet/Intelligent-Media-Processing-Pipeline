import { Queue } from 'bullmq';
import IORedis from 'ioredis';
import dotenv from 'dotenv';
 
dotenv.config();
 
const redisConfig = process.env.REDIS_URL 
  ? process.env.REDIS_URL 
  : {
      host: process.env.REDIS_HOST || 'localhost',
      port: parseInt(process.env.REDIS_PORT || '6379', 10),
    };

export const redisConnection = new IORedis(redisConfig as string | { host: string; port: number }, {
  maxRetriesPerRequest: null,
});
 
redisConnection.on('error', (err) => {
  console.error('[Redis] Connection error:', err.message);
});
 
export const imageProcessingQueue = new Queue('image-processing', {
  connection: redisConnection,
  defaultJobOptions: {
    attempts: 3,
    backoff: {
      type: 'exponential',
      delay: 1000, 
    },
    removeOnComplete: { count: 100 },
    removeOnFail:     { count: 50  },
  },
});
 