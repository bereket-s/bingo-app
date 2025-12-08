const db = require('./db');

let gameEndCallback = null;

function setGameEndCallback(callback) {
    gameEndCallback = callback;
}

function mulberry32(a) {
    return function() {
      var t = a += 0x6D2B79F5;
      t = Math.imul(t ^ t >>> 15, t | 1);
      t ^= t + Math.imul(t ^ t >>> 7, t | 61);
      return ((t ^ t >>> 14) >>> 0) / 4294967296;
    }
}

function generateBingoCard(seed = null) {
  const card = [[], [], [], [], []]; 
  const ranges = [
    { col: 0, min: 1, max: 15 }, 
    { col: 1, min: 16, max: 30 }, 
    { col: 2, min: 31, max: 45 },
    { col: 3, min: 46, max: 60 }, 
    { col: 4, min: 61, max: 75 },
  ];
  const random = seed ? mulberry32(parseInt(seed)) : Math.random;

  for (const r of ranges) {
    const numbers = new Set();
    while (numbers.size < 5) {
      if (r.col === 2 && numbers.size === 2) { 
          card[2].push('FREE'); 
          numbers.add('FREE'); 
      } else {
        const num = Math.floor(random() * (r.max - r.min + 1)) + r.min;
        if (!numbers.has(num)) { 
            numbers.add(num); 
            card[r.col].push(num); 
        }
      }
    }
  }
  return card[0].map((_, i) => card.map(row => row[i]));
}

const activeGames = new Map();
const pendingCardStates = new Map(); 
const MAX_CARDS_PER_PLAYER = 5;
const CALL_DELAY_MS = 6000; 

async function cleanupStaleGames() {
    try {
        const stuckGames = await db.query("SELECT id, bet_amount, status FROM games WHERE status IN ('active', 'pending')");
        for (const game of stuckGames.rows) {
            const players = await db.query("SELECT user_id FROM player_cards WHERE game_id = $1", [game.id]);
            for (let p of players.rows) {
                await db.query("UPDATE users SET points = points + $1 WHERE id = $2", [game.bet_amount, p.user_id]);
                try { 
                    if (db.logTransaction) await db.logTransaction(p.user_id, 'system_refund', game.bet_amount, null, game.id, `Server Restart Refund Game #${game.id}`);
                } catch(e) {}
            }
            await db.query("UPDATE games SET status = 'aborted' WHERE id = $1", [game.id]);
        }
        console.log("✅ Stale games cleaned.");
    } catch (e) { console.error("Cleanup Error:", e); }
}
cleanupStaleGames();

