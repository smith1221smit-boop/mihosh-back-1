# Fix Render Mongoose Timeout Issue

## Step 1-4: Code changes complete ✅
## Step 5: Local test - server starts successfully ✅  
## Step 6: Build ✅
## Step 7: Deploy to Render

**Fixed:**
- Added `bufferTimeoutMS: 30000` to mongoose.connect()
- Deferred `startLiveMatchUpdater()` until `mongoose.connection 'open'`
- Added `/api/health` endpoint with DB connection status
- Added connection guards (`readyState !== 1`) to Round.find() in discovery/polling
- Prioritized `process.env.MONGODB_URI` for Render deployment
- `server.listen(port, '0.0.0.0')` for proper port binding

**Next:** Set MONGODB_URI in Render dashboard, redeploy, check logs for no timeouts.

Run these commands:
```
cd Render_hosted/test-back && node build.js
# Then deploy built files to Render
```

Health check available: http://localhost:3000/api/health
