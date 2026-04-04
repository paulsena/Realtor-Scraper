import express from 'express';
import type { Request, Response, NextFunction } from 'express';
import type { Config } from './config.js';
import { authMiddleware } from './middleware/auth.js';
import { createLogger } from './utils/logger.js';
import healthRouter from './routes/health.js';
import metricsRouter from './routes/metrics.js';
import houseValueRouter from './routes/house-value.js';

export function createApp(config: Config): express.Express {
  const app = express();
  const logger = createLogger(config.logLevel);

  app.use(express.json());
  app.use(authMiddleware(config));

  app.use(healthRouter);
  app.use(metricsRouter);
  app.use(houseValueRouter);

  // 404 catch-all
  app.use((_req, res) => {
    res.status(404).json({ error: 'Not found' });
  });

  // Global error handler
  app.use((err: Error, _req: Request, res: Response, _next: NextFunction) => {
    logger.error({ err }, 'Unhandled error');
    res.status(500).json({ error: 'Internal server error' });
  });

  return app;
}
