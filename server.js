require('dotenv').config();
const express = require('express');
const http = require('http');
const https = require('https'); 
const { Server } = require('socket.io');
const path = require('path'); 
const bodyParser = require('body-parser'); 

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

app.use(bodyParser.json());
app.use(express.static(buildPath));

// --- SMS AUTOMATION WEBHOOK ---
app.post('/api/sms-webhook', async (req, res) => {
    // 1. Sanitize Input
    const from = req.body.from || "Unknown";
    const message = req.body.message || "";

    console.log(`📩 SMS from ${from}: ${message}`);

    let txnId = null;
    let amount = 0;

    // --- LOGIC A: Bank/Telebirr Format ---
    // Matches: "Trans ID: 8H7G6F", "Txn: 12345", "Ref: ABC"
    const txnMatch = message.match(/(Trans ID|Txn ID|Ref|TI|TID)[:\s]*([A-Z0-9]{6,15})/i);
    if (txnMatch) txnId = txnMatch[2];

    // Matches: "100 ETB", "50.00 Birr"
    const amountMatch = message.match(/([0-9,]+(\.[0-9]{1,2})?)\s*(ETB|Birr)/i);
    if (amountMatch) {
        amount = parseFloat(amountMatch[1].replace(/,/g, ''));
    }

    // --- LOGIC B: Admin Testing Format ---
    // Allow you to send "TEST 100" from your phone to test the connection
    if (!txnId && message.toUpperCase().startsWith("TEST")) {
        const testParts = message.split(" ");
        if (testParts.length >= 2) {
            txnId = "TEST-" + Date.now().toString().slice(-6); // Generate random fake ID
            amount = parseFloat(testParts[1]);
            console.log("🛠️ Debug SMS detected. Generated ID:", txnId);
        }
    }

    if (txnId && amount > 0) {
        try {
            await db.query(
                `INSERT INTO bank_transactions (txn_code, amount, sender_name, raw_sms, status) 
                 VALUES ($1, $2, $3, $4, 'unclaimed')
                 ON CONFLICT (txn_code) DO NOTHING`,
                [txnId, amount, from, message]
            );
            console.log(`✅ Auto-Bank: Saved ${txnId} (${amount} ETB)`);
            res.status(200).send('Saved');
        } catch (e) {
            console.error("DB Save Error:", e);
            res.status(500).send('Error');
        }
    } else {
        console.log("⚠️ SMS Ignored (Format mismatch or App config error)");
        console.log("👉 Tip: Message must contain 'Trans ID: XXX' and '100 ETB', OR start with 'TEST 100'");
        res.status(200).send('Ignored');
    }
});

app.get('*', (req, res) => {
  if (require('fs').existsSync(path.join(buildPath, 'index.html'))) {
    res.sendFile(path.join(buildPath, 'index.html'));
  } else {
    res.send('<h1>Bingo Server is Running</h1>');
  }
});

initializeSocketListeners(io);
startBot(db, io, startGameLogic);

server.listen(PORT, () => {
  console.log(`✅ Server listening on http://localhost:${PORT}`);

  // --- AGGRESSIVE KEEP-ALIVE ---
  const publicUrl = process.env.PUBLIC_URL;
  if (publicUrl && publicUrl.startsWith('http')) {
      console.log(`⏰ Keep-Alive: Monitoring ${publicUrl}`);
      const pingServer = () => {
          https.get(publicUrl, (res) => {
              console.log(`⏰ Keep-Alive Ping: Status ${res.statusCode}`);
          }).on('error', (e) => {
              console.error(`❌ Keep-Alive Error: ${e.message}`);
          });
      };
      pingServer();
      setInterval(pingServer, 5 * 60 * 1000); 
  }
});