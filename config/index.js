const path = require('path');
const fs = require('fs');
const dotenv = require('dotenv');

let envVars = {};

// Prioritize process.env (Render env vars) first, then embedded, then .env
envVars = { ...process.env };

// Try embedded config second (build-time)
try {
  const embeddedConfig = require('./env.config');
  envVars = { ...envVars, ...embeddedConfig };
} catch (e) {
  console.log('No embedded config found (normal for dev)');
}

// Fall back to .env for local dev
const envPath = path.join(__dirname, '..', '.env');
if (fs.existsSync(envPath)) {
  dotenv.config({ path: envPath });
  envVars = { ...envVars, ...process.env };
}

// Default configuration
const config = {
  // Server
  PORT: envVars.PORT || 3000,
  NODE_ENV: envVars.NODE_ENV || 'production',
  
  // Security
  ADMIN_CODE: envVars.ADMIN_CODE,
  JWT_SECRET: envVars.JWT_SECRET || 'your-secret-key',
  SESSION_SECRET: envVars.SESSION_SECRET || 'supersecretkey123',
  
// Database
  MONGODB_URI: envVars.MONGODB_URI || 'mongodb+srv://DEMON:1RpRCPfA2TIjcXXL@cluster0.znuinux.mongodb.net/?retryWrites=true&w=majority&appName=Cluster0',
  UPSTASH_REDIS_REST_URL: envVars.UPSTASH_REDIS_REST_URL || 'https://enabled-mako-38693.upstash.io',
  UPSTASH_REDIS_REST_TOKEN: envVars.UPSTASH_REDIS_REST_TOKEN || 'AZclAAIncDIwYzAxYTkyMmRlNDU0YjU5OWZjNGU5ZWQ2MDMzZTVkYnAyMzg2OTM',
  
  // Logging
  LOG_LEVEL: envVars.LOG_LEVEL || 'info',
  LOG_TO_FILE: envVars.LOG_TO_FILE === 'true' || false,
};

// Validate required configuration
const requiredConfigs = ['ADMIN_CODE', 'MONGODB_URI', 'UPSTASH_REDIS_REST_URL', 'UPSTASH_REDIS_REST_TOKEN'];
for (const key of requiredConfigs) {
  if (!config[key] && process.env.NODE_ENV !== 'test') {
    console.error(`❌ Missing required config: ${key}`);
    process.exit(1);
  }
}

module.exports = config;