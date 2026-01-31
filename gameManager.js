const db = require('./db');

let gameEndCallback = null;
let gameStartCallback = null;

function setGameEndCallback(callback) {
    gameEndCallback = callback;
}
function setGameStartCallback(callback) {
    gameStartCallback = callback;
}

// Seeded random number generator for consistent card generation
function mulberry32(a) {
    return function () {
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
    // We use the seed to ensure Card #1 is always Card #1's layout for a specific game
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

// Routine to refund players if the server crashed while a game was active
async function cleanupStaleGames() {
    try {
        const stuckGames = await db.query("SELECT id, bet_amount, status FROM games WHERE status IN ('active', 'pending')");
        for (const game of stuckGames.rows) {
            const players = await db.query("SELECT user_id FROM player_cards WHERE game_id = $1", [game.id]);
            for (let p of players.rows) {
                await db.query("UPDATE users SET points = points + $1 WHERE id = $2", [game.bet_amount, p.user_id]);
                try {
                    if (db.logTransaction) await db.logTransaction(p.user_id, 'system_refund', game.bet_amount, null, game.id, `Server Restart Refund Game #${game.id}`);
                } catch (e) { }
            }
            await db.query("UPDATE games SET status = 'aborted' WHERE id = $1", [game.id]);
        }
        console.log("✅ Stale games cleaned.");
    } catch (e) { console.error("Cleanup Error:", e); }
}
cleanupStaleGames();

function validateBingo(cardData, markedCells, calledNumbersSet, pattern, lastCalledNumber) {
    // 1. Verify all marked numbers were actually called
    for (const numStr of markedCells) {
        if (numStr !== 'FREE' && !calledNumbersSet.has(numStr)) {
            return { valid: false, message: `Invalid! ${numStr} not called.` };
        }
    }

    // 2. Verify the last called number is involved in the win (unless logic bypassed)
    const lastCalledStr = String(lastCalledNumber);
    if (lastCalledNumber && !markedCells.has(lastCalledStr)) {
        return { valid: false, message: "Must bingo on the LAST called number!" };
    }

    const isMarked = (r, c) => {
        const val = cardData[r][c];
        return String(val) === 'FREE' || markedCells.has(String(val));
    };

    // Define Grid Coordinates
    const rows = [0, 1, 2, 3, 4].map(r => [0, 1, 2, 3, 4].map(c => [r, c]));
    const cols = [0, 1, 2, 3, 4].map(c => [0, 1, 2, 3, 4].map(r => [r, c]));
    const diag1 = [0, 1, 2, 3, 4].map(i => [i, i]);
    const diag2 = [0, 1, 2, 3, 4].map(i => [i, 4 - i]);
    const corners = [[0, 0], [0, 4], [4, 0], [4, 4]];

    const checkSet = (coords) => {
        const allMarked = coords.every(([r, c]) => isMarked(r, c));
        if (!allMarked) return false;
        if (lastCalledNumber) return coords.some(([r, c]) => String(cardData[r][c]) === lastCalledStr);
        return true;
    };

    const isFull = (coords) => coords.every(([r, c]) => isMarked(r, c));

    switch (pattern) {
        case 'any_line':
            for (const line of [...rows, ...cols, diag1, diag2]) {
                if (checkSet(line)) return { valid: true };
            }
            if (checkSet(corners)) return { valid: true };
            break;

        case 'two_lines':
            let completedSets = 0;
            let winningSetInvolvesLast = false;
            const allSets = [...rows, ...cols, diag1, diag2, corners];
            for (const line of allSets) {
                if (isFull(line)) {
                    completedSets++;
                    if (lastCalledNumber && line.some(([r, c]) => String(cardData[r][c]) === lastCalledStr)) {
                        winningSetInvolvesLast = true;
                    }
                }
            }
            if (completedSets >= 2 && (winningSetInvolvesLast || !lastCalledNumber)) return { valid: true };
            break;

        case 'x_shape':
            const xCoords = [...diag1, ...diag2];
            if (diag1.every(([r, c]) => isMarked(r, c)) && diag2.every(([r, c]) => isMarked(r, c))) {
                if (!lastCalledNumber) return { valid: true };
                if (xCoords.some(([r, c]) => String(cardData[r][c]) === lastCalledStr)) return { valid: true };
            }
            break;
        case 'l_shape':
            const lCoords = [...cols[0], ...rows[4]];
            if (lCoords.every(([r, c]) => isMarked(r, c))) {
                if (!lastCalledNumber) return { valid: true };
                if (lCoords.some(([r, c]) => String(cardData[r][c]) === lastCalledStr)) return { valid: true };
            }
            break;
        case 'corners':
            if (checkSet(corners)) return { valid: true };
            break;
        case 'plus_sign':
            const plusCoords = [...cols[2], ...rows[2]];
            if (plusCoords.every(([r, c]) => isMarked(r, c))) {
                if (!lastCalledNumber) return { valid: true };
                if (plusCoords.some(([r, c]) => String(cardData[r][c]) === lastCalledStr)) return { valid: true };
            }
            break;
        case 'u_shape':
            const uCoords = [...cols[0], ...cols[4], ...rows[4]];
            if (uCoords.every(([r, c]) => isMarked(r, c))) {
                if (!lastCalledNumber) return { valid: true };
                if (uCoords.some(([r, c]) => String(cardData[r][c]) === lastCalledStr)) return { valid: true };
            }
            break;
        case 'letter_h':
            const hCoords = [...cols[0], ...cols[4], [2, 1], [2, 2], [2, 3]];
            if (hCoords.every(([r, c]) => isMarked(r, c))) {
                if (!lastCalledNumber) return { valid: true };
                if (hCoords.some(([r, c]) => String(cardData[r][c]) === lastCalledStr)) return { valid: true };
            }
            break;
        case 'letter_t':
            const tCoords = [...rows[0], ...cols[2]];
            if (tCoords.every(([r, c]) => isMarked(r, c))) {
                if (!lastCalledNumber) return { valid: true };
                if (tCoords.some(([r, c]) => String(cardData[r][c]) === lastCalledStr)) return { valid: true };
            }
            break;
        case 'frame':
            const frameCoords = [...rows[0], ...rows[4], ...cols[0], ...cols[4]];
            if (frameCoords.every(([r, c]) => isMarked(r, c))) {
                if (!lastCalledNumber) return { valid: true };
                if (frameCoords.some(([r, c]) => String(cardData[r][c]) === lastCalledStr)) return { valid: true };
            }
            break;
        case 'full_house':
            let all = true; for (let r = 0; r < 5; r++)for (let c = 0; c < 5; c++)if (!isMarked(r, c)) all = false;
            if (all) return { valid: true };
            break;
        default: for (const line of [...rows, ...cols, diag1, diag2]) if (checkSet(line)) return { valid: true };
    }
    return { valid: false, message: "Invalid!" };
}

async function startGameLogic(gameId, io, _ignoredPattern, delaySeconds = 0) {
    const gameInfo = await db.query("SELECT winning_pattern, daily_id, pot FROM games WHERE id = $1", [gameId]);
    if (gameInfo.rows.length === 0) return;
    const pattern = gameInfo.rows[0].winning_pattern;
    const dailyId = gameInfo.rows[0].daily_id;
    const finalPrize = gameInfo.rows[0].pot;

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

            if (gameStartCallback) gameStartCallback(gameId, dailyId, finalPrize, pattern);

            io.to(`game_${gameId}`).emit('gameStateUpdate', { status: 'active', gameId, displayId: dailyId, pattern, pot: finalPrize });
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

                    // REFUND LOGIC FOR NO WINNER
                    await db.query("UPDATE games SET status = 'finished', winner_id = NULL WHERE id = $1", [gameId]);

                    const gameInfoForRefund = await db.query("SELECT bet_amount, daily_id FROM games WHERE id = $1", [gameId]);
                    const betAmount = gameInfoForRefund.rows[0]?.bet_amount || 0;
                    const dId = gameInfoForRefund.rows[0]?.daily_id;

                    const players = await db.query("SELECT user_id FROM player_cards WHERE game_id = $1", [gameId]);

                    for (let p of players.rows) {
                        await db.query("UPDATE users SET points = points + $1 WHERE id = $2", [betAmount, p.user_id]);
                        try {
                            if (db.logTransaction) await db.logTransaction(p.user_id, 'game_refund', betAmount, null, gameId, `Draw Refund Game #${dId}`);
                        } catch (e) { console.error(e); }
                    }

                    game.io.to(`game_${gameId}`).emit('gameStateUpdate', { status: 'finished', winner: "No Winner (Refunded) / ተመላሽ", pot: 0 });
                    if (gameEndCallback) gameEndCallback(gameId, "Draw (Refunded)", dailyId);
                    setTimeout(() => { game.io.to(`game_${gameId}`).emit('gameStateUpdate', { status: 'idle' }); }, 10000);
                    activeGames.delete(gameId);
                    return;
                }

                let newNumber;
                do { newNumber = String(Math.floor(Math.random() * 75) + 1); } while (game.calledNumbers.has(newNumber));
                game.calledNumbers.add(newNumber);
                game.lastCalledNumber = newNumber;

                game.io.to(`game_${gameId}`).emit('numberCalled', { number: newNumber, allCalled: [...game.calledNumbers] });

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
            if (winnerCount > 3) {
                await db.query("UPDATE games SET status = 'aborted' WHERE id = $1", [gameId]);
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
                return;
            }

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

            if (gameEndCallback) gameEndCallback(gameId, winnerText, game.dailyId);

        } else {
            if (gameEndCallback) gameEndCallback(gameId, "No Winner", game.dailyId);
        }

    } catch (e) {
        console.error(e);
        await db.query('ROLLBACK');
    }

    activeGames.delete(gameId);
    setTimeout(() => {
        createAutoGame(io);
    }, 10000);
}