function validateBingo(cardData, markedCells, calledNumbersSet, pattern, lastCalledNumber) {
    for (const numStr of markedCells) {
        if (numStr !== 'FREE' && !calledNumbersSet.has(numStr)) return { valid: false, message: `Invalid! ${numStr} not called.` };
    }
    const lastCalledStr = String(lastCalledNumber);
    if (lastCalledNumber && !markedCells.has(lastCalledStr)) return { valid: false, message: "Must bingo on the LAST called number!" };

    const isMarked = (r, c) => { const val = cardData[r][c]; return String(val) === 'FREE' || markedCells.has(String(val)); };
    
    const rows = [0,1,2,3,4].map(r => [0,1,2,3,4].map(c => [r,c]));
    const cols = [0,1,2,3,4].map(c => [0,1,2,3,4].map(r => [r,c]));
    const diag1 = [0,1,2,3,4].map(i => [i,i]);
    const diag2 = [0,1,2,3,4].map(i => [i, 4-i]);
    
    const checkSet = (coords) => {
        const allMarked = coords.every(([r,c]) => isMarked(r,c));
        if (!allMarked) return false;
        if (lastCalledNumber) return coords.some(([r,c]) => String(cardData[r][c]) === lastCalledStr);
        return true; 
    };

    switch (pattern) {
        case 'any_line': for(const line of [...rows, ...cols, diag1, diag2]) if(checkSet(line)) return { valid: true }; break;
        case 'two_lines': 
             let validLines = 0; let lastNumUsed = false;
             for(const line of [...rows, ...cols, diag1, diag2]) {
                 if (line.every(([r,c]) => isMarked(r,c))) {
                     validLines++;
                     if (line.some(([r,c]) => String(cardData[r][c]) === lastCalledStr)) lastNumUsed = true;
                 }
            }
            if (validLines >= 2 && (lastNumUsed || !lastCalledNumber)) return { valid: true };
            break;
        case 'x_shape': 
             const xCoords = [...diag1, ...diag2];
             if (diag1.every(([r,c]) => isMarked(r,c)) && diag2.every(([r,c]) => isMarked(r,c))) {
                  if(!lastCalledNumber) return { valid: true };
                  if (xCoords.some(([r,c]) => String(cardData[r][c]) === lastCalledStr)) return { valid: true };
             }
             break;
        case 'l_shape': 
             const lCoords = [...cols[0], ...rows[4]]; 
             if (lCoords.every(([r,c]) => isMarked(r,c))) {
                 if(!lastCalledNumber) return { valid: true };
                 if(lCoords.some(([r,c]) => String(cardData[r][c]) === lastCalledStr)) return { valid: true };
             }
             break;
        case 'corners': 
             const corners = [[0,0], [0,4], [4,0], [4,4]];
             if (checkSet(corners)) return { valid: true };
             break;
        case 'plus_sign': 
             const plusCoords = [...cols[2], ...rows[2]];
             if (plusCoords.every(([r,c]) => isMarked(r,c))) {
                 if(!lastCalledNumber) return { valid: true };
                 if(plusCoords.some(([r,c]) => String(cardData[r][c]) === lastCalledStr)) return { valid: true };
             }
             break;
        case 'u_shape': 
             const uCoords = [...cols[0], ...cols[4], ...rows[4]];
             if (uCoords.every(([r,c]) => isMarked(r,c))) {
                 if(!lastCalledNumber) return { valid: true };
                 if(uCoords.some(([r,c]) => String(cardData[r][c]) === lastCalledStr)) return { valid: true };
             }
             break;
        case 'letter_h': 
             const hCoords = [...cols[0], ...cols[4], [2,1], [2,2], [2,3]];
             if (hCoords.every(([r,c]) => isMarked(r,c))) {
                 if(!lastCalledNumber) return { valid: true };
                 if(hCoords.some(([r,c]) => String(cardData[r][c]) === lastCalledStr)) return { valid: true };
             }
             break;
        case 'letter_t': 
             const tCoords = [...rows[0], ...cols[2]];
             if (tCoords.every(([r,c]) => isMarked(r,c))) {
                 if(!lastCalledNumber) return { valid: true };
                 if(tCoords.some(([r,c]) => String(cardData[r][c]) === lastCalledStr)) return { valid: true };
             }
             break;
        case 'frame': 
             const frameCoords = [...rows[0], ...rows[4], ...cols[0], ...cols[4]];
             if (frameCoords.every(([r,c]) => isMarked(r,c))) {
                 if(!lastCalledNumber) return { valid: true };
                 if(frameCoords.some(([r,c]) => String(cardData[r][c]) === lastCalledStr)) return { valid: true };
             }
             break;
        case 'full_house': 
             let all=true; for(let r=0;r<5;r++)for(let c=0;c<5;c++)if(!isMarked(r,c))all=false; 
             if(all) return {valid:true}; 
             break;
        default: for(const line of [...rows, ...cols, diag1, diag2]) if(checkSet(line)) return { valid: true };
    }
    return { valid: false, message: "Invalid!" };
}

