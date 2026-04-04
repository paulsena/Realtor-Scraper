import { Request, Response, NextFunction } from 'express';
import crypto from 'node:crypto';
import type { Config } from '../config.js';

export function authMiddleware(config: Config) {
  return (req: Request, res: Response, next: NextFunction): void => {
    // Skip auth for health and metrics endpoints
    if (req.path === '/health' || req.path === '/metrics') {
      next();
      return;
    }

    const apiKey = req.headers['x-api-key'];

    if (typeof apiKey !== 'string') {
      res.status(401).json({ error: 'Missing X-API-Key header' });
      return;
    }

    const expected = Buffer.from(config.apiKey);
    const provided = Buffer.from(apiKey);

    if (expected.length !== provided.length || !crypto.timingSafeEqual(expected, provided)) {
      res.status(401).json({ error: 'Invalid API key' });
      return;
    }

    next();
  };
}
