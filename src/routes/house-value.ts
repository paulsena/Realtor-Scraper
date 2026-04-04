import { Router } from 'express';
import { v4 as uuidv4 } from 'uuid';
import { ScraperService } from '../services/scraper-service.js';

/** Set via `initHouseValueRoute` before the server starts. */
let service: ScraperService;

export function initHouseValueRoute(s: ScraperService): void {
  service = s;
}

const router = Router();

/**
 * @openapi
 * /api/house-value:
 *   get:
 *     summary: Get property valuation
 *     description: >
 *       Scrapes Zillow, Redfin, and Realtor.com in parallel for the given address.
 *       Results are cached in SQLite — repeat requests for the same address return
 *       instantly without re-scraping. Each scraper has an independent timeout so
 *       a slow or blocked site does not prevent results from the others.
 *     tags:
 *       - Scraper
 *     security:
 *       - ApiKeyAuth: []
 *     parameters:
 *       - in: query
 *         name: address
 *         required: true
 *         schema:
 *           type: string
 *           maxLength: 200
 *         description: Full property address to look up (e.g. "123 Main St, Springfield, IL 62701")
 *     responses:
 *       200:
 *         description: Scrape results from all three sites
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 requestId:
 *                   type: string
 *                   format: uuid
 *                 address:
 *                   type: string
 *                   description: Normalized address used for cache lookup
 *                 cached:
 *                   type: boolean
 *                   description: Whether this response was served from cache
 *                 durationMs:
 *                   type: number
 *                   description: Total time taken in milliseconds
 *                 results:
 *                   type: object
 *                   properties:
 *                     zillow:
 *                       $ref: '#/components/schemas/ScrapeResult'
 *                     redfin:
 *                       $ref: '#/components/schemas/ScrapeResult'
 *                     realtor:
 *                       $ref: '#/components/schemas/ScrapeResult'
 *                 timestamp:
 *                   type: string
 *                   format: date-time
 *       400:
 *         description: Missing, empty, or too-long address parameter
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 error:
 *                   type: string
 *       401:
 *         description: Missing or invalid X-API-Key header
 *       500:
 *         description: Internal server error
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 error:
 *                   type: string
 *                 requestId:
 *                   type: string
 *                   format: uuid
 *
 * components:
 *   schemas:
 *     ScrapeResult:
 *       type: object
 *       properties:
 *         status:
 *           type: string
 *           enum: [success, timeout, error, blocked]
 *           description: Outcome of the scrape for this site
 *         estimatedPrice:
 *           type: number
 *           description: Estimated property value in USD
 *         details:
 *           type: object
 *           properties:
 *             beds:
 *               type: number
 *             baths:
 *               type: number
 *             sqft:
 *               type: number
 *             yearBuilt:
 *               type: number
 *             lotSize:
 *               type: string
 *         salesHistory:
 *           type: array
 *           items:
 *             type: object
 *             properties:
 *               date:
 *                 type: string
 *               price:
 *                 type: number
 *               event:
 *                 type: string
 *         taxHistory:
 *           type: array
 *           items:
 *             type: object
 *             properties:
 *               year:
 *                 type: number
 *               tax:
 *                 type: number
 *               assessment:
 *                 type: number
 *         comparables:
 *           type: array
 *           items:
 *             type: object
 *             properties:
 *               address:
 *                 type: string
 *               price:
 *                 type: number
 *               beds:
 *                 type: number
 *               baths:
 *                 type: number
 *               sqft:
 *                 type: number
 *         error:
 *           type: string
 *           description: Error message if status is not success
 */
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