async function startGameLogic(gameId, io, _ignoredPattern, delaySeconds = 0) {
    const gameInfo = await db.query("SELECT winning_pattern, daily_id FROM games WHERE id = $1", [gameId]);
    if (gameInfo.rows.length === 0) return;
    const pattern = gameInfo.rows[0].winning_pattern;
    const dailyId = gameInfo.rows[0].daily_id;
    
    if (delaySeconds > 0) {
        io.to(`game_${gameId}`).emit('gameCountdown', { seconds: delaySeconds });
        console.log(`⏱ Game ${gameId} starting in ${delaySeconds}s...`);
    }

    setTimeout(async () => {
        try {
            await db.query("UPDATE games SET status = 'active' WHERE id = $1", [gameId]);
            pendingCardStates.delete(gameId);
            
            const allCardsRes = await db.query(`
                SELECT pc.id, pc.user_id, pc.card_data, pc.original_card_id,
                    u.premium_expires_at, u.pref_auto_bingo 
                FROM player_cards pc 
                JOIN users u ON pc.user_id = u.id 
                WHERE pc.game_id = $1`, [gameId]);

            const gameCards = allCardsRes.rows.map(row => ({
                ...row,
                isPremium: row.premium_expires_at && new Date(row.premium_expires_at) > new Date()
            }));

            const game = { calledNumbers: new Set(), lastCalledNumber: null, io: io, intervalId: null, pattern, winners: new Set(), isEnding: false, cards: gameCards, dailyId, hasProcessedEnd: false };
            activeGames.set(gameId, game);
            
            io.to(`game_${gameId}`).emit('gameStateUpdate', { status: 'active', gameId, displayId: dailyId, pattern });
            console.log(`🚀 Game ${gameId} Started. Rule: ${pattern}`);

            game.intervalId = setInterval(async () => {
                const checkStatus = await db.query("SELECT status FROM games WHERE id = $1", [gameId]);
                if (!checkStatus.rows.length || checkStatus.rows[0].status !== 'active') {
                    clearInterval(game.intervalId);
                    activeGames.delete(gameId);
                    io.to(`game_${gameId}`).emit('gameStateUpdate', { status: 'idle' });
                    return;
                }

                if (game.isEnding) return;

                if (game.calledNumbers.size >= 75) {
                    clearInterval(game.intervalId);
                    await db.query("UPDATE games SET status = 'finished' WHERE id = $1", [gameId]);
                    game.io.to(`game_${gameId}`).emit('gameStateUpdate', { status: 'finished', winner: "No one / ማንም" });
                    if (gameEndCallback) gameEndCallback(gameId, "Draw (No Winner)", dailyId);
                    setTimeout(() => { game.io.to(`game_${gameId}`).emit('gameStateUpdate', { status: 'idle' }); }, 10000);
                    activeGames.delete(gameId);
                    return;
                }

                let newNumber;
                do { newNumber = String(Math.floor(Math.random() * 75) + 1); } while (game.calledNumbers.has(newNumber));
                game.calledNumbers.add(newNumber);
                game.lastCalledNumber = newNumber;
                
                game.io.to(`game_${gameId}`).emit('numberCalled', { number: newNumber, allCalled: [...game.calledNumbers] });

                // Auto Bingo Logic
                for (const card of game.cards) {
                    if (card.isPremium && card.pref_auto_bingo && !game.winners.has(card.user_id)) {
                        const potentialMarks = new Set([...game.calledNumbers]);
                        const { valid } = validateBingo(card.card_data, potentialMarks, game.calledNumbers, pattern, newNumber);
                        
                        if (valid) {
                            game.winners.add(card.user_id);
                            io.to(`game_${gameId}`).emit('bingoResult', { 
                                valid: true, 
                                message: `⚡ AUTO-BINGO! Checking winners...`,
                                winningCardId: card.original_card_id 
                            });
                            notifyUser(io, card.user_id, 0, "⚡ PREMIUM AUTO-BINGO!", true);
                            if (!game.isEnding) {
                                game.isEnding = true;
                                clearInterval(game.intervalId);
                                setTimeout(() => { processGameEnd(gameId, io, game); }, 5000);
                            }
                        }
                    }
                }
            }, CALL_DELAY_MS); 
        } catch (e) {
            console.error("Error starting game logic:", e);
        }
    }, delaySeconds * 1000);
}

