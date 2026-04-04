import { Router } from 'express';

const router = Router();

router.get('/api/house-value', (req, res) => {
  const address = req.query['address'];

  if (!address || typeof address !== 'string') {
    res.status(400).json({ error: 'Missing required query parameter: address' });
    return;
  }

  res.json({
    address,
    status: 'stub',
    message: 'House value endpoint not yet implemented',
    estimates: [],
  });
});

export default router;
