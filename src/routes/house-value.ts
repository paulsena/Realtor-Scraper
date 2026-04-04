import { Router } from 'express';
import { v4 as uuidv4 } from 'uuid';
import { ScraperService } from '../services/scraper-service.js';

/** Set via `initHouseValueRoute` before the server starts. */
let service: ScraperService;

export function initHouseValueRoute(s: ScraperService): void {
  service = s;
}

const router = Router();

router.get('/api/house-value', async (req, res) => {
  const requestId = uuidv4();

  try {
    const address = req.query['address'];
    if (!address || typeof address !== 'string' || address.trim().length === 0) {
      res.status(400).json({ error: 'Missing or empty required query parameter: address' });
      return;
    }
    if (address.length > 200) {
      res.status(400).json({ error: 'Address must be 200 characters or fewer' });
      return;
    }

    const response = await service.scrape(address);

    res.json({
      requestId,
      ...response,
      timestamp: new Date().toISOString(),
    });
  } catch (err) {
    res.status(500).json({ error: 'Internal server error', requestId });
  }
});

export default router;
