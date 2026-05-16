import { Request, Response, NextFunction } from 'express';
import { redisConnection } from '../queue';
import { logger } from './logger';

interface TokenBucketOptions {
  capacity: number;
  fillRate: number; // tokens per second
}

export const tokenBucketLimiter = (options: TokenBucketOptions) => {
  return async (req: Request, res: Response, next: NextFunction) => {
    const apiKey = (req.headers['x-api-key'] as string) || req.ip || 'unknown';
    const key = `ratelimit:${apiKey}`;
    const now = Date.now() / 1000;

    try {
      const bucket = await redisConnection.hgetall(key);
      let tokens: number;
      let lastRefill: number;

      if (Object.keys(bucket).length === 0) {
        tokens = options.capacity;
        lastRefill = now;
      } else {
        tokens = parseFloat(bucket.tokens);
        lastRefill = parseFloat(bucket.lastRefill);

        const delta = now - lastRefill;
        tokens = Math.min(options.capacity, tokens + delta * options.fillRate);
        lastRefill = now;
      }

      if (tokens >= 1) {
        tokens -= 1;
        await redisConnection.hset(key, {
          tokens: tokens.toString(),
          lastRefill: lastRefill.toString(),
        });
        await redisConnection.expire(key, 3600); // Expire after 1 hour of inactivity
        next();
      } else {
        res.status(429).json({
          error: 'Too many requests',
          retryAfter: Math.ceil((1 - tokens) / options.fillRate),
        });
      }
    } catch (err) {
      logger.error('Rate limiter error', { err });
      next(); // Fallback to allowing request on Redis error
    }
  };
};
