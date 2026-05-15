import fs from 'fs';
import crypto from 'crypto';
import sharp from 'sharp';
import Tesseract from 'tesseract.js';
import { pool } from '../db/pool';

export interface CheckResult {
  check_name: string;
  passed: boolean;
  confidence: number;
  detail: any;
}

export const checkBlur = async (filepath: string): Promise<CheckResult> => {
  const { data, info } = await sharp(filepath)
    .greyscale()
    .raw()
    .toBuffer({ resolveWithObject: true });

  const width = info.width;
  const height = info.height;

  let sum = 0;
  let sumSq = 0;
  let count = 0;

  // Compute Laplacian variance manually (3x3 kernel)
  for (let y = 1; y < height - 1; y++) {
    for (let x = 1; x < width - 1; x++) {
      const idx = y * width + x;
      const top = (y - 1) * width + x;
      const bottom = (y + 1) * width + x;
      const left = y * width + (x - 1);
      const right = y * width + (x + 1);

      const laplacian =
        data[top] + data[bottom] + data[left] + data[right] - 4 * data[idx];

      sum += laplacian;
      sumSq += laplacian * laplacian;
      count++;
    }
  }

  const mean = sum / count;
  const variance = sumSq / count - mean * mean;

  const threshold = 100;
  const passed = variance >= threshold;

  // Confidence heuristic: scale variance up to a max of 1.0 (at say, 500 variance)
  const confidence = Math.min(variance / (threshold * 3), 1.0);

  return {
    check_name: 'blur',
    passed,
    confidence: Number(confidence.toFixed(2)),
    detail: { variance: Number(variance.toFixed(2)) },
  };
};

export const checkBrightness = async (filepath: string): Promise<CheckResult> => {
  const stats = await sharp(filepath).stats();
  const r = stats.channels[0].mean;
  const g = stats.channels[1] ? stats.channels[1].mean : r;
  const b = stats.channels[2] ? stats.channels[2].mean : r;

  const luminance = 0.299 * r + 0.587 * g + 0.114 * b;

  let verdict = 'normal';
  let passed = true;

  if (luminance < 40) {
    verdict = 'too_dark';
    passed = false;
  } else if (luminance > 220) {
    verdict = 'overexposed';
    passed = false;
  }

  let confidence = 1.0;
  if (!passed) {
    confidence = luminance < 40 ? (40 - luminance) / 40 : (luminance - 220) / 35;
    confidence = Math.min(confidence + 0.5, 1.0); // Shift for baseline certainty
  }

  return {
    check_name: 'brightness',
    passed,
    confidence: Number(confidence.toFixed(2)),
    detail: { luminance: Number(luminance.toFixed(2)), verdict },
  };
};

export const checkDuplicate = async (filepath: string, jobId: string): Promise<CheckResult> => {
  const buffer = await fs.promises.readFile(filepath);
  const hash = crypto.createHash('sha256').update(buffer).digest('hex');

  // Update this job's hash
  await pool.query('UPDATE jobs SET hash = $1 WHERE id = $2', [hash, jobId]);

  // Find if it exists in any OTHER job
  const result = await pool.query(
    'SELECT id FROM jobs WHERE hash = $1 AND id != $2 ORDER BY created_at ASC LIMIT 1',
    [hash, jobId]
  );

  const isDuplicate = result.rows.length > 0;
  const passed = !isDuplicate;

  return {
    check_name: 'duplicate',
    passed,
    confidence: 1.0, // Hash collision is practically impossible here
    detail: {
      isDuplicate,
      originalJobId: isDuplicate ? result.rows[0].id : undefined,
    },
  };
};

export const checkScreenshot = async (filepath: string): Promise<CheckResult> => {
  const metadata = await sharp(filepath).metadata();
  const signals: string[] = [];

  const exifString = metadata.exif ? metadata.exif.toString('ascii') : '';

  if (!exifString.includes('GPSInfo')) {
    signals.push('No EXIF GPS data present');
  }

  if (metadata.space === 'srgb') {
    signals.push('Colour profile is sRGB');
  }

  if (!exifString.includes('Make') && !exifString.includes('Model')) {
    signals.push('EXIF Make/Model missing or unknown');
  }

  const w = metadata.width || 0;
  const h = metadata.height || 0;
  const commonResolutions = [
    { w: 1920, h: 1080 }, { w: 1280, h: 720 },
    { w: 2560, h: 1440 }, { w: 3840, h: 2160 },
    { w: 1125, h: 2436 }, { w: 1170, h: 2532 },
    { w: 750, h: 1334 }, { w: 1080, h: 2400 },
  ];

  const isRes = commonResolutions.some((res) => (w === res.w && h === res.h) || (w === res.h && h === res.w));
  if (isRes) {
    signals.push('Dimensions match common screen resolution');
  }

  const passed = signals.length < 3; // 3+ signals = screenshot (fails check)
  const confidence = Math.min(signals.length * 0.25, 1.0);

  return {
    check_name: 'screenshot',
    passed,
    confidence: passed ? 1.0 - confidence : confidence,
    detail: { signals },
  };
};

export const checkOCR = async (filepath: string): Promise<CheckResult> => {
  const { data } = await Tesseract.recognize(filepath, 'eng');
  
  const extractedText = data.text;
  const cleaned = extractedText.replace(/\s+/g, '').toUpperCase();
  
  // Valid plate example: MH12AB1234
  const plateRegex = /[A-Z]{2}[0-9]{2}[A-Z]{1,2}[0-9]{4}/;
  const match = cleaned.match(plateRegex);

  const plateFound = match !== null;
  const plateNumber = plateFound ? match[0] : undefined;

  // Confidence based on Tesseract's mean block confidence, or max if no plate found
  const confidence = plateFound ? (data.confidence / 100) : 1.0;

  return {
    check_name: 'ocr',
    passed: plateFound,
    confidence: Number(confidence.toFixed(2)),
    detail: {
      extractedText: extractedText.trim(),
      plateFound,
      plateNumber,
    },
  };
};

export const runAllChecks = async (filepath: string, jobId: string): Promise<CheckResult[]> => {
  return Promise.all([
    checkBlur(filepath),
    checkBrightness(filepath),
    checkDuplicate(filepath, jobId),
    checkScreenshot(filepath),
    checkOCR(filepath),
  ]);
};
