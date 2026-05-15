import { Router } from 'express';
import multer from 'multer';
import path from 'path';
import { v4 as uuidv4 } from 'uuid';
import { pool } from '../db/pool';
import { imageProcessingQueue } from '../queue';
import { logger } from '../utils/logger';

const router = Router();


const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    cb(null, process.env.UPLOAD_DIR || 'uploads/');
  },
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname);
    cb(null, `${uuidv4()}${ext}`);
  },
});

const upload = multer({
  storage,
  limits: { fileSize: 10 * 1024 * 1024 }, // 10MB
  fileFilter: (req, file, cb) => {
    const allowedTypes = /jpeg|jpg|png|webp/;
    const extname = allowedTypes.test(path.extname(file.originalname).toLowerCase());
    const mimetype = allowedTypes.test(file.mimetype);
    if (extname && mimetype) {
      return cb(null, true);
    }
    cb(new Error('Only images (jpeg, jpg, png, webp) are allowed'));
  },
});


router.post('/upload', upload.single('image'), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: 'No image uploaded' });
    }

    const { filename, path: filepath } = req.file;


    const result = await pool.query(
      'INSERT INTO jobs (status, filename, filepath) VALUES ($1, $2, $3) RETURNING id',
      ['pending', filename, filepath]
    );

    const jobId = result.rows[0].id;


    await imageProcessingQueue.add('process-image', {
      jobId,
      filename,
      filepath,
    });

    res.status(202).json({ jobId });
  } catch (error) {
    logger.error('Upload error:', { error });
    res.status(500).json({ error: 'Internal server error' });
  }
});


router.get('/status/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const result = await pool.query(
      'SELECT id, status, failure_reason, created_at FROM jobs WHERE id = $1',
      [id]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Job not found' });
    }

    res.json(result.rows[0]);
  } catch (error) {
    logger.error('Status fetch error:', { error });
    res.status(500).json({ error: 'Internal server error' });
  }
});


router.get('/results/:id', async (req, res) => {
  try {
    const { id } = req.params;
    
    const jobCheck = await pool.query('SELECT id FROM jobs WHERE id = $1', [id]);
    if (jobCheck.rows.length === 0) {
      return res.status(404).json({ error: 'Job not found' });
    }

    const result = await pool.query(
      'SELECT check_name, passed, confidence, detail, created_at FROM results WHERE job_id = $1',
      [id]
    );

    res.json(result.rows);
  } catch (error) {
    logger.error('Results fetch error:', { error });
    res.status(500).json({ error: 'Internal server error' });
  }
});

export default router;
