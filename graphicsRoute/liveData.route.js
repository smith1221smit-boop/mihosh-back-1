const express = require('express');
const router = express.Router();

const { getLiveSlimData } = require('../graphicsController/liveData.controller.js');

router.get(
  '/tournament/:tournamentId/round/:roundId/match/:matchId/live-slim',
  getLiveSlimData
);


module.exports = router;