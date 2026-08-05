// socket.js

let ioInstance = null;

function initializeSocket(server) {
  if (ioInstance) {
    console.warn('Socket.IO is already initialized.');
    return ioInstance;
  }
  const { Server } = require('socket.io');
  ioInstance = new Server(server, {
    cors: {
      origin: function (origin, callback) {
        // Allow requests with no origin (like mobile apps or Postman)
        if (!origin) return callback(null, true);
        
        const allowedOrigins = [
          'http://localhost:3001',
            "https://ramus-front12.vercel.app",
      "tauri://com.admin.tauri-app",
          'http://localhost:1420',
          "tauri://localhost",
              "http://tauri.localhost",
          'https://scoresync-v1.vercel.app',
          'http://192.168.18.6:3001'
        ];
        
        // Check if origin is allowed OR if it's a Vercel preview deployment
        if (allowedOrigins.includes(origin) || origin.includes('.vercel.app')) {
          callback(null, true);
        } else {
          console.warn('⚠️ Socket.IO CORS blocked origin:', origin);
          callback(new Error('Not allowed by CORS'));
        }
      },
      credentials: true,
      methods: ['GET', 'POST'],
      allowedHeaders: ["Content-Type", "Authorization", "x-cookie"],
    },
    allowEIO3: true, // Allow Engine.IO v3 clients
    // The live payloads on this socket are already MessagePack binary —
    // compact, high-entropy bytes that gain little from gzip/deflate but
    // still pay its CPU cost on every emit. Default perMessageDeflate was
    // fighting the point of using a binary wire format; disable it.
    perMessageDeflate: false,
  });
  console.log('✅ Socket.IO initialized with CORS');

  return ioInstance;
}

function getSocket() {
  if (!ioInstance) {
    throw new Error('Socket.IO not initialized. Call initializeSocket first.');
  }
  return ioInstance;
}

module.exports = { initializeSocket, getSocket };