async function notifyUser(io, userId, points, msg, isWinner = false) {
    try {
        const sockets = await io.fetchSockets();
        for (const s of sockets) {
            if (s.userId === userId) {
                if (points > 0) s.emit('playerUpdate', { points });
                s.emit('bingoResult', { valid: true, message: msg, isWinner });
            }
        }
    } catch (e) { console.error("Notify Error", e); }
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

    // Explicitly set points to 0 for new players
    const insertRes = await db.query('INSERT INTO users (phone_number, username, points) VALUES ($1, $2, 0) RETURNING *', [phone, username]);
    return { user: insertRes.rows[0], created: true };
}

async function linkTelegramAccount(phone, tgId, username) {
    return require('./db').linkTelegramAccount(phone, tgId, username);
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

            // --- UPDATED CARD GENERATION LOGIC (100 FIXED) ---
            // 1. Get all taken IDs for this game
            const takenRes = await db.query("SELECT original_card_id FROM player_cards WHERE game_id = $1", [gameId]);
            const takenIds = new Set(takenRes.rows.map(r => parseInt(r.original_card_id)));

            const availableOptions = [];
            const room = io.sockets.adapter.rooms.get(`game_${gameId}`);
            const playerCount = room ? room.size : 1;

            // Dynamic Limit: At least 100, but increase if players increase
            const dynamicLimit = Math.max(100, (playerCount * 5) + 20);

            // 2. Try to fill from 1 to 100 first (The "100 Fixed Cards" requirement)
            for (let i = 1; i <= 100; i++) {
                // FIXED: Include taken cards so they show as "Locked" instead of disappearing
                availableOptions.push(i);

                // If we have enough for display, stop. But respect 100 minimum.
                if (availableOptions.length >= dynamicLimit) break;
            }

            // 3. If we are running out (more than 100 players/cards needed), expand range
            if (availableOptions.length < 10) {
                let overflowStart = 101;
                while (availableOptions.length < dynamicLimit) {
                    if (!takenIds.has(overflowStart)) {
                        availableOptions.push(overflowStart);
                    }
                    overflowStart++;
                    if (overflowStart > 10000) break; // Safety break
                }
            }

            const cardOptions = availableOptions.map(id => {
                // FIXED CARDS LOGIC:
                // IDs 1-100: Use 'id' as seed (Always same layout for Card #1)
                // IDs >100: Use 'id + gameId' (Dynamic per game)
                const seed = id <= 100 ? id : id + (gameId * 1000);

                return {
                    id: id,
                    grid: generateBingoCard(seed)
                };
            });

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
            // OPTIMISTIC LOCKING: Lock in memory BEFORE DB transaction
            let lockedState = null;
            if (cardId) {
                if (!pendingCardStates.has(gameId)) pendingCardStates.set(gameId, new Map());
                const gameStates = pendingCardStates.get(gameId);
                if (!gameStates.has(cardId)) gameStates.set(cardId, { viewers: new Set(), takenBy: null });

                lockedState = gameStates.get(cardId);
                // STRICT CHECK: If taken by ANYONE (including self), reject.
                if (lockedState.takenBy) {
                    return socket.emit('error', { message: 'Card already processing! / ካርዱ እየተሰራ ነው!' });
                }

                // LOCK NOW
                lockedState.takenBy = userId;
                // Broadcast "Taken" status immediately to prevent others from clicking
                io.to(`game_${gameId}`).emit('cardStatesUpdate', { [cardId]: { viewers: Array.from(lockedState.viewers), takenBy: userId } });
            }

            const userRes = await db.query("SELECT points FROM users WHERE id = $1", [userId]);
            if (userRes.rows.length === 0) return socket.emit('error', { message: 'User error. Please reload.' });

            if (userRes.rows[0].points < game.bet_amount) return socket.emit('error', { message: 'Not enough points. / ነጥብ በቂ አይደለም።' });
            try {
                await db.query('BEGIN');
                const updatedUser = await db.query("UPDATE users SET points = points - $1 WHERE id = $2 RETURNING points", [game.bet_amount, userId]);
                // Prize is ALWAYS 70%
                // We add 70% to the pot. The remaining 30% is System/Admin Profit.
                const potShare = Math.floor(game.bet_amount * 0.7);
                const updatedGame = await db.query("UPDATE games SET pot = pot + $1 WHERE id = $2 RETURNING pot", [potShare, game.id]);

                const cardRes = await db.query("INSERT INTO player_cards (user_id, game_id, card_data, original_card_id) VALUES ($1, $2, $3, $4) RETURNING *", [userId, gameId, JSON.stringify(cardGrid), cardId]);
                await db.query('COMMIT');

                // Log Bet Transaction
                if (db.logTransaction) await db.logTransaction(userId, 'game_bet', -game.bet_amount, null, gameId, `Bet on Game #${game.daily_id || gameId}`);

                if (activeGames.has(game.id)) {
                    const g = activeGames.get(game.id);
                    const allCardsRes = await db.query("SELECT pc.id, pc.user_id, pc.card_data, u.premium_expires_at, u.pref_auto_bingo FROM player_cards pc JOIN users u ON pc.user_id = u.id WHERE pc.game_id = $1", [gameId]);
                    g.cards = allCardsRes.rows.map(row => ({
                        ...row,
                        isPremium: row.premium_expires_at && new Date(row.premium_expires_at) > new Date()
                    }));
                }

                // (Memory Lock already verified/set above)
                if (cardId && lockedState) {
                    lockedState.viewers.delete(userId);
                    // Update viewers list (takenBy is already set)
                    io.to(`game_${gameId}`).emit('cardStatesUpdate', { [cardId]: { viewers: Array.from(lockedState.viewers), takenBy: userId } });
                }
                socket.emit('joinSuccess', { card: { id: cardRes.rows[0].id, displayId: cardId, card_data: cardRes.rows[0].card_data } });
                socket.emit('playerUpdate', { points: updatedUser.rows[0].points });
                io.to(`game_${gameId}`).emit('potUpdate', { pot: updatedGame.rows[0].pot });

                // --- COUNTDOWN LOGIC (3 PLAYERS) ---
                const pCountRes = await db.query("SELECT COUNT(DISTINCT user_id) as count FROM player_cards WHERE game_id = $1", [gameId]);
                const pCount = parseInt(pCountRes.rows[0].count);
                if (pCount >= 3) {
                    // Check if already starting? We use pendingCardStates as a simple memory store for now
                    if (!pendingCardStates.has(`starting_${gameId}`)) {
                        pendingCardStates.set(`starting_${gameId}`, true);
                        const delay = 300; // 5 Mins
                        startGameLogic(gameId, io, null, delay);
                        io.to(`game_${gameId}`).emit('gameCountdown', { seconds: delay });
                    }
                }
            } catch (txError) {
                await db.query('ROLLBACK');
                console.error("Bet Tx Error", txError);

                // UNLOCK if transaction failed
                if (lockedState && lockedState.takenBy === userId) {
                    lockedState.takenBy = null;
                    io.to(`game_${gameId}`).emit('cardStatesUpdate', { [cardId]: { viewers: Array.from(lockedState.viewers), takenBy: null } });
                }
                socket.emit('error', { message: 'Transaction failed / ግዢው አልተሳካም' });
            }
        });

        // --- NEW AUTO GAME LOGIC (3 Player Countdown) ---
        socket.on('joinCheck', async () => {
            // Fetch current pending or active game
            try {
                const res = await db.query("SELECT * FROM games WHERE status IN ('pending', 'active') LIMIT 1");
                if (res.rows.length > 0) {
                    const g = res.rows[0];
                    const activeG = activeGames.get(g.id);

                    socket.emit('gameStateUpdate', {
                        status: g.status,
                        gameId: g.id,
                        displayId: g.daily_id,
                        betAmount: g.bet_amount,
                        pot: g.pot,
                        pattern: g.winning_pattern,
                        calledNumbers: activeG ? activeG.calledNumbers : [],
                        startTime: activeG ? activeG.startTime : null
                    });
                } else {
                    socket.emit('gameStateUpdate', { status: 'idle' });
                }
            } catch (e) { console.error("JoinCheck error", e); }
        });


        socket.on('claimBingo', async (data) => {
            if (!socket.userId) return socket.emit('error', { message: 'Reconnect required' });
            const userId = socket.userId;
            const { cardId, gameId, markedCells } = data;
            const game = activeGames.get(gameId);
            if (!game) return socket.emit('bingoResult', { valid: false, message: 'Game not active.' });

            const res = await db.query("SELECT card_data, original_card_id FROM player_cards WHERE id = $1 AND user_id = $2 AND game_id = $3", [cardId, userId, gameId]);
            if (res.rows.length === 0) return socket.emit('bingoResult', { valid: false, message: 'Card not found.' });

            const { valid, message } = validateBingo(res.rows[0].card_data, new Set((markedCells || []).map(String)), game.calledNumbers, game.pattern, game.lastCalledNumber);

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



// --- CLEANUP STALE GAMES (On Server Restart) ---
async function cleanupStaleGames(io) {
    try {
        console.log("🧹 Checking for Stale/Ghost Games...");
        // Find games that are 'active' or 'pending' but server just restarted (so they are dead in memory)
        // We accept that a restart kills the current game.

        const staleGames = await db.query("SELECT id, status, bet_amount, daily_id FROM games WHERE status IN ('active', 'pending')");

        if (staleGames.rows.length === 0) {
            console.log("✅ No stale games found.");
            return;
        }

        for (const game of staleGames.rows) {
            console.log(`⚠️ Cleaning up Stale Game #${game.daily_id} (ID: ${game.id}, Status: ${game.status})`);

            // 1. Mark Aborted
            await db.query("UPDATE games SET status = 'aborted' WHERE id = $1", [game.id]);

            // 2. Refund Players
            const players = await db.query("SELECT user_id FROM player_cards WHERE game_id = $1", [game.id]);
            for (const p of players.rows) {
                await db.query("UPDATE users SET points = points + $1 WHERE id = $2", [game.bet_amount, p.user_id]);
                await db.logTransaction(p.user_id, 'refund', game.bet_amount, null, game.id, `Refund for Stale Game #${game.daily_id}`);
            }
            console.log(`💰 Refunded ${players.rows.length} players.`);
        }

        // Notify clients to clear board
        io.emit('gameStateUpdate', { status: 'idle' });

    } catch (e) {
        console.error("Cleanup Error:", e);
    }
}

// --- AUTOMATIC GAME CREATION & CYCLE ---
async function createAutoGame(io) {
    try {
        console.log("🤖 Checking Auto-Game Creation...");

        // 1. Check if a game is already pending or active
        const pendingCheck = await db.query("SELECT id FROM games WHERE status IN ('pending', 'active')");
        if (pendingCheck.rows.length > 0) {
            console.log("⚠️ Game already active/pending. Skipping auto-create.");
            return;
        }

        // 2. Determine Cycle (Normal vs Special)
        // Check how many games finished TODAY or TOTAL. User said "always create one game... after 20 games make 50 bet...".
        // Let's rely on TOTAL finished games to keep the cycle consistent even across restarts?
        // Or per day? "daily_id" suggests daily cycle. "after 20 games" usually means in the current session/day.
        // Let's use Daily Count.

        const countRes = await db.query("SELECT COUNT(*) FROM games WHERE status = 'finished' AND created_at::date = CURRENT_DATE");
        const finishedToday = parseInt(countRes.rows[0].count);

        // Logic: 
        // Game 1..20: Normal (20 Bet, 2 Lines)
        // Game 21: Special (50 Bet, Full House)
        // Game 22..41: Normal
        // Game 42: Special

        // (finishedToday + 1) is the ID of the NEW game we are about to make.
        // If (finishedToday + 1) % 21 === 0? 
        // e.g. finished 20. Next is 21. 21 % 21 == 0. Special.
        // e.g. finished 0. Next is 1. Normal.

        const nextGameIndex = finishedToday + 1;
        const isSpecial = (nextGameIndex % 21 === 0);

        let betAmount = 20;
        let pattern = 'two_lines';
        let creator = 'AutoBot';
        let isAuto = true;

        if (isSpecial) {
            betAmount = 50;
            pattern = 'full_house';
        }

        const dailyCountRes = await db.query("SELECT COUNT(*) FROM games WHERE created_at::date = CURRENT_DATE");
        const dailyId = parseInt(dailyCountRes.rows[0].count) + 1;

        const res = await db.query('INSERT INTO games (bet_amount, status, pot, winning_pattern, daily_id, created_by, creator_id) VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING *', [betAmount, 'pending', 0, pattern, dailyId, creator, null]);
        const gameId = res.rows[0].id;

        console.log(`🤖 Auto-Game Created: #${dailyId} (${isSpecial ? 'SPECIAL' : 'Normal'})`);

        io.emit('gameStateUpdate', { status: 'pending', gameId, displayId: dailyId, betAmount: betAmount, pot: 0, calledNumbers: [], pattern });

        // If Special Game, start a timeout to ABORT if not played in 1 hour
        if (isSpecial) {
            setTimeout(async () => {
                const check = await db.query("SELECT status FROM games WHERE id = $1", [gameId]);
                if (check.rows.length && check.rows[0].status === 'pending') {
                    // Abort it
                    await db.query("UPDATE games SET status = 'aborted' WHERE id = $1", [gameId]);
                    // Refund
                    const refundPlayers = await db.query("SELECT user_id FROM player_cards WHERE game_id = $1", [gameId]);
                    for (let p of refundPlayers.rows) {
                        await db.query("UPDATE users SET points = points + $1 WHERE id = $2", [betAmount, p.user_id]);
                    }
                    console.log(`🛑 Special Game #${dailyId} aborted (Timeout).`);
                    io.emit('gameStateUpdate', { status: 'idle' });

                    // Force start next game (which will be Normal)
                    createAutoGame(io);
                }
            }, 60 * 60 * 1000); // 1 Hour
        }

        if (gameStartCallback) gameStartCallback(gameId, dailyId, "TBD", pattern);

    } catch (e) { console.error("AutoGame Error:", e); }
}

module.exports = { initializeSocketListeners, startGameLogic, getUser, registerUserByPhone, linkTelegramAccount, setGameEndCallback, setGameStartCallback, createAutoGame, cleanupStaleGames };