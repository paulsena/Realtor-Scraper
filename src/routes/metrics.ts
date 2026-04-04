import { Router } from 'express';
import { register } from '../metrics/index.js';

const router = Router();

/**
 * @openapi
 * /metrics:
 *   get:
 *     summary: Prometheus metrics
 *     description: Returns scraper metrics in Prometheus text format for consumption by a Prometheus server.
 *     tags:
 *       - System
 *     responses:
 *       200:
 *         description: Prometheus metrics in text format
 *         content:
 *           text/plain:
 *             schema:
 *               type: string
 */
router.get('/metrics', async (_req, res) => {
  res.set('Content-Type', register.contentType);
  res.end(await register.metrics());
});

export default router;
