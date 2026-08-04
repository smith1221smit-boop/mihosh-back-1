#!/usr/bin/env node
require('dotenv').config({ path: './.env' });

const dns = require("dns");

dns.setServers([
  "8.8.8.8",
  "8.8.4.4",
]);

// Load configuration
const config = require('./config');

const express = require('express');
const mongoose = require('mongoose');
const cors = require('cors');
const compression = require('compression');
const http = require('http');
const session = require('express-session');
const MongoStore = require('connect-mongo');
const { initializeSocket } = require('./socket.js');
const axios = require(require.resolve('axios'));
// Import routes
const groupRoutes = require('./route/group.route.js');
const teamRoutes = require('./route/team.route.js');
const tournamentRoutes = require('./route/tournament.route.js');
const roundRoutes = require('./route/round.route.js');
const matchRoutes = require('./route/match.route.js');
const matchDataRoutes = require('./route/matchData.route.js');
const matchSelectionRoutes = require('./route/matchSelection.route.js');
const overallRoutes = require('./route/overall.route.js');

const userRoutes = require('./route/User.route.js');
const bulkRoutes = require('./route/Bulkpublic.route.js');

const { cacheMiddleware } = require('./middleware/cache.js');

// --- DECLARE APP AND PORT ---
const app = express();
const port = process.env.PORT || 3000;

// Trust proxy (required for Render.com and other cloud platforms)
app.set('trust proxy', 1);

// Enable compression for all responses
app.use(compression());

// Auto-detect production environment
const isProduction = process.env.NODE_ENV === 'production' || process.env.RENDER === 'true' || process.env.REACT_APP_API_URL?.includes('render.com');
console.log('🔧 Environment:', isProduction ? 'PRODUCTION' : 'DEVELOPMENT');
console.log('🔧 NODE_ENV:', process.env.NODE_ENV);
console.log('🔧 RENDER:', process.env.RENDER);
console.log('🔧 REACT_APP_API_URL:', process.env.REACT_APP_API_URL);

// For local development with IP addresses, treat as development
const isLocalIP = process.env.NODE_ENV !== 'production' && !process.env.RENDER && !process.env.REACT_APP_API_URL?.includes('render.com');
console.log('🔧 Local IP mode:', isLocalIP);

// Force HTTPS in production to ensure backend is HTTPS (critical for iOS login)
if (isProduction) {
  app.use((req, res, next) => {
    if (req.header('x-forwarded-proto') !== 'https') {
      res.redirect(`https://${req.header('host')}${req.url}`);
    } else {
      next();
    }
  });
}



// --- CONNECT TO REDIS ---
const { Redis } = require('@upstash/redis');
const redisClient = new Redis({
  url: config.UPSTASH_REDIS_REST_URL,
  token: config.UPSTASH_REDIS_REST_TOKEN
});

redisClient.ping().then(() => {
  console.log('✅ Redis connected (new hosted Upstash)');
}).catch(err => {
  console.error('❌ Redis connection error:', err.message);
});

// --- MIDDLEWARES ---
// CORS must come first
const allowedOrigins = [
  "http://localhost:3001",
  "http://localhost:1420",
    "https://ramus-front12.vercel.app",
  "http://tauri.localhost",
  "tauri://com.admin.tauri-app",
  "tauri://localhost",
  "https://scoresync-v1.vercel.app",
  "capacitor://localhost",
  "http://localhost",
  "http://localhost:8080"
];

// Enhanced CORS configuration for iOS
app.use(cors({
  origin: function (origin, callback) {
    // Allow requests with no origin (like mobile apps or curl requests)
    if (!origin) return callback(null, true);

    // Check if origin is allowed OR if it's a Vercel preview deployment
    if (allowedOrigins.includes(origin) ||
        origin.includes('.vercel.app') ||
        origin.includes('//localhost') ||
        origin.startsWith('capacitor://') ||
        origin.startsWith('http://192.168.')) {
      return callback(null, true);
    }

    console.warn('⚠️ CORS blocked origin:', origin);
    return callback(new Error('Not allowed by CORS'));
  },
  credentials: true,
  methods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
  allowedHeaders: [
    "Content-Type",
    "Authorization",
    "x-cookie",
    "X-Requested-With",
    "Accept",
    "Origin",
    "Cache-Control",
    "Pragma",
    "Expires"
  ],
  exposedHeaders: ["set-cookie", "Authorization"],
  maxAge: 600 // Cache preflight requests for 10 minutes
}));

