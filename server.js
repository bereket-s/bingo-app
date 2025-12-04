require('dotenv').config();
const express = require('express');
const http = require('http');
const https = require('https'); 
const { Server } = require('socket.io');
const path = require('path'); 
const bodyParser = require('body-parser'); // Needed for SMS

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
// Configure "SMS Forwarder" app to POST to: https://YOUR-APP.onrender.com/api/sms-webhook
app.post('/api/sms-webhook', async (req, res) => {
    const { from, message } = req.body;

    console.log(`📩 SMS from ${from}: ${message}`);

    let txnId = null;
    let amount = 0;

    // 1. Find Transaction ID (Telebirr/CBE format)
    // Looks for "Trans ID: 123ABC45" or "Ref: 123ABC45"
    const txnMatch = message.match(/(Trans ID|Txn ID|Ref|TI|TID)[:\s]*([A-Z0-9]{6,15})/i);
    if (txnMatch) txnId = txnMatch[2];

    // 2. Find Amount
    // Looks for "100 ETB" or "50.00 Birr"
    const amountMatch = message.match(/([0-9,]+(\.[0-9]{1,2})?)\s*(ETB|Birr)/i);
    if (amountMatch) {
        amount = parseFloat(amountMatch[1].replace(/,/g, ''));
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
        console.log("⚠️ SMS Ignored (No Txn ID or Amount)");
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

  // Keep-Alive for Render
  const publicUrl = process.env.PUBLIC_URL;
  if (publicUrl && publicUrl.startsWith('http')) {
      setInterval(() => {
          https.get(publicUrl, (res) => {}).on('error', (e) => {});
      }, 10 * 60 * 1000); 
  }
});