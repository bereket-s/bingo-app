require('dotenv').config();
const express = require('express');
const http = require('http');
const https = require('https');
const { Server } = require('socket.io');
const path = require('path');
const bodyParser = require('body-parser');

const db = require('./db');
const { startBot } = require('./bot');
const { initializeSocketListeners, startGameLogic, createAutoGame, cleanupStaleGames } = require('./gameManager');

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

// ... SMS WEBHOOK ...

// KICK OFF GAME LOOP
initializeSocketListeners(io);

// Clean up stale games first, THEN start the auto-loop
cleanupStaleGames(io).then(() => {
    createAutoGame(io);
});
app.post('/api/sms-webhook', async (req, res) => {
    // 1. Sanitize Input
    const from = req.body.from || "Unknown";
    const message = req.body.message || "";

    console.log(`📩 SMS from ${from}: ${message}`);

    let txnId = null;
    let amount = 0;

    // --- PARSING LOGIC FOR SPECIFIC BANKS ---

    // 1. Telebirr
    // Format: "You have received ETB 10.00 from Yared Shewareg... Your transaction number is CL53O7W8MZ."
    if (message.includes('telebirr') || from.toLowerCase().includes('telebirr') || message.includes('Ethio telecom')) {
        const telebirrTxn = message.match(/transaction number is\s*([A-Z0-9]+)/i);
        const telebirrAmount = message.match(/received\s*(ETB|Birr)\s*([0-9,]+(\.[0-9]{2})?)/i);

        if (telebirrTxn) txnId = telebirrTxn[1];
        if (telebirrAmount) amount = parseFloat(telebirrAmount[2].replace(/,/g, ''));
    }

    // 2. CBE (Commercial Bank of Ethiopia)
    // Format: "Dear Bereket your Account ... Credited with ETB 70,400.00 ... Ref No FT25338SCNRF"
    if (!txnId && (message.includes('CBE') || from.toLowerCase().includes('cbe') || message.includes('Commercial Bank'))) {
        const cbeTxn = message.match(/Ref No\s*([A-Z0-9]+)/i);
        const cbeAmount = message.match(/Credited with\s*(ETB|Birr)\s*([0-9,]+(\.[0-9]{2})?)/i);

        if (cbeTxn) txnId = cbeTxn[1];
        if (cbeAmount) amount = parseFloat(cbeAmount[2].replace(/,/g, ''));
    }

    // 3. Fallback / Test Logic (Keep for admin testing)
    if (!txnId && message.toUpperCase().startsWith("TEST")) {
        const testParts = message.split(" ");
        if (testParts.length >= 2) {
            txnId = "TEST-" + Date.now().toString().slice(-6);
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
        console.log("⚠️ SMS Ignored (Format mismatch)");
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
createAutoGame(io); // KICK OFF AUTO LOOP

if (process.env.DISABLE_BOT === 'true') {
    console.log("⚠️ Bot startup SKIPPED (DISABLE_BOT=true in .env)");
} else {
    startBot(db, io, startGameLogic);
}

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