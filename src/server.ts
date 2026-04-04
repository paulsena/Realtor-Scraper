import express from 'express';
import type { Config } from './config.js';
import { authMiddleware } from './middleware/auth.js';
import healthRouter from './routes/health.js';
import metricsRouter from './routes/metrics.js';
import houseValueRouter from './routes/house-value.js';

export function createApp(config: Config): express.Express {
  const app = express();

  app.use(express.json());
  app.use(authMiddleware(config));

  app.use(healthRouter);
  app.use(metricsRouter);
  app.use(houseValueRouter);

  return app;
}
