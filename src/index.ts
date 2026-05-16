import './tracing';
import express, { Request, Response, NextFunction } from 'express';
import dotenv from 'dotenv';
import addRequestId from 'express-request-id';
import promClient from 'prom-client';
import { tokenBucketLimiter } from './utils/rateLimiter';
import jobRoutes from './routes/jobRoutes';
import { logger } from './utils/logger';
import { imageProcessingQueue } from './queue';
import { pool } from './db/pool';

dotenv.config();

const app  = express();
const PORT = parseInt(process.env.PORT || '3000', 10);

// Setup Prometheus metrics
const collectDefaultMetrics = promClient.collectDefaultMetrics;
collectDefaultMetrics({ prefix: 'media_pipeline_' });

const queueDepthGauge = new promClient.Gauge({
  name: 'media_pipeline_queue_depth',
  help: 'Current depth of the image processing queue',
  labelNames: ['status'],
});

const jobsProcessedGauge = new promClient.Gauge({
  name: 'media_pipeline_jobs_processed_total',
  help: 'Total jobs processed',
  labelNames: ['status'],
});

const checkPassRatesGauge = new promClient.Gauge({
  name: 'media_pipeline_check_pass_rate',
  help: 'Pass rate percentage of different checks',
  labelNames: ['check_name'],
});

const updateQueueMetrics = async () => {
  try {
    const counts = await imageProcessingQueue.getJobCounts('wait', 'active', 'completed', 'failed', 'delayed');
    queueDepthGauge.set({ status: 'wait' }, counts.wait);
    queueDepthGauge.set({ status: 'active' }, counts.active);
    queueDepthGauge.set({ status: 'completed' }, counts.completed);
    queueDepthGauge.set({ status: 'failed' }, counts.failed);
    queueDepthGauge.set({ status: 'delayed' }, counts.delayed);

    // Fetch DB analytics
    const totals = await pool.query(
      `SELECT status, COUNT(*) as count FROM jobs GROUP BY status`
    );
    totals.rows.forEach((row: { status: string, count: string }) => {
      jobsProcessedGauge.set({ status: row.status }, parseInt(row.count, 10));
    });

    const passRates = await pool.query(
      `SELECT check_name, (SUM(CASE WHEN passed THEN 1 ELSE 0 END) * 100.0 / COUNT(*)) AS pass_rate
       FROM results GROUP BY check_name`
    );
    passRates.rows.forEach((row: { check_name: string, pass_rate: string }) => {
      checkPassRatesGauge.set({ check_name: row.check_name }, parseFloat(row.pass_rate));
    });

  } catch (err) {
    logger.error('Failed to update metrics', { error: err });
  }
};
setInterval(updateQueueMetrics, 10000);

app.use(addRequestId());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static('public'));

app.use((req: Request, _res: Response, next: NextFunction) => {
  // @ts-expect-error req.id is injected by express-request-id
  logger.info('Incoming request', { method: req.method, url: req.url, reqId: req.id });
  next();
});

// Rate limiting: Token Bucket semantics, 20 capacity, refill 1 every 45 seconds
const uploadLimiter = tokenBucketLimiter({
  capacity: 20,
  fillRate: 1 / 45, // 20 tokens per 15 mins -> 1 token every 45s
});

app.use('/api/upload', uploadLimiter);
app.use('/api', jobRoutes);

app.get('/metrics', async (_req: Request, res: Response) => {
  res.set('Content-Type', promClient.register.contentType);
  res.end(await promClient.register.metrics());
});

app.get('/health', (_req: Request, res: Response) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

app.use((_req: Request, res: Response) => {
  res.status(404).json({ error: 'Route not found' });
});

app.use((err: Error, req: Request, res: Response, _next: NextFunction) => {
  // @ts-expect-error reqId is attached to req by express-request-id middleware
  logger.error('Unhandled Express error', { error: err.message, stack: err.stack, reqId: req.id });
  res.status(500).json({ error: 'Internal server error' });
});

if (process.env.NODE_ENV !== 'test') {
  app.listen(PORT, () => {
    logger.info(`Server running on port ${PORT}`, { env: process.env.NODE_ENV });
  });
}

export default app;