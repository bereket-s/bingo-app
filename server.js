require('dotenv').config();
const express = require('express');
const http = require('http');
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
});