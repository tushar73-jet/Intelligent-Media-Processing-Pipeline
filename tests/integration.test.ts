/**
 * Integration tests — Full pipeline: Upload → Queue → DB
 *
 * In CI (CI=true): uses the postgres/redis service containers declared in ci.yml.
 * Locally with Docker available: uses testcontainers automatically.
 * Locally WITHOUT Docker: set SKIP_INTEGRATION=true to skip gracefully.
 */
import request from 'supertest';
import path from 'path';
import fs from 'fs';

const isCi        = process.env.CI === 'true';
const skipLocally = !isCi && process.env.SKIP_INTEGRATION === 'true';

const describeOrSkip = skipLocally ? describe.skip : describe;

let pool: any;
let redisConnection: any;
let app: any;
let imageProcessingQueue: any;

beforeAll(async () => {
  if (!isCi) {
    // Local dev: spin up real containers via testcontainers
    const { PostgreSqlContainer } = require('@testcontainers/postgresql');
    const { RedisContainer }       = require('@testcontainers/redis');

    const postgresContainer = await new PostgreSqlContainer('postgres:15-alpine')
      .withDatabase('media_pipeline')
      .start();
    const redisContainer = await new RedisContainer('redis:7-alpine').start();

    process.env.DATABASE_URL = postgresContainer.getConnectionUri();
    process.env.REDIS_HOST   = redisContainer.getHost();
    process.env.REDIS_PORT   = String(redisContainer.getMappedPort(6379));
  }
  // In CI, DATABASE_URL / REDIS_HOST / REDIS_PORT are already set by the workflow

  // Lazy-require after env vars are populated
  const dbPool = require('../src/db/pool');
  pool = dbPool.pool;

  // Apply schema (idempotent — uses CREATE TABLE IF NOT EXISTS)
  const schema = fs.readFileSync(
    path.join(__dirname, '../src/db/schema.sql'),
    'utf-8',
  );
  await pool.query(schema);

  const queueModule = require('../src/queue');
  redisConnection      = queueModule.redisConnection;
  imageProcessingQueue = queueModule.imageProcessingQueue;

  app = require('../src/index').default;
}, 90_000);

afterAll(async () => {
  if (imageProcessingQueue) await imageProcessingQueue.close().catch(() => {});
  if (pool)                 await pool.end().catch(() => {});
  if (redisConnection)      await redisConnection.quit().catch(() => {});
  
  // Give some time for connections to close
  await new Promise(resolve => setTimeout(resolve, 500));
});

describeOrSkip('Full Pipeline Integration', () => {
  const testImagePath = path.join(__dirname, 'fixtures', 'test_image.jpg');

  beforeAll(async () => {
    // Create a minimal valid 300×300 JPEG fixture once
    if (!fs.existsSync(testImagePath)) {
      fs.mkdirSync(path.dirname(testImagePath), { recursive: true });
      const sharp = require('sharp');
      await sharp({
        create: {
          width: 300,
          height: 300,
          channels: 3,
          background: { r: 200, g: 200, b: 200 },
        },
      })
        .jpeg()
        .toFile(testImagePath);
    }
  });

  it('should accept a valid image and return a jobId (HTTP 202)', async () => {
    const res = await request(app)
      .post('/api/upload')
      .attach('image', testImagePath);

    expect(res.status).toBe(202);
    expect(res.body).toHaveProperty('jobId');
    expect(typeof res.body.jobId).toBe('string');
  });

  it('should return job status for a valid jobId', async () => {
    const uploadRes = await request(app)
      .post('/api/upload')
      .attach('image', testImagePath);

    const { jobId } = uploadRes.body;

    const statusRes = await request(app).get(`/api/status/${jobId}`);
    expect(statusRes.status).toBe(200);
    expect(statusRes.body).toHaveProperty('id', jobId);
    expect(['pending', 'processing', 'completed', 'failed']).toContain(
      statusRes.body.status,
    );
  });

  it('should return 404 for an unknown jobId', async () => {
    const res = await request(app).get(
      '/api/status/00000000-0000-0000-0000-000000000000',
    );
    expect(res.status).toBe(404);
  });
});