// Add OPTIONS handler for preflight requests
app.use((req, res, next) => {
  if (req.method === 'OPTIONS') {
    res.header('Access-Control-Allow-Origin', req.headers.origin || '*');
    res.header('Access-Control-Allow-Credentials', 'true');
    res.header('Access-Control-Allow-Methods', 'GET, POST, PUT, PATCH, DELETE, OPTIONS');
    res.header('Access-Control-Allow-Headers', 'Content-Type, Authorization, x-cookie, X-Requested-With, Accept, Origin, Cache-Control, Pragma, Expires');
    res.header('Access-Control-Max-Age', '600');
    res.sendStatus(200);
    return;
  }
  next();
});

app.use(express.json());

// Enhanced middleware for handling cookies and security headers
app.use((req, res, next) => {
  // Handle custom cookie header for Tauri
  if (req.headers['x-cookie']) {
    req.headers.cookie = req.headers['x-cookie'];
  }
  
  // Add security headers
  res.header('X-Content-Type-Options', 'nosniff');
  res.header('X-Frame-Options', 'SAMEORIGIN');
  res.header('X-XSS-Protection', '1; mode=block');
  
  // For API responses, prevent caching
  if (req.method === 'OPTIONS' || req.path.startsWith('/api/')) {
    res.header('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
    res.header('Pragma', 'no-cache');
    res.header('Expires', '0');
  }
  
  next();
});

// Enhanced session store configuration
const sessionStore = MongoStore.create({
  mongoUrl: config.MONGODB_URI,
  collectionName: 'sessions',
  ttl: 7 * 24 * 60 * 60, // 7 days in seconds
  autoRemove: 'interval',
  autoRemoveInterval: 60, // Remove expired sessions every hour
  clientOptions: {
    serverSelectionTimeoutMS: 5000,
    connectTimeoutMS: 10000,
    socketTimeoutMS: 45000,
    maxPoolSize: 10,
    family: 4
  }
});

// Enhanced session configuration for iOS compatibility
const sessionMiddleware = session({
  secret: config.SESSION_SECRET,
  name: 'scoreSync.sid', // Custom session cookie name
  resave: false,
  saveUninitialized: false,
  store: sessionStore,
  proxy: true, // Trust the reverse proxy (important for HTTPS)
  cookie: {
    secure: true, // Only secure in true production, not local IP
    httpOnly: true, // Prevent client-side JS from accessing the cookie
    sameSite: 'none', // 'none' only for true production
    maxAge: 7 * 24 * 60 * 60 * 1000, // 7 days
    domain: undefined, // Don't set domain for cross-site cookies between different TLDs
    path: '/',
    partitioned: true // Only partitioned in true production
  },
  rolling: true // Reset the expiration on every request
});

// Middleware to add Partitioned attribute to cookies (Chrome requirement for cross-site cookies)
app.use((req, res, next) => {
  sessionMiddleware(req, res, (err) => {
    if (err) return next(err);
console.log("new sorry new")
    // Add Partitioned attribute to Set-Cookie header in true production for Chrome only
    if (isProduction && !isLocalIP) {
      const userAgent = req.headers['user-agent'] || '';
      const isChrome = /Chrome\//.test(userAgent) && !/Edg\//.test(userAgent); // Chrome but not Edge

      if (isChrome) {
        const originalSetHeader = res.setHeader.bind(res);
        res.setHeader = function(name, value) {
          if (name.toLowerCase() === 'set-cookie' && Array.isArray(value)) {
            value = value.map(cookie => {
              if (cookie.includes('connect.sid') && !cookie.includes('Partitioned')) {
                return cookie + '; Partitioned';
              }
              return cookie;
            });
          } else if (name.toLowerCase() === 'set-cookie' && typeof value === 'string') {
            if (value.includes('connect.sid') && !value.includes('Partitioned')) {
              value = value + '; Partitioned';
            }
          }
          return originalSetHeader(name, value);
        };
      }
    }

    next();
  });
});

// Logging middleware (after session is set up)
app.use((req, res, next) => {
  console.log('📍', req.method, req.originalUrl);
  console.log('🍪 Cookies:', req.headers.cookie);
  console.log('🔑 Session ID:', req.sessionID);
  console.log('👤 User ID:', req.session?.userId);
  next();
});


// --- REGISTER ROUTES ---
app.use('/api/users', userRoutes);
app.use('/api', groupRoutes);
// Mount matchRoutes before tournamentRoutes to handle nested routes
app.use('/api', matchRoutes);
app.use('/api/tournaments', tournamentRoutes);
app.use('/api', roundRoutes);
app.use('/api', teamRoutes);
app.use('/api', matchDataRoutes);
app.use('/api/matchSelection', matchSelectionRoutes);
app.use('/api', overallRoutes);
app.use('/api/public', bulkRoutes);

// --- PUBLIC ROUTES (No Authentication Required) ---
const Tournament = require('./models/tournament.model');
const Match = require('./models/match.model');

// Public tournament data
app.get('/api/public/tournaments/:tournamentId', cacheMiddleware(), async (req, res) => {
  try {
    const tournament = await Tournament.findById(req.params.tournamentId);
    if (!tournament) {
      return res.status(404).json({ error: 'Tournament not found' });
    }
    res.json(tournament);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Public round data
app.get('/api/public/tournaments/:tournamentId/rounds/:roundId', cacheMiddleware(), async (req, res) => {
  try {
    const Round = require('./models/round.model');
    const round = await Round.findById(req.params.roundId);
    if (!round) {
      return res.status(404).json({ error: 'Round not found' });
    }
    res.json(round);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Public match data
app.get('/api/public/matches/:matchId', cacheMiddleware(), async (req, res) => {
  try {
    const match = await Match.findById(req.params.matchId);
    if (!match) {
      return res.status(404).json({ error: 'Match not found' });
    }
    res.json(match);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Public matchData
app.get('/api/public/matches/:matchId/matchdata', async (req, res) => {
  try {
    const MatchData = require('./models/matchData.model');
    const Match = require('./models/match.model');
    const match = await Match.findById(req.params.matchId);
    if (!match) return res.status(404).json({ error: 'Match not found' });

    // Find matchData for the match's userId, or any if no userId
    let matchData = await MatchData.findOne({ matchId: req.params.matchId, userId: match.userId });
    if (!matchData) {
      // Fallback to any matchData for this matchId
      matchData = await MatchData.findOne({ matchId: req.params.matchId });
    }
    if (!matchData) {
      // Try to create it if missing
      const { createMatchDataForMatchDoc } = require('./controller/matchData.controller');
      try {
        matchData = await createMatchDataForMatchDoc(req.params.matchId);
      } catch (createErr) {
        return res.status(404).json({ error: 'MatchData not found and could not create' });
      }
    }
    res.json(matchData);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Public: list matches in a round
app.get('/api/public/rounds/:roundId/matches', cacheMiddleware(), async (req, res) => {
  try {
    const Match = require('./models/match.model');
    const matches = await Match.find({ roundId: req.params.roundId });
    res.json(matches);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Public: get currently selected match for a tournament + round (fallback to latest by matchNo)
app.get('/api/public/tournaments/:tournamentId/rounds/:roundId/selected-match', async (req, res) => {
  try {
    const { tournamentId, roundId } = req.params;
    const mongoose = require('mongoose');
    if (!mongoose.Types.ObjectId.isValid(tournamentId) || !mongoose.Types.ObjectId.isValid(roundId)) {
      return res.status(400).json({ error: 'Invalid tournamentId or roundId' });
    }
    const MatchSelection = require('./models/MatchSelection.model');
    const Match = require('./models/match.model');

    const selected = await MatchSelection.findOne({ tournamentId, roundId, isSelected: true })
      .sort({ createdAt: -1 })
      .lean();

    if (selected?.matchId) {
      return res.json({ matchId: selected.matchId.toString() });
    }

    // Fallback: latest match by matchNo
    const latest = await Match.findOne({ tournamentId, roundId }).sort({ matchNo: -1 }).lean();
    if (latest?._id) {
      return res.json({ matchId: latest._id.toString() });
    }

    return res.status(404).json({ error: 'No selected match or matches found' });
  } catch (err) {
    console.error('Public selected-match error:', err);
    return res.status(500).json({ error: err.message });
  }
});

// Public backpack data
app.get('/api/public/bagPack/tournament/:tournamentId/round/:roundId/match/:matchId/matchdata/:matchDataId', cacheMiddleware(), async (req, res) => {
  try {
    const { matchDataId } = req.params;
    const MatchData = require('./models/matchData.model');
    const Match = require('./models/match.model');
    const { getBackpackModel } = require('./models/bgpackModel');

    const matchDataDoc = await MatchData.findById(matchDataId);
    if (!matchDataDoc) {
      return res.status(404).json({ error: 'MatchData not found' });
    }

    const match = await Match.findById(matchDataDoc.matchId);
    if (!match) {
      return res.status(404).json({ error: 'Match not found' });
    }

    const Backpack = getBackpackModel(matchDataId);
    const data = await Backpack.find({ userId: matchDataDoc.userId });

    // Remove userId from each item in data
    const cleanedData = data.map(item => {
      const itemObj = item.toObject();
      delete itemObj.userId;
      return itemObj;
    });

    res.json({
      userId: matchDataDoc.userId,
      tournamentId: match.tournamentId,
      roundId: match.roundId,
      matchId: match._id,
      matchDataId,
      teambackpackinfo: {
        TeamBackPackList: cleanedData
      }
    });
  } catch (error) {
    console.error('Error getting public backpack data:', error);
    res.status(500).json({ error: 'Failed to get public backpack data' });
  }
});

// Public groups in a tournament
app.get('/api/public/tournaments/:tournamentId/groups', cacheMiddleware(), async (req, res) => {
  try {
    const mongoose = require('mongoose');
    const Group = require('./models/group.model.js');

    const { tournamentId } = req.params;
    if (!mongoose.Types.ObjectId.isValid(tournamentId)) {
      return res.status(400).json({ error: 'Invalid tournamentId' });
    }

    const groups = await Group.find({ tournamentId }).populate('slots.team');
    res.json(groups);
  } catch (err) {
    console.error('Public groups error:', err);
    res.status(500).json({ error: err.message });
  }
});

// Public overall aggregated data for a round in a tournament
app.get('/api/public/tournaments/:tournamentId/rounds/:roundId/overall', cacheMiddleware(3, req => `round:${req.params.tournamentId}:${req.params.roundId}`), async (req, res) => {
  try {
    const mongoose = require('mongoose');
    const Match = require('./models/match.model');
    const MatchData = require('./models/matchData.model');
    const Round = require('./models/round.model');
    const { createMatchDataForMatchDoc } = require('./controller/matchData.controller');

    const { tournamentId, roundId } = req.params;
    if (!mongoose.Types.ObjectId.isValid(tournamentId) || !mongoose.Types.ObjectId.isValid(roundId)) {
      return res.status(400).json({ error: 'Invalid tournamentId or roundId' });
    }

    const round = await Round.findOne({ _id: roundId, tournamentId });
    if (!round) return res.status(404).json({ error: 'Round not found' });

    const matches = await Match.find({ tournamentId, roundId }).sort({ matchNo: 1 }).lean();
    if (!matches || matches.length === 0) {
      return res.json({ tournamentId, roundId, teams: [], createdAt: new Date() });
    }

    // Use all matches in the round for overall data
    const filteredMatches = matches;

    // helpers
    const NUMERIC_PLAYER_FIELDS = [
      'health','healthMax','liveState','killNum','killNumBeforeDie','gotAirDropNum','maxKillDistance','damage',
      'killNumInVehicle','killNumByGrenade','AIKillNum','BossKillNum','rank','inDamage','headShotNum','survivalTime',
      'driveDistance','marchDistance','assists','outsideBlueCircleTime','knockouts','rescueTimes','useSmokeGrenadeNum',
      'useFragGrenadeNum','useBurnGrenadeNum','useFlashGrenadeNum','PoisonTotalDamage','UseSelfRescueTime',
      'UseEmergencyCallTime','contribution'
    ];
    function sumNumericFields(target, source, fields) {
      for (const f of fields) {
        const a = Number(target[f] || 0);
        const b = Number(source[f] || 0);
        target[f] = a + b;
      }
    }
    function buildInitialAggPlayer(p) {
      return {
        uId: p.uId || '',
        _id: p._id,
        playerName: p.playerName || '',
        playerOpenId: p.playerOpenId || '',
        picUrl: p.picUrl || '',
        showPicUrl: p.showPicUrl || '',
        character: p.character || '',
        isFiring: false,
        bHasDied: false,
        location: { x: 0, y: 0, z: 0 },
        health: 0,
        healthMax: 0,
        liveState: 0,
        killNum: 0,
        killNumBeforeDie: 0,
        playerKey: p.playerKey || '',
        gotAirDropNum: 0,
        maxKillDistance: 0,
        damage: 0,
        killNumInVehicle: 0,
        killNumByGrenade: 0,
        AIKillNum: 0,
        BossKillNum: 0,
        rank: 0,
        isOutsideBlueCircle: false,
        inDamage: 0,
        headShotNum: 0,
        survivalTime: 0,
        driveDistance: 0,
        marchDistance: 0,
        assists: 0,
        outsideBlueCircleTime: 0,
        knockouts: 0,
        rescueTimes: 0,
        useSmokeGrenadeNum: 0,
        useFragGrenadeNum: 0,
        useBurnGrenadeNum: 0,
        useFlashGrenadeNum: 0,
        PoisonTotalDamage: 0,
        UseSelfRescueTime: 0,
        UseEmergencyCallTime: 0,
        teamIdfromApi: p.teamIdfromApi || '',
        contribution: 0
      };
    }

    // load matchDatas using pattern similar to public matchdata route
    const teamsMap = new Map();

    for (const m of filteredMatches) {
      let matchData = await MatchData.findOne({ matchId: m._id, userId: m.userId }).lean();
      if (!matchData) {
        matchData = await MatchData.findOne({ matchId: m._id }).lean();
      }
      if (!matchData) {
        try {
          const created = await createMatchDataForMatchDoc(m._id);
          matchData = created && created.toObject ? created.toObject() : created;
        } catch (e) {
          // skip if cannot create
          continue;
        }
      }
      if (!matchData) continue;

      const seenTeamIds = new Set();
      for (const team of matchData.teams || []) {
        const teamKey = team.teamId.toString();
        // Defensive: two teams[] subdocuments sharing a teamId within the
        // SAME MatchData would otherwise double-count placePoints/wwcd.
        if (seenTeamIds.has(teamKey)) {
          console.warn(`[overall route] duplicate teamId ${teamKey} in matchData ${matchData._id} — skipping to avoid double-counting`);
          continue;
        }
        seenTeamIds.add(teamKey);

        if (!teamsMap.has(teamKey)) {
          teamsMap.set(teamKey, {
            teamId: team.teamId,
            teamName: team.teamName || '',
            teamTag: team.teamTag || '',
            teamLogo: team.teamLogo || '',
            slot: Number.isFinite(team.slot) ? team.slot : 0,
            placePoints: 0,
            wwcd: 0,
            players: new Map()
          });
        }
        const aggTeam = teamsMap.get(teamKey);
        if (!aggTeam.teamName && team.teamName) aggTeam.teamName = team.teamName;
        if (!aggTeam.teamTag && team.teamTag) aggTeam.teamTag = team.teamTag;
        if (!aggTeam.teamLogo && team.teamLogo) aggTeam.teamLogo = team.teamLogo;
        if (Number.isFinite(team.slot)) {
          aggTeam.slot = Math.min(aggTeam.slot || team.slot, team.slot);
        }
        aggTeam.placePoints += Number(team.placePoints || 0);
        // Prefer the real computed rank; only fall back to the placePoints
        // heuristic for older docs written before `rank` was persisted.
        const isWinner = team.rank === 1 || (!team.rank && Number(team.placePoints || 0) === 10);
        if (isWinner) aggTeam.wwcd += 1;

        for (const p of team.players || []) {
          const pKey = p._id.toString();
          if (!aggTeam.players.has(pKey)) {
            aggTeam.players.set(pKey, buildInitialAggPlayer(p));
          }
          const aggPlayer = aggTeam.players.get(pKey);

          if (p.playerName) aggPlayer.playerName = p.playerName;
          if (p.picUrl) aggPlayer.picUrl = p.picUrl;
          if (p.showPicUrl) aggPlayer.showPicUrl = p.showPicUrl;
          if (p.character) aggPlayer.character = p.character;
          if (p.playerOpenId) aggPlayer.playerOpenId = p.playerOpenId;
          if (p.uId) aggPlayer.uId = p.uId;
          if (p.teamIdfromApi) aggPlayer.teamIdfromApi = p.teamIdfromApi;

          sumNumericFields(aggPlayer, p, NUMERIC_PLAYER_FIELDS);
        }
      }
    }

    const aggregatedTeams = Array.from(teamsMap.values()).map(t => ({
      teamId: t.teamId,
      teamName: t.teamName,
      teamTag: t.teamTag,
      teamLogo: t.teamLogo,
      slot: t.slot || 0,
      placePoints: t.placePoints,
      wwcd: t.wwcd,
      players: Array.from(t.players.values())
    })).sort((a, b) => (a.slot || 0) - (b.slot || 0));

    return res.json({ tournamentId, roundId, teams: aggregatedTeams, createdAt: new Date() });
  } catch (err) {
    console.error('Public overall error:', err);
    return res.status(500).json({ error: err.message });
  }
});

// API health check route
app.get('/api/health', (req, res) => {
  res.json({ 
    message: 'API is running', 
    version: '1.0.0', 
    status: 'ok',
    dbConnected: mongoose.connection.readyState === 1,
    redisConnected: false // Add redis check if needed
  });
});

app.get('/api', (req, res) => {
  res.redirect('/api/health');
});

app.get('/', (req, res) => {
  res.send('Hello World from Express!');
});

async function startServer() {
  try {

    if (!config.MONGODB_URI) {
      console.log("❌ MongoDB URI missing");
      process.exit(1);
    }

    await mongoose.connect(config.MONGODB_URI || "mongodb+srv://demon:P6whwJ8qsMfIZg2F@cluster0.ix4q7ng.mongodb.net/?appName=Cluster0", {
      serverSelectionTimeoutMS: 10000,
      connectTimeoutMS: 10000,
      socketTimeoutMS: 45000,
      family: 4
    });

    console.log("✅ MongoDB connected");

    const server = http.createServer(app);
    const io = initializeSocket(server);

    // Share the same session store with Socket.IO so a socket's underlying
    // handshake request carries `req.session` — lets a cookie-bearing
    // client (the dashboard) auto-join its own `user:<id>` room without
    // needing the desktop relay's separate token-based handshake (the
    // relay has no cookie to share; the dashboard does).
    io.engine.use(sessionMiddleware);

    console.log('🚀 Starting live match updater now that DB is ready');

    const { startLiveMatchUpdater } = require('./controller/Api_controllers/pubgApiMatchData.controller.js');
    startLiveMatchUpdater();

    server.listen(port, '0.0.0.0', () => {
      console.log(`🚀 Server running on ${port}`);
    });

  } catch (err) {
    console.log("❌ MongoDB connection error", err);
    process.exit(1);
  }
}

startServer();