async function processGameEnd(gameId, io, game) {
    if (game.hasProcessedEnd) return;
    game.hasProcessedEnd = true;

    const winnerIds = Array.from(game.winners);
    const winnerCount = winnerIds.length;
    let winnerText = "";
    
    await db.query('BEGIN');
    const gameRes = await db.query("SELECT pot, bet_amount FROM games WHERE id = $1", [gameId]);
    
    if (gameRes.rows.length === 0) {
         await db.query('ROLLBACK');
         activeGames.delete(gameId);
         return;
    }
    
    const { pot, bet_amount } = gameRes.rows[0];

    try {
        if (winnerCount >= 1) {
            // *** REFUND IF MORE THAN 3 WINNERS ***
            if (winnerCount > 3) {
                 await db.query("UPDATE games SET status = 'aborted' WHERE id = $1", [gameId]);
                 // Refund everyone who bought a card
                 const players = await db.query("SELECT user_id FROM player_cards WHERE game_id = $1", [gameId]);
                 for (let p of players.rows) {
                     await db.query("UPDATE users SET points = points + $1 WHERE id = $2", [bet_amount, p.user_id]);
                     if (db.logTransaction) await db.logTransaction(p.user_id, 'game_refund', bet_amount, null, gameId, `Refund (>3 Winners) Game #${game.dailyId}`);
                 }
                 winnerText = "Too many winners! Game Refunded.";
                 io.to(`game_${gameId}`).emit('gameStateUpdate', { status: 'finished', gameId, displayId: game.dailyId, winner: "Refunded (>3 Winners)", pot: 0 });
                 await db.query('COMMIT');
                 if (gameEndCallback) gameEndCallback(gameId, "Refunded (>3 Winners)", game.dailyId);
                 activeGames.delete(gameId);
                 setTimeout(() => { io.to(`game_${gameId}`).emit('gameStateUpdate', { status: 'idle' }); }, 10000);
                 return; // Stop here
            }

            // Normal Payout (1-3 Winners)
            const splitPrize = Math.floor(pot / winnerCount);
            await db.query("UPDATE games SET status = 'finished', winner_id = $1 WHERE id = $2", [winnerIds[0], gameId]);
            
            for (const uid of winnerIds) {
                await db.query("UPDATE users SET points = points + $1 WHERE id = $2", [splitPrize, uid]);
                if (db.logTransaction) await db.logTransaction(uid, 'game_win', splitPrize, null, gameId, `Won Game #${game.dailyId} (Split ${winnerCount})`);
            }
            const namesRes = await db.query("SELECT username, points, id FROM users WHERE id = ANY($1)", [winnerIds]);
            winnerText = namesRes.rows.map(u => u.username).join(" & ");
            await db.query('COMMIT');
            
            io.to(`game_${gameId}`).emit('gameStateUpdate', { status: 'finished', gameId, displayId: game.dailyId, winner: winnerText, pot: pot });
            namesRes.rows.forEach(u => notifyUser(io, u.id, u.points, `🏆 WIN! +${splitPrize}`, true));
        } else {
             // 0 Winners
            if (gameEndCallback) gameEndCallback(gameId, "No Winner", game.dailyId);
        }
        
    } catch (e) {
        console.error(e);
        await db.query('ROLLBACK');
    }

    activeGames.delete(gameId);
    setTimeout(() => { io.to(`game_${gameId}`).emit('gameStateUpdate', { status: 'idle' }); }, 10000);
}

async function notifyUser(io, userId, points, msg, isWinner = false) {
    try {
        const sockets = await io.fetchSockets();
        for (const s of sockets) {
            if (s.userId === userId) {
                if(points > 0) s.emit('playerUpdate', { points });
                s.emit('bingoResult', { valid: true, message: msg, isWinner });
            }
        }
    } catch(e) { console.error("Notify Error", e); }
}

async function authenticateUser(userId, token) {
    try {
        const res = await db.query('SELECT * FROM users WHERE id = $1 AND session_token = $2', [userId, token]);
        return res.rows[0];
    } catch (err) { return null; }
}

async function getUser(telegramId) {
    const res = await db.query('SELECT * FROM users WHERE telegram_id = $1', [telegramId]);
    return res.rows[0];
}

async function registerUserByPhone(phone, username) {
    const userCheck = await db.query("SELECT * FROM users WHERE LOWER(username) = LOWER($1)", [username]);
    if (userCheck.rows.length > 0 && userCheck.rows[0].phone_number !== phone) {
        return { error: "Username taken!" };
    }

    const phoneCheck = await db.query("SELECT * FROM users WHERE phone_number = $1", [phone]);
    if (phoneCheck.rows.length > 0) {
        if (phoneCheck.rows[0].username.toLowerCase() !== username.toLowerCase()) {
             return { error: `Phone used by '${phoneCheck.rows[0].username}'. Phone must be unique!` };
        }
        return { user: phoneCheck.rows[0], created: false };
    }
    
    const insertRes = await db.query('INSERT INTO users (phone_number, username, points) VALUES ($1, $2, 100) RETURNING *', [phone, username]);
    return { user: insertRes.rows[0], created: true };
}

