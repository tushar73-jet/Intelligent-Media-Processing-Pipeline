import sharp from 'sharp';
import crypto from 'crypto';
import path from 'path';
import fs from 'fs';
import os from 'os';

// Helper to generate a valid test image buffer via sharp
const makeImageBuffer = async (opts: {
  width?: number;
  height?: number;
  r?: number;
  g?: number;
  b?: number;
} = {}): Promise<Buffer> => {
  const { width = 400, height = 200, r = 128, g = 128, b = 128 } = opts;
  return sharp({
    create: { width, height, channels: 3, background: { r, g, b } },
  })
    .jpeg()
    .toBuffer();
};

// Write buffer to a temp file and return its path
let counter = 0;
const writeTempFile = async (buf: Buffer, ext = '.jpg'): Promise<string> => {
  const filepath = path.join(os.tmpdir(), `test_${Date.now()}_${counter++}${ext}`);
  await fs.promises.writeFile(filepath, buf);
  return filepath;
};

// ─────────────────────────────────────────────────────────────────────────────
// 1. checkBlur
// ─────────────────────────────────────────────────────────────────────────────
describe('checkBlur', () => {
  let checkBlur: (filepath: string) => Promise<any>;

  beforeAll(async () => {
    ({ checkBlur } = await import('../src/checks/index'));
  });

  it('should return passed=false for a flat (solid-colour) image (low variance)', async () => {
    const buf = await makeImageBuffer({ r: 255, g: 255, b: 255 });
    const filepath = await writeTempFile(buf);
    const result = await checkBlur(filepath);
    expect(result.check_name).toBe('blur');
    expect(result.passed).toBe(false);          // solid image has zero variance
    expect(result.detail.variance).toBeLessThan(100);
    fs.unlinkSync(filepath);
  });

  it('should include variance and threshold in detail', async () => {
    const buf = await makeImageBuffer();
    const filepath = await writeTempFile(buf);
    const result = await checkBlur(filepath);
    expect(result.detail).toHaveProperty('variance');
    expect(result.detail).toHaveProperty('threshold');
    fs.unlinkSync(filepath);
  });

  it('confidence should be between 0 and 1', async () => {
    const buf = await makeImageBuffer();
    const filepath = await writeTempFile(buf);
    const result = await checkBlur(filepath);
    expect(result.confidence).toBeGreaterThanOrEqual(0);
    expect(result.confidence).toBeLessThanOrEqual(1);
    fs.unlinkSync(filepath);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 2. checkBrightness
// ─────────────────────────────────────────────────────────────────────────────
describe('checkBrightness', () => {
  let checkBrightness: (filepath: string) => Promise<any>;

  beforeAll(async () => {
    ({ checkBrightness } = await import('../src/checks/index'));
  });

  it('should detect overexposed image (all white)', async () => {
    const buf = await makeImageBuffer({ r: 255, g: 255, b: 255 });
    const filepath = await writeTempFile(buf);
    const result = await checkBrightness(filepath);
    expect(result.passed).toBe(false);
    expect(result.detail.verdict).toBe('overexposed');
    expect(result.detail.luminance).toBeGreaterThan(220);
    fs.unlinkSync(filepath);
  });

  it('should detect too dark image (all black)', async () => {
    const buf = await makeImageBuffer({ r: 0, g: 0, b: 0 });
    const filepath = await writeTempFile(buf);
    const result = await checkBrightness(filepath);
    expect(result.passed).toBe(false);
    expect(result.detail.verdict).toBe('too_dark');
    expect(result.detail.luminance).toBeLessThan(40);
    fs.unlinkSync(filepath);
  });

  it('should pass for a normal-brightness image', async () => {
    const buf = await makeImageBuffer({ r: 120, g: 120, b: 120 });
    const filepath = await writeTempFile(buf);
    const result = await checkBrightness(filepath);
    expect(result.passed).toBe(true);
    expect(result.detail.verdict).toBe('normal');
    fs.unlinkSync(filepath);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 3. computeFileHash (determinism test)
// ─────────────────────────────────────────────────────────────────────────────
describe('computeFileHash', () => {
  let computeFileHash: (filepath: string) => Promise<string>;

  beforeAll(async () => {
    ({ computeFileHash } = await import('../src/checks/index'));
  });

  it('should return a deterministic SHA-256 hex string', async () => {
    const buf = await makeImageBuffer();
    const filepath = await writeTempFile(buf);
    const hash1 = await computeFileHash(filepath);
    const hash2 = await computeFileHash(filepath);
    expect(hash1).toBe(hash2);
    expect(hash1).toHaveLength(64);           // SHA-256 = 64 hex chars
    expect(hash1).toMatch(/^[a-f0-9]+$/);
    fs.unlinkSync(filepath);
  });

  it('should return different hashes for different content', async () => {
    const f1 = await writeTempFile(Buffer.from('hello world file one'));
    const f2 = await writeTempFile(Buffer.from('completely different content two'));
    const h1 = await computeFileHash(f1);
    const h2 = await computeFileHash(f2);
    expect(h1).not.toBe(h2);
    fs.unlinkSync(f1);
    fs.unlinkSync(f2);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 4. checkScreenshot
// ─────────────────────────────────────────────────────────────────────────────
describe('checkScreenshot', () => {
  let checkScreenshot: (filepath: string) => Promise<any>;

  beforeAll(async () => {
    ({ checkScreenshot } = await import('../src/checks/index'));
  });

  it('should return screenshot check result with signals array in detail', async () => {
    const buf = await makeImageBuffer();
    const filepath = await writeTempFile(buf);
    const result = await checkScreenshot(filepath);
    expect(result.check_name).toBe('screenshot');
    expect(result.detail).toHaveProperty('signals');
    expect(Array.isArray(result.detail.signals)).toBe(true);
    expect(result.detail).toHaveProperty('weightedScore');
    fs.unlinkSync(filepath);
  });

  it('confidence should be between 0 and 1', async () => {
    const buf = await makeImageBuffer();
    const filepath = await writeTempFile(buf);
    const result = await checkScreenshot(filepath);
    expect(result.confidence).toBeGreaterThanOrEqual(0);
    expect(result.confidence).toBeLessThanOrEqual(1);
    fs.unlinkSync(filepath);
  });

  it('should flag a common screen resolution (1920x1080) as a signal', async () => {
    // Create a 1920x1080 image — should trigger the screen resolution signal
    const buf = await sharp({
      create: { width: 1920, height: 1080, channels: 3, background: { r: 200, g: 200, b: 200 } },
    }).jpeg().toBuffer();
    const filepath = await writeTempFile(buf);
    const result = await checkScreenshot(filepath);
    const hasResSignal = result.detail.signals.some((s: string) =>
      s.toLowerCase().includes('resolution'),
    );
    expect(hasResSignal).toBe(true);
    fs.unlinkSync(filepath);
  });
});
