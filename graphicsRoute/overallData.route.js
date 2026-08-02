const express = require('express');
const router = express.Router();

const { getOverallSlimData } = require('../graphicsController/overallData.controller.js');

router.get('/tournament/:tournamentId/round/:roundId/overall-slim', getOverallSlimData);


module.exports = router;