async function linkTelegramAccount(phone, tgId, username) {
    const userCheck = await db.query("SELECT * FROM users WHERE LOWER(username) = LOWER($1)", [username]);
    if (userCheck.rows.length > 0 && userCheck.rows[0].phone_number !== phone) {
        return { error: "Username taken!" };
    }

    const userByPhone = await db.query('SELECT * FROM users WHERE phone_number = $1', [phone]);
    if (userByPhone.rows.length > 0) {
        const updatedUser = await db.query('UPDATE users SET telegram_id = $1 WHERE phone_number = $2 RETURNING *', [tgId, phone]);
        return { user: updatedUser.rows[0], status: 'account_linked' };
    }

    const newUser = await db.query('INSERT INTO users (phone_number, telegram_id, username, points) VALUES ($1, $2, $3, 100) RETURNING *', [phone, tgId, username]);
    return { user: newUser.rows[0], status: 'new_user_created' };
}

function initializeSocketListeners(io) {
  io.on('connection', (socket) => {
    
    socket.on('syncGameState', async (auth) => {
        const user = await authenticateUser(auth.userId, auth.token);
        if (!user) return socket.emit('error', { message: 'Auth failed' });
        socket.userId = user.id;
        
        const hasPremium = user.premium_expires_at && new Date(user.premium_expires_at) > new Date();
        socket.emit('playerUpdate', { 
            username: user.username, 
            points: user.points, 
            isPremium: hasPremium,
            prefAutoDaub: user.pref_auto_daub,
            prefAutoBingo: user.pref_auto_bingo 
        });

        const gameRes = await db.query("SELECT * FROM games WHERE status = 'pending' OR status = 'active' ORDER BY id DESC LIMIT 1");
        if (gameRes.rows.length === 0) return socket.emit('gameStateUpdate', { status: 'idle' });
        
        const game = gameRes.rows[0];
        const cardsRes = await db.query("SELECT id, original_card_id, card_data FROM player_cards WHERE user_id = $1 AND game_id = $2", [user.id, game.id]);
        
        socket.join(`game_${game.id}`);
        const myCards = cardsRes.rows.map(c => ({ id: c.id, displayId: c.original_card_id || c.id, card_data: c.card_data }));
        const activeGame = activeGames.get(game.id);
        const calledNumbers = activeGame ? [...activeGame.calledNumbers] : [];
        
        socket.emit('gameStateUpdate', { status: game.status, gameId: game.id, displayId: game.daily_id, betAmount: game.bet_amount, pot: game.pot, calledNumbers: calledNumbers, myCards: myCards, pattern: game.winning_pattern });
        
        if (game.status === 'pending' && pendingCardStates.has(game.id)) {
            const states = {};
            pendingCardStates.get(game.id).forEach((val, key) => { states[key] = { viewers: Array.from(val.viewers), takenBy: val.takenBy }; });
            socket.emit('cardStatesUpdate', states);
        }
    });

    socket.on('updatePreferences', async (data) => {
        if (!socket.userId) return; 
        const userId = socket.userId;
        const { autoDaub, autoBingo } = data;
        const userRes = await db.query("SELECT premium_expires_at FROM users WHERE id = $1", [userId]);
        if (userRes.rows.length && userRes.rows[0].premium_expires_at && new Date(userRes.rows[0].premium_expires_at) > new Date()) {
             await db.query("UPDATE users SET pref_auto_daub = $1, pref_auto_bingo = $2 WHERE id = $3", [autoDaub, autoBingo, userId]);
             socket.emit('playerUpdate', { prefAutoDaub: autoDaub, prefAutoBingo: autoBingo });
        }
    });

    socket.on('requestCards', async (data) => {
        if (!socket.userId) return socket.emit('error', { message: 'Reconnect required' });
        const userId = socket.userId; const { gameId } = data;
        const gameRes = await db.query("SELECT * FROM games WHERE id = $1 AND status = 'pending'", [gameId]);
        if (gameRes.rows.length === 0) return socket.emit('error', { message: 'Game closed. / ጨዋታው ተዘግቷል።' });
        const game = gameRes.rows[0];
        const cardCountRes = await db.query("SELECT COUNT(*) FROM player_cards WHERE user_id = $1 AND game_id = $2", [userId, gameId]);
        if (parseInt(cardCountRes.rows[0].count) >= MAX_CARDS_PER_PLAYER) return socket.emit('error', { message: 'Max cards reached. / ከፍተኛ ካርድ ቁጥር ደርሰዋል።' });
        
        const userRes = await db.query("SELECT * FROM users WHERE id = $1", [userId]);
        if (userRes.rows.length === 0) return socket.emit('error', { message: 'User not found.' });
        if (userRes.rows[0].points < game.bet_amount) return socket.emit('error', { message: 'Not enough points. / ነጥብዎ በቂ አይደለም።' });

        const room = io.sockets.adapter.rooms.get(`game_${gameId}`);
        const playerCount = room ? room.size : 1;
        let numOptions = (playerCount * 5) + 5; if (numOptions > 50) numOptions = 50;
        const cardOptions = Array.from({ length: numOptions }, (_, i) => { const cardId = i + 1; return { id: cardId, grid: generateBingoCard(cardId + (gameId * 1000)) }; });
        socket.emit('cardOptions', { options: cardOptions, bet: game.bet_amount });
    });

    socket.on('viewCard', (data) => {
        if (!socket.userId) return;
        const userId = socket.userId; 
        const { gameId, cardId, isViewing } = data;
        if (!pendingCardStates.has(gameId)) pendingCardStates.set(gameId, new Map());
        const gameStates = pendingCardStates.get(gameId);
        if (!gameStates.has(cardId)) gameStates.set(cardId, { viewers: new Set(), takenBy: null });
        const cardState = gameStates.get(cardId);

        if (isViewing) {
            if (cardState.takenBy) return socket.emit('error', { message: 'Card taken! / ካርዱ ተይዟል!' });
            if (cardState.viewers.size > 0 && !cardState.viewers.has(userId)) return socket.emit('error', { message: 'Locked by another player! / በሌላ ሰው እየታየ ነው!' });
            cardState.viewers.add(userId);
        } else {
            cardState.viewers.delete(userId);
        }
        io.to(`game_${gameId}`).emit('cardStatesUpdate', { [cardId]: { viewers: Array.from(cardState.viewers), takenBy: cardState.takenBy } });
    });

    socket.on('requestSpecificCard', async (data) => {
        if (!socket.userId) return;
        const userId = socket.userId; const { gameId, cardNumber } = data; 
        const gameRes = await db.query("SELECT * FROM games WHERE id = $1 AND status = 'pending'", [gameId]);
        if (gameRes.rows.length === 0) return; 
        const cardNumInt = parseInt(cardNumber);
        const specificGrid = generateBingoCard(cardNumInt + (gameId * 1000));
        socket.emit('cardOptions', { options: [{ id: cardNumInt, label: `Custom #${cardNumInt}`, grid: specificGrid }], bet: gameRes.rows[0].bet_amount });
    });
    
    socket.on('selectCard', async (data) => {
        if (!socket.userId) return socket.emit('error', { message: 'Reconnect required' });
        const userId = socket.userId; const { gameId, cardGrid, cardId } = data; 
        
        const existingCard = await db.query("SELECT id FROM player_cards WHERE user_id = $1 AND game_id = $2 AND original_card_id = $3", [userId, gameId, cardId]);
        if (existingCard.rows.length > 0) {
             return socket.emit('error', { message: 'Card already selected! / ካርዱ ተመርጧል' });
        }

        const gameRes = await db.query("SELECT * FROM games WHERE id = $1 AND status = 'pending'", [gameId]);
        if (gameRes.rows.length === 0) return socket.emit('error', { message: 'Game closed. / ጨዋታው ተዘግቷል።' });
        const game = gameRes.rows[0];
        if (cardId && pendingCardStates.has(gameId)) {
            const state = pendingCardStates.get(gameId).get(cardId);
            if (state && state.takenBy && state.takenBy !== userId) return socket.emit('error', { message: 'Card taken! / ካርዱ ተይዟል!' });
        }
        
        const userRes = await db.query("SELECT points FROM users WHERE id = $1", [userId]);
        if (userRes.rows.length === 0) return socket.emit('error', { message: 'User error. Please reload.' });

        if (userRes.rows[0].points < game.bet_amount) return socket.emit('error', { message: 'Not enough points. / ነጥብ በቂ አይደለም።' });
        try {
            await db.query('BEGIN');
            const updatedUser = await db.query("UPDATE users SET points = points - $1 WHERE id = $2 RETURNING points", [game.bet_amount, userId]);
            const updatedGame = await db.query("UPDATE games SET pot = pot + $1 WHERE id = $2 RETURNING pot", [game.bet_amount, game.id]);
            const cardRes = await db.query("INSERT INTO player_cards (user_id, game_id, card_data, original_card_id) VALUES ($1, $2, $3, $4) RETURNING *", [userId, gameId, JSON.stringify(cardGrid), cardId]);
            await db.query('COMMIT');
            
            // Log Bet Transaction
            if(db.logTransaction) await db.logTransaction(userId, 'game_bet', -game.bet_amount, null, gameId, `Bet on Game #${game.daily_id || gameId}`);
            
            if(activeGames.has(game.id)) {
               const g = activeGames.get(game.id);
               const allCardsRes = await db.query("SELECT pc.id, pc.user_id, pc.card_data, u.premium_expires_at, u.pref_auto_bingo FROM player_cards pc JOIN users u ON pc.user_id = u.id WHERE pc.game_id = $1", [gameId]);
               g.cards = allCardsRes.rows.map(row => ({
                    ...row,
                    isPremium: row.premium_expires_at && new Date(row.premium_expires_at) > new Date()
                }));
            }

            if (cardId) {
                if (!pendingCardStates.has(gameId)) pendingCardStates.set(gameId, new Map());
                const gameStates = pendingCardStates.get(gameId);
                if (!gameStates.has(cardId)) gameStates.set(cardId, { viewers: new Set(), takenBy: null });
                const state = gameStates.get(cardId);
                state.takenBy = userId; state.viewers.delete(userId);
                io.to(`game_${gameId}`).emit('cardStatesUpdate', { [cardId]: { viewers: Array.from(state.viewers), takenBy: userId } });
            }
            socket.emit('joinSuccess', { card: { id: cardRes.rows[0].id, displayId: cardId, card_data: cardRes.rows[0].card_data } });
            socket.emit('playerUpdate', { points: updatedUser.rows[0].points });
            io.to(`game_${gameId}`).emit('potUpdate', { pot: updatedGame.rows[0].pot });
        } catch (txError) { await db.query('ROLLBACK'); socket.emit('error', { message: 'Transaction failed' }); }
    });

    socket.on('claimBingo', async (data) => {
        if (!socket.userId) return socket.emit('error', { message: 'Reconnect required' });
        const userId = socket.userId;
        const { cardId, gameId, markedCells } = data;
        const game = activeGames.get(gameId);
        if (!game) return socket.emit('bingoResult', { valid: false, message: 'Game not active.' });
        
        const res = await db.query("SELECT card_data, original_card_id FROM player_cards WHERE id = $1 AND user_id = $2 AND game_id = $3", [cardId, userId, gameId]);
        if (res.rows.length === 0) return socket.emit('bingoResult', { valid: false, message: 'Card not found.' });
        
        const { valid, message } = validateBingo(res.rows[0].card_data, new Set((markedCells||[]).map(String)), game.calledNumbers, game.pattern, game.lastCalledNumber);
        
        if (valid) {
            game.winners.add(userId);
            socket.emit('bingoResult', { valid: true, message: 'Bingo! Checking other players...', winningCardId: res.rows[0].original_card_id });
            if (!game.isEnding) {
                game.isEnding = true;
                clearInterval(game.intervalId); 
                io.to(`game_${gameId}`).emit('bingoResult', { valid: true, message: 'BINGO CLAIMED! Checking splits...', winningCardId: res.rows[0].original_card_id });
                setTimeout(() => { processGameEnd(gameId, io, game); }, 5000); 
            }
        } else {
            socket.emit('bingoResult', { valid: false, message: message || 'Not a bingo. / ቢንጎ አልሰራም።' });
        }
    });
  });
}

module.exports = { initializeSocketListeners, startGameLogic, getUser, registerUserByPhone, linkTelegramAccount, setGameEndCallback };