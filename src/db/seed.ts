import { pool } from './pool';
import { logger } from '../utils/logger';

const seedDatabase = async () => {
  logger.info('Starting database seeding...');
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // Clear existing data
    await client.query('TRUNCATE TABLE results, jobs CASCADE');

    logger.info('Inserting mock jobs...');
    const jobs = [
      {
        status: 'completed',
        filename: 'valid_plate_1.jpg',
        filepath: 'uploads/valid_plate_1.jpg',
        hash: 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
        dhash: '8f8f8f8f8f8f8f8f',
      },
      {
        status: 'completed',
        filename: 'blurry_image.jpg',
        filepath: 'uploads/blurry_image.jpg',
        hash: '1b4f0e9851971998b73a4c06a4430e8c897f26c7104b904210100fcfcfcfcfcf',
        dhash: '0f0f0f0f0f0f0f0f',
      },
      {
        status: 'failed',
        filename: 'corrupted.png',
        filepath: 'uploads/corrupted.png',
        hash: 'c3ab8ff13720e8ad9047dd39466b3c8974e592c2fa383d4a3960710101010101',
        dhash: 'ffffffffffffffff',
        failure_reason: 'File corruption detected: Invalid image file',
      },
    ];

    import fs from 'fs';
    import path from 'path';
    const uploadDir = path.join(__dirname, '../../uploads');
    if (!fs.existsSync(uploadDir)) {
      fs.mkdirSync(uploadDir, { recursive: true });
    }

    const insertedJobs = [];
    for (const job of jobs) {
      const fullPath = path.join(__dirname, '../../', job.filepath);
      fs.writeFileSync(fullPath, 'dummy image data');
      const res = await client.query(
        `INSERT INTO jobs (status, filename, filepath, hash, dhash, failure_reason)
         VALUES ($1, $2, $3, $4, $5, $6)
         RETURNING id, filename`,
        [job.status, job.filename, job.filepath, job.hash, job.dhash, job.failure_reason || null]
      );
      insertedJobs.push(res.rows[0]);
    }

    logger.info('Inserting mock check results...');
    const mockResults = [
      // Results for valid_plate_1.jpg
      {
        job_id: insertedJobs[0].id,
        check_name: 'blur',
        passed: true,
        confidence: 0.95,
        detail: { variance: 320.4, threshold: 100 },
      },
      {
        job_id: insertedJobs[0].id,
        check_name: 'brightness',
        passed: true,
        confidence: 1.0,
        detail: { luminance: 128.5, verdict: 'normal' },
      },
      {
        job_id: insertedJobs[0].id,
        check_name: 'ocr',
        passed: true,
        confidence: 0.92,
        detail: { extractedText: 'MH02CL1234', plateFound: true, plateNumber: 'MH02CL1234' },
      },
      {
        job_id: insertedJobs[0].id,
        check_name: 'screenshot',
        passed: true,
        confidence: 0.15,
        detail: { signals: ['No EXIF GPS data'], weightedScore: 0.15 },
      },
      // Results for blurry_image.jpg
      {
        job_id: insertedJobs[1].id,
        check_name: 'blur',
        passed: false,
        confidence: 0.25,
        detail: { variance: 24.8, threshold: 100 },
      },
      {
        job_id: insertedJobs[1].id,
        check_name: 'brightness',
        passed: true,
        confidence: 1.0,
        detail: { luminance: 110.2, verdict: 'normal' },
      },
    ];

    for (const result of mockResults) {
      await client.query(
        `INSERT INTO results (job_id, check_name, passed, confidence, detail)
         VALUES ($1, $2, $3, $4, $5)`,
        [result.job_id, result.check_name, result.passed, result.confidence, JSON.stringify(result.detail)]
      );
    }

    await client.query('COMMIT');
    logger.info('Database seeded successfully!');
  } catch (error) {
    await client.query('ROLLBACK');
    logger.error('Error seeding database:', error);
  } finally {
    client.release();
    await pool.end();
  }
};

seedDatabase();
