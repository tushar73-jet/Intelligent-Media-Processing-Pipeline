import { Router, Request, Response, NextFunction } from 'express';
import multer, { MulterError } from 'multer';
import path from 'path';
import fs from 'fs';
import { v4 as uuidv4 } from 'uuid';
import { pool } from '../db/pool';
import { imageProcessingQueue, redisConnection } from '../queue';
import { logger } from '../utils/logger';
import sharp from 'sharp';

const router = Router();

const uploadDir = process.env.UPLOAD_DIR || 'uploads/';
fs.mkdirSync(uploadDir, { recursive: true }); 

const storage = multer.diskStorage({
  destination: (_req, _file, cb) => cb(null, uploadDir),
  filename:    (_req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase();
    cb(null, `${uuidv4()}${ext}`);
  },
});

const upload = multer({
  storage,
  limits: { fileSize: 10 * 1024 * 1024 }, 
  fileFilter: (_req, file, cb) => {
    const allowed = /jpeg|jpg|png|webp/;
    const extOk   = allowed.test(path.extname(file.originalname).toLowerCase());
    const mimeOk  = allowed.test(file.mimetype);
    if (extOk && mimeOk) return cb(null, true);
    cb(new Error('Only jpeg, jpg, png, webp images are accepted'));
  },
});

router.post(
  '/upload',
  (req: Request, res: Response, next: NextFunction) => {
    upload.single('image')(req, res, (err) => {
      if (err instanceof MulterError) {
        return res.status(400).json({ error: `Upload error: ${err.message}` });
      }
      if (err) {
        return res.status(400).json({ error: err.message });
      }
      next();
    });
  },
  async (req: Request, res: Response) => {
    try {
      if (!req.file) {
        return res.status(400).json({ error: 'No image field found in request' });
      }

      if (req.file.size === 0) {
        fs.unlink(req.file.path, () => {}); // clean up
        return res.status(400).json({ error: 'Zero-byte uploads are not allowed' });
      }

      const { filename, path: filepath } = req.file;
      const webhookUrl = req.body.webhookUrl;

      // Validate Image Dimensions
      try {
        const metadata = await sharp(filepath).metadata();
        const width = metadata.width || 0;
        const height = metadata.height || 0;
        if (width < 200 || height < 200) {
          fs.unlink(filepath, () => {});
          return res.status(400).json({ error: 'Image resolution too low. Minimum 200x200 px required.' });
        }
      } catch (err) {
        fs.unlink(filepath, () => {});
        return res.status(400).json({ error: 'Invalid image file.' });
      }

      const result = await pool.query(
        `INSERT INTO jobs (status, filename, filepath)
         VALUES ($1, $2, $3)
         RETURNING id`,
        ['pending', filename, filepath],
      );

      const jobId = result.rows[0].id as string;

      await imageProcessingQueue.add(
        'process-image',
        { jobId, filename, filepath, webhookUrl },
        { jobId },
      );

      logger.info('Job enqueued', { jobId, filename });
      return res.status(202).json({ jobId });
    } catch (error) {
      logger.error('Upload handler error', { error });
      return res.status(500).json({ error: 'Internal server error' });
    }
  },
);

router.get('/status/:id', async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const result = await pool.query(
      `SELECT id, status, failure_reason as "failureReason", created_at as "createdAt", updated_at as "updatedAt"
       FROM jobs WHERE id = $1`,
      [id],
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Job not found' });
    }

    return res.json(result.rows[0]);
  } catch (error) {
    logger.error('Status fetch error', { error });
    return res.status(500).json({ error: 'Internal server error' });
  }
});

router.get('/status/:id/events', async (req: Request, res: Response) => {
  const { id } = req.params;

  // Set headers for SSE
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();

  const subscriber = redisConnection.duplicate();
  await subscriber.subscribe(`job-status:${id}`);

  subscriber.on('message', (channel, message) => {
    res.write(`data: ${message}\n\n`);
    const data = JSON.parse(message);
    if (data.status === 'completed' || data.status === 'failed') {
      subscriber.unsubscribe();
      subscriber.quit();
      res.end();
    }
  });

  req.on('close', () => {
    subscriber.unsubscribe();
    subscriber.quit();
  });
});

router.get('/results/:id', async (req: Request, res: Response) => {
  try {
    const { id } = req.params;

    const jobCheck = await pool.query('SELECT id, status FROM jobs WHERE id = $1', [id]);
    if (jobCheck.rows.length === 0) {
      return res.status(404).json({ error: 'Job not found' });
    }

    const results = await pool.query(
      `SELECT check_name, passed, confidence, detail, created_at
       FROM results
       WHERE job_id = $1
       ORDER BY created_at ASC`,
      [id],
    );

    const rows = results.rows as Array<{
      check_name: string;
      passed: boolean;
      confidence: number;
      detail: unknown;
      created_at: string;
    }>;

    const overallConfidence =
      rows.length > 0
        ? Number(
            (rows.reduce((s, r) => s + r.confidence, 0) / rows.length).toFixed(2),
          )
        : null;

    return res.json({
      jobId:             id,
      jobStatus:         jobCheck.rows[0].status,
      overallConfidence,
      checks:            rows,
    });
  } catch (error) {
    logger.error('Results fetch error', { error });
    return res.status(500).json({ error: 'Internal server error' });
  }
});

router.get('/analytics', async (_req: Request, res: Response) => {
  try {
    const totals = await pool.query(
      `SELECT
         COUNT(*)                                              AS total_jobs,
         COUNT(*) FILTER (WHERE status = 'completed')         AS completed,
         COUNT(*) FILTER (WHERE status = 'failed')            AS failed,
         COUNT(*) FILTER (WHERE status = 'pending')           AS pending,
         COUNT(*) FILTER (WHERE status = 'processing')        AS processing
       FROM jobs`,
    );

    const passRates = await pool.query(
      `SELECT
         check_name,
         ROUND(AVG(confidence)::numeric, 2)                   AS avg_confidence,
         ROUND((100.0 * SUM(CASE WHEN passed THEN 1 ELSE 0 END) / COUNT(*))::numeric, 1)
                                                               AS pass_rate_pct,
         COUNT(*)                                              AS total_checks
       FROM results
       GROUP BY check_name
       ORDER BY check_name`,
    );

    return res.json({
      jobs:       totals.rows[0],
      checkStats: passRates.rows,
    });
  } catch (error) {
    logger.error('Analytics error', { error });
    return res.status(500).json({ error: 'Internal server error' });
  }
});

export default router;