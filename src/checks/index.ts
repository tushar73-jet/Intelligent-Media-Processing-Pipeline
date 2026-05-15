import fs from 'fs';
import crypto from 'crypto';
import sharp from 'sharp';
import Tesseract from 'tesseract.js';
import { pool } from '../db/pool';

export interface CheckResult {
  check_name: string;
  passed: boolean;
  confidence: number;
  detail: Record<string, unknown>;
}

export const checkBlur = async (filepath: string): Promise<CheckResult> => {
  const { data, info } = await sharp(filepath)
    .greyscale()         
    .removeAlpha()      
    .raw()
    .toBuffer({ resolveWithObject: true });

  const width = info.width;
  const height = info.height;
  const buf = data as Buffer;

  let sum = 0;
  let sumSq = 0;
  let count = 0;

  for (let y = 1; y < height - 1; y++) {
    for (let x = 1; x < width - 1; x++) {
      const idx    = y * width + x;
      const top    = (y - 1) * width + x;
      const bottom = (y + 1) * width + x;
      const left   = y * width + (x - 1);
      const right  = y * width + (x + 1);

      const lap =
        buf.readUInt8(top) +
        buf.readUInt8(bottom) +
        buf.readUInt8(left) +
        buf.readUInt8(right) -
        4 * buf.readUInt8(idx);

      sum   += lap;
      sumSq += lap * lap;
      count++;
    }
  }

  const mean     = sum / count;
  const variance = sumSq / count - mean * mean;
  const threshold = 100;
  const passed   = variance >= threshold;

  const confidence = Math.min(variance / (threshold * 3), 1.0);

  return {
    check_name: 'blur',
    passed,
    confidence: Number(confidence.toFixed(2)),
    detail: { variance: Number(variance.toFixed(2)), threshold },
  };
};

export const checkBrightness = async (filepath: string): Promise<CheckResult> => {
  const stats = await sharp(filepath).stats();

  const r = stats.channels[0].mean;
  const g = stats.channels[1]?.mean ?? r;
  const b = stats.channels[2]?.mean ?? r;

  const luminance = 0.299 * r + 0.587 * g + 0.114 * b;

  let verdict = 'normal';
  let passed  = true;

  if (luminance < 40) {
    verdict = 'too_dark';
    passed  = false;
  } else if (luminance > 220) {
    verdict = 'overexposed';
    passed  = false;
  }

  let confidence: number;
  if (passed) {
    confidence = 1.0;
  } else if (luminance < 40) {
    confidence = Math.min(0.5 + (40 - luminance) / 80, 1.0);
  } else {
    confidence = Math.min(0.5 + (luminance - 220) / 70, 1.0);
  }

  return {
    check_name: 'brightness',
    passed,
    confidence: Number(confidence.toFixed(2)),
    detail: { luminance: Number(luminance.toFixed(2)), verdict },
  };
};


export const checkDuplicate = async (
  filepath: string,
  jobId: string,
  precomputedHash?: string,
): Promise<CheckResult> => {
  const hash =
    precomputedHash ??
    crypto
      .createHash('sha256')
      .update(await fs.promises.readFile(filepath))
      .digest('hex');

  const result = await pool.query(
    `SELECT id FROM jobs
     WHERE hash = $1
       AND id != $2
     ORDER BY created_at ASC
     LIMIT 1`,
    [hash, jobId],
  );

  const isDuplicate     = result.rows.length > 0;
  const originalJobId   = isDuplicate ? (result.rows[0].id as string) : undefined;

  return {
    check_name: 'duplicate',
    passed:     !isDuplicate,
    confidence: 1.0,
    detail: { isDuplicate, originalJobId },
  };
};


export const checkScreenshot = async (filepath: string): Promise<CheckResult> => {
  const metadata = await sharp(filepath).metadata();
  const signals: string[] = [];
  let weightedScore = 0;

  const exifBuf = metadata.exif;
  const exifStr = exifBuf ? exifBuf.toString('binary') : '';

  if (!exifStr.includes('GPS')) {
    signals.push('No EXIF GPS data');
    weightedScore += 0.15;
  }

  if (metadata.space === 'srgb' && !exifStr.includes('Make')) {
    signals.push('sRGB profile with no camera Make tag');
    weightedScore += 0.25;
  }

  if (!exifStr.includes('Make') && !exifStr.includes('Model')) {
    signals.push('EXIF Make/Model absent');
    weightedScore += 0.35;
  }

  const w = metadata.width  ?? 0;
  const h = metadata.height ?? 0;
  const screenResolutions = [
    [1920, 1080], [1280, 720],  [2560, 1440], [3840, 2160],
    [1125, 2436], [1170, 2532], [750,  1334], [1080, 2400],
    [1284, 2778], [1179, 2556], [393,  852],  [390,  844],
  ];
  const matchesScreen = screenResolutions.some(
    ([rw, rh]) => (w === rw && h === rh) || (w === rh && h === rw),
  );
  if (matchesScreen) {
    signals.push('Dimensions match a common screen resolution');
    weightedScore += 0.40;
  }

  if (!exifBuf || exifBuf.length < 10) {
    signals.push('No EXIF data at all');
    weightedScore += 0.30;
  }

  const isScreenshot = weightedScore >= 0.60;
  const confidence   = Math.min(weightedScore, 1.0);

  return {
    check_name: 'screenshot',
    passed:     !isScreenshot,
    confidence: Number(confidence.toFixed(2)),
    detail:     { signals, weightedScore: Number(weightedScore.toFixed(2)) },
  };
};


export const checkOCR = async (filepath: string): Promise<CheckResult> => {
  // Fix: Read file into a buffer first, as Tesseract.js struggles with raw filepaths on some Node/macOS environments
  const imageBuffer = await fs.promises.readFile(filepath);
  
  const { data } = await Tesseract.recognize(imageBuffer, 'eng', {
    logger: () => {},
  });

  const extractedText = data.text ?? '';
  const cleaned       = extractedText.replace(/[\s\-]/g, '').toUpperCase();

  const plateRegex = /[A-Z]{2}[0-9]{2}[A-Z]{1,2}[0-9]{4}/g;
  const matches    = cleaned.match(plateRegex) ?? [];

  const plateFound  = matches.length > 0;
  const plateNumber = plateFound ? matches[0] : undefined;


  const tesseractConf = (data.confidence ?? 0) / 100;
  const confidence    = Number(Math.max(tesseractConf, 0.05).toFixed(2)); // floor at 0.05

  return {
    check_name: 'ocr',
    passed:     plateFound,
    confidence,
    detail: {
      extractedText: extractedText.trim(),
      plateFound,
      plateNumber,
      allMatches: matches,
    },
  };
};

export const computeFileHash = async (filepath: string): Promise<string> => {
  const buffer = await fs.promises.readFile(filepath);
  return crypto.createHash('sha256').update(buffer).digest('hex');
};

export const runAllChecks = async (
  filepath: string,
  jobId: string,
  fileHash: string,           
): Promise<CheckResult[]> => {
  return Promise.all([
    checkBlur(filepath),
    checkBrightness(filepath),
    checkDuplicate(filepath, jobId, fileHash),
    checkScreenshot(filepath),
    checkOCR(filepath),
  ]);
};