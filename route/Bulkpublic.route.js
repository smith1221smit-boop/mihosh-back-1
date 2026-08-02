const express = require('express');
const router = express.Router();
const { getBulkData } = require('../controller/Bulkpublic.controller');
const { msgpackCacheMiddleware } = require('../middleware/cache.js');

/**
 * GET /api/public/bulk/:tournamentId/:roundId/:matchId?
 *
 * Query params:
 *   view            - optional. If set, only fetches the data that view needs
 *                      (same rules PublicThemeRenderer.tsx uses). Omit to get everything.
 *   followSelected  - "true" | "false". If true, matchId is resolved from the
 *                      currently-selected match instead of the URL param.
 *   includeAll      - "true" | "false". Force-fetch everything regardless of `view`.
 *
 * Example:
 *   /api/public/bulk/64f.../64f2.../64f3...?view=Upper
 *   /api/public/bulk/64f.../64f2...?followSelected=true   (no matchId needed)
 */
router.get(
  '/bulk/:tournamentId/:roundId/:matchId',
  msgpackCacheMiddleware(3, req => `round:${req.params.tournamentId}:${req.params.roundId}`),
  getBulkData
);

module.exports = router;