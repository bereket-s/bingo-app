require('dotenv').config();
const express = require('express');
const http = require('http');
const https = require('https'); // Required for self-ping
const { Server } = require('socket.io');
const path = require('path'); 

const db = require('./db'); 
const { startBot } = require('./bot'); 
const { initializeSocketListeners, startGameLogic } = require('./gameManager'); 

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: {
    origin: "*", 
    methods: ["GET", "POST"]
  }
});

const PORT = process.env.PORT || 3001;
const buildPath = path.join(__dirname, 'build');
app.use(express.static(buildPath));

app.get('*', (req, res) => {
  if (require('fs').existsSync(path.join(buildPath, 'index.html'))) {
    res.sendFile(path.join(buildPath, 'index.html'));
  } else {
    res.send('<h1>Bingo Server is Running - Frontend Not Built Yet (Run: npm run build)</h1>');
  }
});

initializeSocketListeners(io);
startBot(db, io, startGameLogic);

server.listen(PORT, () => {
  console.log(`✅ Server listening on http://localhost:${PORT}`);

  // --- KEEP-ALIVE SYSTEM ---
  // This prevents Render from sleeping by pinging itself every 10 minutes
  const publicUrl = process.env.PUBLIC_URL;
  if (publicUrl && publicUrl.startsWith('http')) {
      console.log(`⏰ Keep-Alive System Activated for: ${publicUrl}`);
      setInterval(() => {
          https.get(publicUrl, (res) => {
              console.log(`⏰ Keep-Alive Ping Sent. Status: ${res.statusCode}`);
          }).on('error', (e) => {
              console.error(`❌ Keep-Alive Failed: ${e.message}`);
          });
      }, 10 * 60 * 1000); // Ping every 10 minutes
  }
});