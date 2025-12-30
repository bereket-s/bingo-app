const TelegramBot = require('node-telegram-bot-api');
const Tesseract = require('tesseract.js'); // REQUIRED for Image Reading
const { getUser, registerUserByPhone, linkTelegramAccount, setGameEndCallback, setGameStartCallback } = require('./gameManager');
const db = require('./db');
const dayjs = require('dayjs');

let io;
const chatStates = {};
let botUsername = "BingoBot";

const cleanPhone = (p) => p ? p.replace(/\D/g, '') : '';

const escapeMarkdown = (text) => {
    if (!text) return '';
    return String(text).replace(/[_*[\]()`]/g, '\\$&');
};

const getLevenshteinDistance = (a, b) => {
    if (a.length === 0) return b.length;
    if (b.length === 0) return a.length;
    const matrix = [];
    for (let i = 0; i <= b.length; i++) { matrix[i] = [i]; }
    for (let j = 0; j <= a.length; j++) { matrix[0][j] = j; }
    for (let i = 1; i <= b.length; i++) {
        for (let j = 1; j <= a.length; j++) {
            if (b.charAt(i - 1) === a.charAt(j - 1)) {
                matrix[i][j] = matrix[i - 1][j - 1];
            } else {
                matrix[i][j] = Math.min(matrix[i - 1][j - 1] + 1, Math.min(matrix[i][j - 1] + 1, matrix[i - 1][j] + 1));
            }
        }
    }
    return matrix[b.length][a.length];
};

const startBot = (database, socketIo, startGameLogic) => {
    io = socketIo;

    const token = process.env.TELEGRAM_TOKEN;
    const adminIds = (process.env.ADMIN_TELEGRAM_ID || '')
        .split(',')
        .map(id => parseInt(id.trim(), 10))
        .filter(id => !isNaN(id));

    const superAdminId = adminIds.length > 0 ? adminIds[0] : null;
    const publicUrl = process.env.PUBLIC_URL;

    const saveMsgId = async (key, msgId) => {
        try {
            await db.query(
                "INSERT INTO system_settings (key, value) VALUES ($1, $2) ON CONFLICT (key) DO UPDATE SET value = $2",
                [key, String(msgId)]
            );
        } catch (e) { console.error("DB Save Msg Error:", e.message); }
    };

    const getMsgId = async (key) => {
        try {
            const res = await db.query("SELECT value FROM system_settings WHERE key = $1", [key]);
            return res.rows.length ? parseInt(res.rows[0].value) : null;
        } catch (e) { return null; }
    };

    const getGroupId = async () => {
        try {
            const res = await db.query("SELECT value FROM system_settings WHERE key = 'group_chat_id'");
            return res.rows.length ? res.rows[0].value : null;
        } catch (e) { return null; }
    };

    const isAdmin = async (id) => {
        if (adminIds.includes(id)) return true;
        const res = await db.query("SELECT role FROM users WHERE telegram_id = $1", [id]);
        return res.rows.length > 0 && (res.rows[0].role === 'admin' || res.rows[0].role === 'super_admin');
    };

    const isSuperAdmin = async (id) => {
        if (parseInt(id) === superAdminId) return true;
        const res = await db.query("SELECT role FROM users WHERE telegram_id = $1", [id]);
        return res.rows.length > 0 && res.rows[0].role === 'super_admin';
    };

    if (!token) return;

    const bot = new TelegramBot(token, {
        polling: {
            interval: 300,
            autoStart: true,
            params: { timeout: 10 }
        }
    });

    bot.on('polling_error', (error) => {
        if (['EFATAL', 'ECONNRESET', 'ETIMEDOUT'].includes(error.code)) return;
        console.error(`[Polling Error] ${error.code}: ${error.message}`);
    });

    bot.getMe().then((me) => {
        botUsername = me.username;
        console.log(`🤖 Telegram Bot initialized: @${botUsername}`);
    });

    const adminKeyboard = {
        keyboard: [
            [{ text: "🚀 Play / ይጫወቱ" }, { text: "🆕 New Game / አዲስ ጨዋታ" }],
            [{ text: "🕹 Active Games" }, { text: "📝 Register / መዝግብ" }],
            [{ text: "📝 Bulk Register / በጅምላ" }, { text: "📜 Players / ተጫዋቾች" }],
            [{ text: "🗑️ Delete User / አስወግድ" }, { text: "🏦 Set Bank / ባንክ አስገባ" }],
            [{ text: "📢 Set Group Link" }, { text: "➕ Add Points" }],
            [{ text: "➖ Remove Points" }, { text: "➕ Bulk Add" }],
            [{ text: "🔄 Reset" }, { text: "💰 End Day Report" }],
            [{ text: "📋 Transactions" }, { text: "📈 Global Stats" }],
            [{ text: "📢 Broadcast Group Link" }, { text: "⚠️ Reset All Points" }],
            [{ text: "🔧 SMS & Webhook" }, { text: "📱 App Link" }],
            [{ text: "💎 Manage Admin Balances" }]
        ],
        resize_keyboard: true,
        persistent: true
    };

    const superAdminKeyboard = {
        keyboard: [
            ...adminKeyboard.keyboard,
            [{ text: "📢 Announce Game Day" }],
            [{ text: "👥 View Admins" }, { text: "✏️ Edit User" }],
            [{ text: "👑 Promote Admin" }, { text: "🔻 Demote Admin" }],
            [{ text: "💸 Admin Transfer" }, { text: "📜 Admin History" }]
        ],
        resize_keyboard: true,
        persistent: true
    };

    const userKeyboard = {
        keyboard: [
            [{ text: "🚀 Play Bingo / ጨዋታውን ጀምር" }],
            [{ text: "💰 My Points / ነጥቦቼ" }, { text: "🏦 Deposit / ገቢ አድርግ" }],
            [{ text: "💸 Transfer / አስተላልፍ" }, { text: "🏧 Withdraw / ወጪ አድርግ" }],
            [{ text: "✏️ Edit Name / ስም ቀይር" }, { text: "📢 Join Group / ግሩፕ ይቀላቀሉ" }],
            [{ text: "ℹ️ Guide / መመሪያ" }, { text: "🌟 Buy Premium / ፕሪሚየም ይግዙ" }]
        ],
        resize_keyboard: true,
        persistent: true
    };

    const adminTransferKeyboard = {
        inline_keyboard: [[{ text: "✅ Confirm Receipt", callback_data: "adm_confirm_transfer" }]]
    };

    const shareContactKeyboard = {
        keyboard: [[{ text: "📱 Share Contact / ስልክ ቁጥር ላክ", request_contact: true }]],
        resize_keyboard: true,
        one_time_keyboard: true
    };

    const premiumPackages = {
        inline_keyboard: [
            [{ text: "1 Month (1 ወር)", callback_data: "pkg_1m" }],
            [{ text: "3 Months (3 ወር)", callback_data: "pkg_3m" }],
            [{ text: "6 Months (6 ወር)", callback_data: "pkg_6m" }],
            [{ text: "1 Year (1 ዓመት)", callback_data: "pkg_1y" }]
        ]
    };

    const getAllAdminIds = async () => {
        const envAdmins = adminIds;
        let dbAdmins = [];
        try {
            const res = await db.query("SELECT telegram_id FROM users WHERE role IN ('admin', 'super_admin')");
            dbAdmins = res.rows.map(r => parseInt(r.telegram_id)).filter(id => !isNaN(id));
        } catch (e) { console.error("DB Admin Fetch Error", e); }
        return [...new Set([...envAdmins, ...dbAdmins])];
    };

    const broadcastToGroup = async (text, options = {}) => {
        try {
            const chatId = await getGroupId();
            if (chatId) {
                const sentMsg = await bot.sendMessage(chatId, text, { parse_mode: "Markdown", ...options });
                return sentMsg.message_id;
            }
        } catch (e) {
            console.error("Broadcast Error:", e.message);
            return null;
        }
    };

    const broadcastToAllUsers = async (text, options = {}) => {
        try {
            const allUsers = await db.query("SELECT telegram_id, last_bot_msg_id FROM users WHERE telegram_id IS NOT NULL");
            let count = 0;

            for (const u of allUsers.rows) {
                const tgId = u.telegram_id;

                if (u.last_bot_msg_id) {
                    try { await bot.deleteMessage(tgId, u.last_bot_msg_id); } catch (e) { }
                }

                try {
                    const sent = await bot.sendMessage(tgId, text, { parse_mode: "Markdown", ...options });
                    await db.query("UPDATE users SET last_bot_msg_id = $1 WHERE telegram_id = $2", [sent.message_id, tgId]);
                    count++;
                } catch (e) { }

                await new Promise(r => setTimeout(r, 40));
            }
            return count;
        } catch (e) { console.error("Broadcast All Error:", e); return 0; }
    };

    const broadcastToAdmins = async (text, options = {}) => {
        const allAdmins = await getAllAdminIds();
        const sentMap = {};

        for (const id of allAdmins) {
            let opts = { ...options };
            if (!opts.reply_markup) {
                if (await isSuperAdmin(id)) {
                    opts.reply_markup = superAdminKeyboard;
                } else {
                    opts.reply_markup = adminKeyboard;
                }
            }
            try {
                const msg = await bot.sendMessage(id, text, opts);
                sentMap[id] = msg.message_id;
            } catch (e) { }
        }
        return sentMap;
    };

    const forwardPhotoToAdmins = async (fileId, caption, replyMarkup) => {
        const allAdmins = await getAllAdminIds();
        const sentMap = {};

        for (const id of allAdmins) {
            try {
                const msg = await bot.sendPhoto(id, fileId, { caption, parse_mode: "Markdown", reply_markup: replyMarkup });
                sentMap[id] = msg.message_id;
            } catch (e) { }
        }
        return sentMap;
    };

    const syncAdminMessages = async (adminMsgIds, newCaption, activeAdminId) => {
        if (!adminMsgIds) return;

        for (const [adminIdStr, msgId] of Object.entries(adminMsgIds)) {
            const adminId = parseInt(adminIdStr);
            if (adminId === activeAdminId) {
                try {
                    await bot.editMessageCaption(newCaption, { chat_id: adminId, message_id: msgId, parse_mode: "Markdown", reply_markup: { inline_keyboard: [] } });
                } catch (e) {
                    try { await bot.editMessageText(newCaption, { chat_id: adminId, message_id: msgId, parse_mode: "Markdown", reply_markup: { inline_keyboard: [] } }); } catch (ex) { }
                }
            } else {
                try {
                    await bot.editMessageCaption(newCaption, { chat_id: adminId, message_id: msgId, parse_mode: "Markdown", reply_markup: { inline_keyboard: [] } });
                } catch (e) {
                    try { await bot.editMessageText(newCaption, { chat_id: adminId, message_id: msgId, parse_mode: "Markdown", reply_markup: { inline_keyboard: [] } }); } catch (ex) { }
                }
            }
        }
    };

    setGameStartCallback(async (gameId, dailyId, prize, pattern) => {
        const inviteLink = `https://t.me/${botUsername}?start=bingo`;
        const safePattern = String(pattern).replace(/_/g, ' ').toUpperCase();

        const msg = `🎮 *GAME #${dailyId} OPEN!* / *ጨዋታ #${dailyId} ተከፍቷል!*\n\n` +
            `💰 Prize: *${prize}*\n` +
            `📜 Rule: *${safePattern}*\n\n` +
            `⚠️ **Deposit money to get points!**\n` +
            `⚠️ **ነጥብ ለማግኘት ብር ያስገቡ!**\n\n` +
            `🚀 *Join quickly before it starts!* \n` +
            `🚀 *ጨዋታው ከመጀመሩ በፊት ይቀላቀሉ!*`;

        const opts = {
            reply_markup: {
                inline_keyboard: [[{ text: "👇 JOIN GAME / ጨዋታውን ይጀምሩ 👇", url: inviteLink }]]
            }
        };

        try {
            const oldWinnerMsgId = await getMsgId('last_winner_msg_id');
            const chatId = await getGroupId();
            if (oldWinnerMsgId && chatId) await bot.deleteMessage(chatId, oldWinnerMsgId).catch(() => { });

            const oldJoinMsgId = await getMsgId('last_join_msg_id');
            if (oldJoinMsgId && chatId) await bot.deleteMessage(chatId, oldJoinMsgId).catch(() => { });
        } catch (e) { }

        const newMsgId = await broadcastToGroup(msg, opts);
        if (newMsgId) await saveMsgId('last_join_msg_id', newMsgId);

        await broadcastToAllUsers(msg, opts);
    });

    setGameEndCallback(async (gameId, winnerText, dailyId) => {
        const safeWinner = escapeMarkdown(winnerText);
        const displayId = dailyId || gameId;
        const msg = `🏁 *GAME #${displayId} ENDED!* / *ጨዋታ #${displayId} ተጠናቀቀ!*\n\n` +
            `🏆 **WINNER / አሸናፊ:**\n${safeWinner}\n\n` +
            `🎉 Congratulations! / እንኳን ደስ አለዎት!`;

        broadcastToAdmins(msg, { parse_mode: "Markdown" });

        try {
            const oldJoinMsgId = await getMsgId('last_join_msg_id');
            const chatId = await getGroupId();
            if (oldJoinMsgId && chatId) await bot.deleteMessage(chatId, oldJoinMsgId).catch(() => { });
        } catch (e) { }

        const newMsgId = await broadcastToGroup(msg);
        if (newMsgId) await saveMsgId('last_winner_msg_id', newMsgId);

        await broadcastToAllUsers(msg);
    });

    const getInviteText = () => {
        return `👋 **Bingo Game Invite / የቢንጎ ጨዋታ ግብዣ**\n\n1️⃣ Click: https://t.me/${botUsername}?start=bingo\n2️⃣ Press **START**\n3️⃣ Press **📱 Share Contact**`;
    };

    const getDetailedWelcome = () => {
        return `👋 **WELCOME TO THE BINGO COMMUNITY!**\n` +
            `**እንኳን ወደ ቢንጎ ግሩፕ በደህና መጡ!**\n\n` +
            `🤖 **BOT LINK:** @${botUsername}\n\n` +
            `🎮 **HOW TO PLAY / እንዴት እንደሚጫወቱ:**\n` +
            `1. Go to the Bot (@${botUsername}) and click **START**.\n` +
            `2. Click **'🚀 Play'** to open the game app.\n` +
            `3. When a game is created, buy your cards (1-5 cards).\n` +
            `4. Wait for the countdown. When the game starts, numbers will be called automatically.\n` +
            `5. If you get the winning pattern (e.g., Any Line), click **BINGO**!\n\n` +
            `💰 **DEPOSIT / ብር ለማስገባት:**\n` +
            `• Click **'🏦 Deposit'** in the bot.\n` +
            `• Send money to the provided Bank/Telebirr account.\n` +
            `• Send the **Transaction ID** or **Screenshot** to the bot.\n` +
            `• Admins will verify and add points to your account.`;
    };

    const triggerStart = async (chatId, user) => {
        if (!publicUrl) {
            bot.sendMessage(chatId, "❌ **System Error:** PUBLIC_URL is missing in settings.");
            return;
        }
        try {
            const token = require('crypto').randomUUID();
            await db.query('UPDATE users SET session_token = $1 WHERE id = $2', [token, user.id]);
            const url = `${publicUrl}?user_id=${user.id}&token=${token}`;
            const options = { parse_mode: "Markdown", reply_markup: { inline_keyboard: [[{ text: "🚀 Open Game / ጨዋታውን ክፈት", web_app: { url: url } }]] } };
            bot.sendMessage(chatId, `👋 **Welcome ${user.username}!**\n👇 **Click below to play:**`, options).catch(e => console.error("Msg Error:", e.message));
        } catch (e) { console.error("Start Error", e); }
    };

    bot.on('message', (msg) => {
        if (msg.new_chat_members) {
            msg.new_chat_members.forEach(member => {
                if (!member.is_bot) {
                    bot.sendMessage(msg.chat.id, getDetailedWelcome(), { parse_mode: "Markdown" }).catch(() => { });
                }
            });
        }
    });

    bot.onText(/\/start/, async (msg) => {
        const chatId = msg.chat.id;
        const tgId = msg.from.id;
        const text = msg.text || '';
        const isDeepLink = text.split(' ').length > 1;

        if (await isSuperAdmin(tgId)) {
            bot.sendMessage(chatId, "👑 *Super Admin Panel*", { parse_mode: "Markdown", reply_markup: superAdminKeyboard }).catch(() => { });
        } else if (await isAdmin(tgId)) {
            bot.sendMessage(chatId, "👑 *Admin Panel / አስተዳዳሪ*", { parse_mode: "Markdown", reply_markup: adminKeyboard }).catch(() => { });
        } else {
            try {
                const user = await getUser(tgId);
                if (!user) {
                    bot.sendMessage(chatId, `👋 **Welcome!**\n🚀 **To Start / ለመጀመር:**\nPress the button below.`, { reply_markup: shareContactKeyboard, parse_mode: "Markdown" }).catch(() => { });
                } else {
                    if (isDeepLink) {
                        triggerStart(chatId, user);
                    } else {
                        const opts = { reply_markup: userKeyboard, parse_mode: "Markdown" };
                        bot.sendMessage(chatId, `Welcome back, ${user.username}!`, opts).catch(() => { });
                    }
                }
            } catch (err) { console.error(err); }
        }
    });

    bot.on('photo', async (msg) => {
        const chatId = msg.chat.id;
        const tgId = msg.from.id;
        const state = chatStates[chatId];
        if (!state) return;

        if (state.step === 'awaiting_deposit_proof' || state.step === 'awaiting_premium_proof') {
            const photo = msg.photo[msg.photo.length - 1];
            const fileId = photo.file_id;
            const user = await getUser(tgId);
            if (!user) return delete chatStates[chatId];

            // --- IMPROVED OCR: SLIDING WINDOW FUZZY MATCH ---
            if (state.step === 'awaiting_deposit_proof') {
                const scanMsg = await bot.sendMessage(chatId, "🔍 **Scanning receipt... Please wait.**", { parse_mode: "Markdown" });
                try {
                    const fileLink = await bot.getFileLink(fileId);
                    const { data: { text } } = await Tesseract.recognize(fileLink, 'eng');

                    const cleanOCR = text.replace(/[^a-zA-Z0-9]/g, '').toUpperCase();
                    console.log(`[OCR RAW] ${cleanOCR}`);

                    // 1. CHECK UNCLAIMED (NEW DEPOSIT)
                    const pendingTxns = await db.query("SELECT * FROM bank_transactions WHERE status = 'unclaimed'");
                    let foundTxn = null;
                    let minDistance = 999;

                    for (const txn of pendingTxns.rows) {
                        const dbCode = txn.txn_code.replace(/[^a-zA-Z0-9]/g, '').toUpperCase();
                        if (dbCode.length < 5) continue;

                        if (cleanOCR.includes(dbCode)) {
                            foundTxn = txn;
                            console.log(`[OCR EXACT] Found: ${dbCode}`);
                            break;
                        }

                        const windowSize = dbCode.length;
                        const threshold = Math.ceil(dbCode.length * 0.3); // 30% tolerance

                        for (let i = 0; i <= cleanOCR.length - windowSize; i++) {
                            const window = cleanOCR.substr(i, windowSize);
                            const dist = getLevenshteinDistance(dbCode, window);

                            if (dist < minDistance && dist <= threshold) {
                                minDistance = dist;
                                foundTxn = txn;
                                console.log(`[OCR FUZZY] Best match: ${dbCode} (Dist: ${dist})`);
                            }
                        }
                    }

                    if (foundTxn) {
                        // Success!
                        const amount = foundTxn.amount;
                        await db.query("UPDATE users SET points = points + $1 WHERE id = $2", [amount, user.id]);
                        await db.query("UPDATE bank_transactions SET status = 'claimed', claimed_by = $1 WHERE id = $2", [user.id, foundTxn.id]);

                        // NEW: Attribute to Bank Admin
                        const bankAdminRes = await db.query("SELECT value FROM system_settings WHERE key = 'bank_admin_id'");
                        const bankAdminId = bankAdminRes.rows.length ? parseInt(bankAdminRes.rows[0].value) : null;

                        if (bankAdminId) {
                            await db.query("UPDATE users SET admin_balance = COALESCE(admin_balance, 0) + $1 WHERE telegram_id = $2", [amount, bankAdminId]);
                        }

                        // Log Transaction
                        const adminNote = bankAdminId ? ` (Credited to Admin ${bankAdminId})` : '';
                        await db.logTransaction(user.id, 'deposit', amount, null, null, `Auto-Deposit via OCR${adminNote}`);

                        await bot.deleteMessage(chatId, scanMsg.message_id).catch(() => { });
                        bot.sendMessage(chatId, `✅ **Instant Deposit Success!**\n\nMatched Txn: ${foundTxn.txn_code}\nAmount: ${amount} ETB\n\nPoints Added.`, { reply_markup: userKeyboard });
                        delete chatStates[chatId];
                        return;
                    }

                    // 2. CHECK CLAIMED (DUPLICATE ATTEMPT)
                    const claimedTxns = await db.query("SELECT * FROM bank_transactions WHERE status = 'claimed' ORDER BY created_at DESC LIMIT 500");
                    let duplicateTxn = null;
                    minDistance = 999; // Reset distance tracker

                    for (const txn of claimedTxns.rows) {
                        const dbCode = txn.txn_code.replace(/[^a-zA-Z0-9]/g, '').toUpperCase();
                        if (dbCode.length < 5) continue;

                        if (cleanOCR.includes(dbCode)) {
                            duplicateTxn = txn;
                            break;
                        }

                        // Fuzzy match for duplicates too
                        const windowSize = dbCode.length;
                        const threshold = Math.ceil(dbCode.length * 0.3);

                        for (let i = 0; i <= cleanOCR.length - windowSize; i++) {
                            const window = cleanOCR.substr(i, windowSize);
                            const dist = getLevenshteinDistance(dbCode, window);
                            if (dist < minDistance && dist <= threshold) {
                                duplicateTxn = txn;
                            }
                        }
                    }

                    if (duplicateTxn) {
                        // REJECT: Duplicate found in history
                        await bot.deleteMessage(chatId, scanMsg.message_id).catch(() => { });
                        bot.sendMessage(chatId, `⚠️ **Duplicate Transaction!**\n\nThe Transaction ID **${duplicateTxn.txn_code}** has already been used.`, { reply_markup: userKeyboard });
                        delete chatStates[chatId];
                        return;
                    }

                    // 3. NO MATCH -> MANUAL REVIEW
                    await bot.deleteMessage(chatId, scanMsg.message_id).catch(() => { });
                    bot.sendMessage(chatId, "⚠️ Could not auto-read transaction ID. Sending to admin for manual review...");

                } catch (e) {
                    console.error("OCR Error:", e);
                    // Fallthrough to manual if OCR fails
                }
            }
            // --- END OCR ---

            let amount = 0;
            let type = 'points';
            let duration = null;

            if (state.step === 'awaiting_deposit_proof') amount = state.amount;
            else { type = 'premium'; duration = state.duration; amount = 0; }

            try {
                const res = await db.query(
                    "INSERT INTO deposits (user_id, telegram_id, amount, proof_image_id, status, request_type, package_duration) VALUES ($1, $2, $3, $4, 'pending', $5, $6) RETURNING id",
                    [user.id, tgId, amount, fileId, type, duration]
                );
                const depId = res.rows[0].id;
                bot.sendMessage(chatId, "✅ *Proof Received!*\nSent to admins for approval.", { parse_mode: "Markdown", reply_markup: userKeyboard });

                let caption = "";
                let callbackPrefix = "";
                if (type === 'points') {
                    caption = `💰 *New Deposit*\nUser: ${escapeMarkdown(user.username)}\nAmount: ${amount}`;
                    callbackPrefix = "dep";
                } else {
                    caption = `🌟 *New Premium*\nUser: ${escapeMarkdown(user.username)}\nDuration: ${duration}`;
                    callbackPrefix = "prem";
                }

                const markup = {
                    inline_keyboard: [
                        [{ text: "✅ Approve", callback_data: `${callbackPrefix}_approve_${depId}_${amount}` }],
                        [{ text: "❌ Reject", callback_data: `${callbackPrefix}_reject_${depId}_${amount}` }]
                    ]
                };

                const adminMsgIds = await forwardPhotoToAdmins(fileId, caption, markup);
                await db.query("UPDATE deposits SET admin_msg_ids = $1 WHERE id = $2", [JSON.stringify(adminMsgIds), depId]);

                delete chatStates[chatId];
            } catch (e) { console.error(e); bot.sendMessage(chatId, "❌ Database Error."); }
        }
    });

    bot.on('contact', async (msg) => {
        const tgId = msg.from.id;
        const phone = cleanPhone(msg.contact.phone_number);
        const chatId = msg.chat.id;
        if (msg.contact.user_id !== tgId) return;
        try {
            const phoneCheck = await db.query("SELECT * FROM users WHERE phone_number = $1", [phone]);
            if (phoneCheck.rows.length > 0) {
                const result = await linkTelegramAccount(phone, tgId, phoneCheck.rows[0].username);
                if (result.error) bot.sendMessage(chatId, `❌ **Error:** ${result.error}`, { reply_markup: userKeyboard });
                else {
                    const kb = (await isSuperAdmin(tgId)) ? superAdminKeyboard : (await isAdmin(tgId) ? adminKeyboard : userKeyboard);
                    bot.sendMessage(chatId, `✅ **Registered!**\nWelcome, ${result.user.username}!`, { parse_mode: "Markdown", reply_markup: kb });
                    triggerStart(chatId, result.user);
                }
            } else {
                chatStates[chatId] = { step: 'awaiting_initial_username', regPhone: phone };
                bot.sendMessage(chatId, "👤 **Enter Username:**", { reply_markup: { force_reply: true }, parse_mode: "Markdown" });
            }
        } catch (err) { console.error(err); }
    });

    bot.on('callback_query', async (cq) => {
        const action = cq.data;
        const msg = cq.message;
        const chatId = msg.chat.id;
        const tgId = cq.from.id;
        const adminUser = await getUser(tgId);

        try {
            if (action === 'end_day_broadcast') {
                if (!await isAdmin(tgId)) return bot.answerCallbackQuery(cq.id, { text: "Not authorized!" });

                await bot.answerCallbackQuery(cq.id, { text: "Sending Broadcast..." });

                // 1. Edit the admin message to show it's done
                try {
                    await bot.editMessageText(`${msg.text}\n\n✅ **DAY ENDED & BROADCAST SENT**`, { chat_id: chatId, message_id: msg.message_id, parse_mode: "Markdown", reply_markup: { inline_keyboard: [] } });
                } catch (e) { }

                // 1.5 DEDUCT NET PROFIT FROM BANK ADMIN
                // Logic: The "Bank Admin" holds the cash. The "System Profit" is money that belongs to the house, not the bank admin's liability.
                // So we reduce their liability (admin_balance) by the profit amount.
                // Wait, if they hold the cash, and profit is "house money", technically...
                // User said: "remove the profit balance from the admin whose bank is set".
                // If Admin has +1000 balance (liability), and we made 200 profit.
                // If we remove 200 from their balance, they now owe 800.
                // This implies the 200 is "theirs" or "system's" and is no longer a debt to players.
                // Correct.
                try {
                    const bankAdminRes = await db.query("SELECT value FROM system_settings WHERE key = 'bank_admin_id'");
                    const bankAdminId = bankAdminRes.rows.length ? parseInt(bankAdminRes.rows[0].value) : null;

                    // We need the profit amount. It's in daily_reports.
                    const report = await db.query("SELECT net_profit FROM daily_reports WHERE date = CURRENT_DATE");
                    if (report.rows.length > 0 && bankAdminId) {
                        const profit = report.rows[0].net_profit;
                        await db.query("UPDATE users SET admin_balance = COALESCE(admin_balance, 0) - $1 WHERE telegram_id = $2", [profit, bankAdminId]);
                        await db.logTransaction(bankAdminId, 'system_profit_deduct', -profit, null, null, `End Day Profit Deduction`, bankAdminId); // Log for history

                        // Notify Bank Admin
                        bot.sendMessage(bankAdminId, `📉 **End of Day Update**\n\nNet Profit (${profit}) has been deducted from your Admin Balance.`).catch(() => { });
                    }
                } catch (e) { console.error("Profit Deduct Error", e); }


                // 2. Broadcast to ALL users
                const broadcastMessage =
                    "📢 **Game Update**\n\n" +
                    "Thank you for playing today! The game session has ended.\n" +
                    "We will see you tomorrow! 👋\n\n" +
                    "Good night! / ደህና እደሩ!";

                await broadcastToAllUsers(broadcastMessage);

                // 3. Confirm
                await bot.sendMessage(chatId, "✅ Broadcast sent. Profit deducted from Bank Admin.");
                return;
            }

            if (action === 'dummy_deposit') {
                const bankRes = await db.query("SELECT value FROM system_settings WHERE key = 'bank_details'");
                chatStates[chatId] = { step: 'awaiting_deposit_amount' };
                bot.sendMessage(chatId, `🏦 *Bank Info*\n${bankRes.rows[0]?.value || 'Contact Admin'}\n\n👇 *Enter Amount:*`, { parse_mode: "Markdown", reply_markup: { force_reply: true } });
                await bot.answerCallbackQuery(cq.id);
                return;
            }

            if (action.startsWith('pkg_')) {
                const duration = action.replace('pkg_', '');
                chatStates[chatId] = { step: 'awaiting_premium_proof', duration: duration };
                const bankRes = await db.query("SELECT value FROM system_settings WHERE key = 'bank_details'");
                bot.sendMessage(chatId, `💎 *Selected: ${duration}*\nPay via:\n${bankRes.rows[0]?.value}\n👇 *Send Screenshot:*`, { parse_mode: "Markdown" }).catch(() => { });
                return;
            }

            if (action.startsWith('rule_')) {
                const pattern = action.replace('rule_', '');
                if (!chatStates[chatId] || chatStates[chatId].step !== 'awaiting_pattern') return;
                chatStates[chatId].pattern = pattern;
                chatStates[chatId].step = 'awaiting_bet';
                bot.sendMessage(chatId, `✅ Rule Selected. Enter bet amount:`, { parse_mode: "Markdown" }).catch(() => { });
                return;
            }

            if (action.startsWith('gm_')) {
                const parts = action.split('_');
                const cmd = parts[1];
                const gameId = parseInt(parts[2]);

                const gameRes = await db.query("SELECT bet_amount, status, pot, winning_pattern, daily_id, created_by, creator_id FROM games WHERE id = $1", [gameId]);
                if (gameRes.rows.length === 0) return bot.answerCallbackQuery(cq.id, { text: "Game not found" });
                const game = gameRes.rows[0];

                const isCreator = String(game.creator_id) === String(tgId);
                const isSuper = await isSuperAdmin(tgId);

                if (cmd !== 'refresh' && !isCreator && !isSuper) {
                    return bot.answerCallbackQuery(cq.id, { text: "⛔ Permission Denied: Only the Creator or Super Admin can manage this game.", show_alert: true });
                }

                const stats = await db.query("SELECT COUNT(DISTINCT user_id) as users, COUNT(*) as cards FROM player_cards WHERE game_id = $1", [gameId]);
                const totalCollected = parseInt(stats.rows[0].cards) * parseInt(game.bet_amount);
                const creator = game.created_by || "Unknown";

                if (cmd === 'refresh') {
                    if (game.status !== 'pending') return bot.answerCallbackQuery(cq.id, { text: "Game started/finished!" });
                    const newText = `🎮 *Game #${game.daily_id} Pending*\nOpened by: ${creator}\n\n👥 Players: ${stats.rows[0].users}\n🎫 Cards: ${stats.rows[0].cards}\n💰 Pool: ${totalCollected}`;
                    const kb = { inline_keyboard: [[{ text: "🔄 Refresh", callback_data: `gm_refresh_${gameId}` }], [{ text: "▶️ START", callback_data: `gm_pre_${gameId}` }], [{ text: "🛑 ABORT", callback_data: `gm_abort_${gameId}` }]] };
                    try { await bot.editMessageText(newText, { chat_id: chatId, message_id: msg.message_id, parse_mode: "Markdown", reply_markup: kb }); } catch (e) { }
                    await bot.answerCallbackQuery(cq.id, { text: "Refreshed" });
                }
                else if (cmd === 'pre') {
                    const text = `💰 *Set Prize for Game #${game.daily_id}*\nTotal: ${totalCollected}\nChoose:`;
                    const kb = { inline_keyboard: [[{ text: `70% (${Math.floor(totalCollected * 0.7)})`, callback_data: `gm_setprize_${gameId}_70` }], [{ text: "✏️ Custom", callback_data: `gm_setprize_${gameId}_custom` }]] };
                    chatStates[chatId] = { ...chatStates[chatId], max: totalCollected, gameId: gameId, dailyId: game.daily_id };
                    bot.sendMessage(chatId, text, { reply_markup: kb, parse_mode: "Markdown" }).catch(() => { });
                    await bot.answerCallbackQuery(cq.id);
                }
                else if (cmd === 'setprize') {
                    const prizeType = parts[3];
                    if (prizeType === '70') {
                        const newPot = Math.floor(totalCollected * 0.7);
                        await db.query("UPDATE games SET pot = $1 WHERE id = $2", [newPot, gameId]);
                        chatStates[chatId] = { step: 'awaiting_start_seconds', gameId: gameId, dailyId: game.daily_id };
                        bot.sendMessage(chatId, `✅ *Prize set to ${newPot}*\n\n⏱ Enter countdown seconds to START (e.g., 10):`, { parse_mode: "Markdown" }).catch(() => { });
                    } else {
                        chatStates[chatId] = { step: 'awaiting_custom_prize', gameId: gameId, max: totalCollected, dailyId: game.daily_id };
                        bot.sendMessage(chatId, `✏️ *Enter Custom Prize:*`, { parse_mode: "Markdown" }).catch(() => { });
                    }
                    await bot.answerCallbackQuery(cq.id);
                }
                else if (cmd === 'abort') {
                    await db.query("UPDATE games SET status = 'aborted' WHERE id = $1", [gameId]);
                    const players = await db.query("SELECT user_id FROM player_cards WHERE game_id = $1", [gameId]);
                    for (let p of players.rows) {
                        await db.query("UPDATE users SET points = points + $1 WHERE id = $2", [parseInt(game.bet_amount), p.user_id]);
                    }
                    bot.sendMessage(chatId, `🛑 *Game #${game.daily_id} Aborted.* Refunded.`, { reply_markup: adminKeyboard, parse_mode: "Markdown" });
                    await bot.answerCallbackQuery(cq.id);
                }
                return;
            }

            if (action.startsWith('dep_') || action.startsWith('wd_') || action.startsWith('prem_')) {
                const parts = action.split('_');
                const type = parts[0];
                const decision = parts[1];
                const targetId = parseInt(parts[2]);
                const val = parts[3];

                if (type === 'dep' && decision === 'reject' && parts.length === 4) {
                    const kb = {
                        inline_keyboard: [
                            [{ text: "Wrong Amount / የተሳሳተ ብር", callback_data: `dep_reject_${targetId}_${val}_amount` }],
                            [{ text: "Fake/No Receipt / ደረሰኝ የለም", callback_data: `dep_reject_${targetId}_${val}_fake` }],
                            [{ text: "Other/Cancel / ሌሎች", callback_data: `dep_reject_${targetId}_${val}_other` }]
                        ]
                    };
                    bot.editMessageCaption(`⚠️ *Select Rejection Reason:*`, { chat_id: chatId, message_id: msg.message_id, parse_mode: "Markdown", reply_markup: kb });
                    return;
                }

                if (type === 'dep' || type === 'prem') {
                    // CHECK PERMISSION: Only Bank Admin or Super Admin
                    const bankAdminRes = await db.query("SELECT value FROM system_settings WHERE key = 'bank_admin_id'");
                    const bankAdminId = bankAdminRes.rows.length ? parseInt(bankAdminRes.rows[0].value) : null;
                    const isSuper = await isSuperAdmin(tgId);

                    if (!isSuper && (!bankAdminId || bankAdminId !== tgId)) {
                        return bot.answerCallbackQuery(cq.id, { text: "⛔ Permission Denied: Only the Bank Admin or Super Admin can approve this.", show_alert: true });
                    }

                    const depRes = await db.query("SELECT * FROM deposits WHERE id = $1 AND status = 'pending' FOR UPDATE SKIP LOCKED", [targetId]);
                    if (depRes.rows.length === 0) return bot.answerCallbackQuery(cq.id, { text: "Already processed by another admin!", show_alert: true });

                    const deposit = depRes.rows[0];
                    const adminMsgIds = deposit.admin_msg_ids || {};

                    if (type === 'dep') {
                        if (decision === 'approve') {
                            await db.query("UPDATE deposits SET status = 'approved' WHERE id = $1", [targetId]);
                            await db.query("UPDATE users SET points = points + $1 WHERE id = $2", [parseInt(val), deposit.user_id]);

                            // UPDATED: Pass adminID
                            await db.logTransaction(deposit.user_id, 'deposit', parseInt(val), null, null, `Deposit Approved by ${adminUser?.username}`, adminUser.id);

                            // NEW: Update BANK Admin Balance (Not necessarily Approver)
                            const bankAdminRes = await db.query("SELECT value FROM system_settings WHERE key = 'bank_admin_id'");
                            const bankAdminId = bankAdminRes.rows.length ? parseInt(bankAdminRes.rows[0].value) : null;

                            // If Bank Admin exists, credit THEM. Else credit approver (fallback).
                            const creditTargetId = bankAdminId ? bankAdminId : tgId;

                            if (bankAdminId) {
                                await db.query("UPDATE users SET admin_balance = COALESCE(admin_balance, 0) + $1 WHERE telegram_id = $2", [parseInt(val), bankAdminId]);
                            } else {
                                await db.query("UPDATE users SET admin_balance = COALESCE(admin_balance, 0) + $1 WHERE id = $2", [parseInt(val), tgId]);
                            }

                            const doneText = `✅ *APPROVED by ${adminUser?.username}*\n+${val} Points\n(User: ${deposit.user_id})`;
                            await syncAdminMessages(adminMsgIds, doneText, tgId);

                            if (deposit.telegram_id) bot.sendMessage(deposit.telegram_id, `✅ *Deposit Accepted!*\n\n+${val} Points`, { parse_mode: "Markdown" }).catch(() => { });
                        }
                        else if (decision === 'reject' && parts.length === 5) {
                            const reasonCode = parts[4];
                            let reasonText = "Admin rejected request.";
                            if (reasonCode === 'amount') reasonText = "❌ Rejected: Incorrect Amount sent. Please check and try again. / የተላከው ብር ልክ አይደለም።";
                            if (reasonCode === 'fake') reasonText = "❌ Rejected: Invalid Receipt/Fake. / ደረሰኙ ትክክል አይደለም።";

                            await db.query("UPDATE deposits SET status = 'rejected' WHERE id = $1", [targetId]);

                            const doneText = `❌ *REJECTED by ${adminUser?.username}*\nReason: ${reasonCode}`;
                            await syncAdminMessages(adminMsgIds, doneText, tgId);

                            if (deposit.telegram_id) bot.sendMessage(deposit.telegram_id, reasonText, { parse_mode: "Markdown" }).catch(() => { });
                        }
                    }
                    else if (type === 'prem') {
                        const duration = deposit.package_duration || '1m';
                        if (decision === 'approve') {
                            let months = 1;
                            if (duration === '3m') months = 3;
                            if (duration === '6m') months = 6;
                            if (duration === '1y') months = 12;
                            const expiry = dayjs().add(months, 'month').format();

                            await db.query("UPDATE deposits SET status = 'approved' WHERE id = $1", [targetId]);
                            await db.query("UPDATE users SET premium_expires_at = $1, pref_auto_daub = TRUE, pref_auto_bingo = TRUE WHERE id = $2", [expiry, deposit.user_id]);

                            const doneText = `✅ *PREMIUM (${duration.toUpperCase()}) APPROVED*\nBy ${adminUser?.username}`;
                            await syncAdminMessages(adminMsgIds, doneText, tgId);

                            if (deposit.telegram_id) bot.sendMessage(deposit.telegram_id, `🌟 *Premium Activated!*\nDuration: ${duration.toUpperCase()}`, { parse_mode: "Markdown" }).catch(() => { });
                        } else {
                            await db.query("UPDATE deposits SET status = 'rejected' WHERE id = $1", [targetId]);

                            const doneText = `❌ *PREMIUM REJECTED* by ${adminUser?.username}`;
                            await syncAdminMessages(adminMsgIds, doneText, tgId);

                            if (deposit.telegram_id) bot.sendMessage(deposit.telegram_id, `❌ *Premium Request Rejected*`, { parse_mode: "Markdown" }).catch(() => { });
                        }
                    }
                }
                else if (type === 'wd') {
                    const wdRes = await db.query("SELECT * FROM withdrawal_requests WHERE id = $1 AND status = 'pending' FOR UPDATE SKIP LOCKED", [targetId]);
                    if (wdRes.rows.length === 0) return bot.answerCallbackQuery(cq.id, { text: "Already processed!", show_alert: true });

                    const req = wdRes.rows[0];
                    const adminMsgIds = req.admin_msg_ids || {};
                    const isSuper = await isSuperAdmin(tgId);

                    // STRICT WITHDRAWAL CHECK: Only the Recipient Admin (who got the msg) can approve.
                    // Even Super Admin CANNOT approve if it wasn't routed to them.
                    const assignedMsgId = adminMsgIds[String(tgId)];
                    if (!assignedMsgId) {
                        return bot.answerCallbackQuery(cq.id, { text: "⛔ Permission Denied: This withdrawal was routed to another Admin.", show_alert: true });
                    }

                    if (decision === 'approve') {
                        // DEDUCT FROM ADMIN BALANCE (The one who clicked Approve)
                        await db.query("UPDATE users SET admin_balance = COALESCE(admin_balance, 0) - $1 WHERE id = $2", [parseInt(val), adminUser.id]);

                        // UPDATED: Pass adminUser.id
                        await db.logTransaction(req.user_id, 'withdraw', -parseInt(val), null, null, `Withdrawal Approved by ${adminUser?.username}`, adminUser.id);
                        await db.query("UPDATE withdrawal_requests SET status = 'approved' WHERE id = $1", [targetId]);

                        const doneText = `✅ *PAID by ${adminUser?.username}*\nAmount: ${val}`;
                        await syncAdminMessages(adminMsgIds, doneText, tgId);

                        bot.sendMessage(req.telegram_id, `✅ *Withdrawal Sent!*\n\n${val} Points processed.`, { parse_mode: "Markdown" }).catch(() => { });
                    } else {
                        await db.query("UPDATE users SET points = points + $1 WHERE id = $2", [parseInt(val), req.user_id]);
                        await db.query("UPDATE withdrawal_requests SET status = 'rejected' WHERE id = $1", [targetId]);

                        const doneText = `❌ *REFUNDED by ${adminUser?.username}*\nAmount: ${val}`;
                        await syncAdminMessages(adminMsgIds, doneText, tgId);

                        bot.sendMessage(req.telegram_id, `❌ *Withdrawal Failed*\nPoints refunded.`, { parse_mode: "Markdown" }).catch(() => { });
                    }
                }
            }

            if (action.startsWith('adm_confirm_')) {
                const trId = parseInt(action.replace('adm_confirm_', ''));
                const trRes = await db.query("SELECT * FROM admin_transfers WHERE id = $1 AND status = 'pending'", [trId]);

                if (trRes.rows.length === 0) return bot.answerCallbackQuery(cq.id, { text: "Transfer already processed or invalid.", show_alert: true });
                const transfer = trRes.rows[0];

                // Verify Recipient
                const recipientUser = await db.query("SELECT telegram_id FROM users WHERE id = $1", [transfer.to_admin_id]);
                if (recipientUser.rows.length === 0 || recipientUser.rows[0].telegram_id != tgId) {
                    return bot.answerCallbackQuery(cq.id, { text: "Not authorized. You are not the recipient.", show_alert: true });
                }

                // Execute Transfer
                await db.query("UPDATE users SET admin_balance = COALESCE(admin_balance, 0) - $1 WHERE id = $2", [transfer.amount, transfer.from_admin_id]);
                await db.query("UPDATE users SET admin_balance = COALESCE(admin_balance, 0) + $1 WHERE id = $2", [transfer.amount, transfer.to_admin_id]);
                await db.query("UPDATE admin_transfers SET status = 'completed' WHERE id = $1", [trId]);

                await bot.editMessageText(`✅ **Transfer Confirmed!**\n\nAmount: ${transfer.amount} Added to your balance.`, { chat_id: chatId, message_id: msg.message_id, parse_mode: "Markdown" });

                // Notify Sender
                const sender = await db.query("SELECT telegram_id, username FROM users WHERE id = $1", [transfer.from_admin_id]);
                if (sender.rows.length && sender.rows[0].telegram_id) {
                    bot.sendMessage(sender.rows[0].telegram_id, `✅ **Transfer Completed!**\n\n${transfer.amount} deducted from your balance.`);
                }

                // LOG TRANSACTION
                await db.logTransaction(transfer.to_admin_id, 'admin_transfer', transfer.amount, null, null, `Transfer from Admin ${sender.rows[0]?.username}`, transfer.from_admin_id);
            }

            if (action.startsWith('adm_bal_')) {
                const act = action.replace('adm_bal_', ''); // 'add' or 'remove'
                if (chatStates[chatId] && chatStates[chatId].step === 'awaiting_adm_bal_action') {
                    chatStates[chatId].step = 'awaiting_adm_bal_final';
                    chatStates[chatId].actionType = act;

                    const verb = act === 'add' ? 'Add' : 'Remove';
                    bot.sendMessage(chatId, `🔢 **Enter Amount to ${verb}:**`, { parse_mode: "Markdown" });
                    await bot.answerCallbackQuery(cq.id);
                } else {
                    await bot.answerCallbackQuery(cq.id, { text: "Session expired. Try again.", show_alert: true });
                }
            }
        } catch (err) { console.error("Callback Error:", err); }
    });

    bot.on('message', async (msg) => {
        const chatId = msg.chat.id;
        const tgId = msg.from.id; // Added to fix ReferenceError
        const text = msg.text;
        if (!text) return;

        if (text === "📢 Join Group / ግሩፕ ይቀላቀሉ") {
            const groupRes = await db.query("SELECT value FROM system_settings WHERE key = 'group_link'");
            const url = groupRes.rows[0]?.value;
            if (url) {
                bot.sendMessage(chatId, "📢 **Click to Join:**", { reply_markup: { inline_keyboard: [[{ text: "📢 JOIN GROUP", url: url }]] }, parse_mode: "Markdown" });
            } else {
                bot.sendMessage(chatId, "⚠️ No group link set.");
            }
            return;
        }

        if (text === "📢 Announce Game Day") {
            if (await isSuperAdmin(tgId)) {
                const groupRes = await db.query("SELECT value FROM system_settings WHERE key = 'group_link'");
                const url = groupRes.rows[0]?.value;
                const link = url || `https://t.me/${botUsername}`;

                bot.sendMessage(chatId, "📢 Sending Game Day Announcement to ALL players...");

                const fancyMsg = `🔥 **BINGO DAY IS HERE!** 🔥\n` +
                    `**ቢንጎ ጨዋታ የሚካሄድበት ቀን!**\n\n` +
                    `📅 **Every Day Schedule / የየቀኑ ፕሮግራም:**\n` +
                    `🕗 **Start:** 2:00 PM (Afternoon) | 8:00 (ቀን)\n` +
                    `🕓 **End:** 10:00 PM (Night) | 4:00 (ማታ)\n\n` +
                    `💰 **Deposit Money NOW to be ready!**\n` +
                    `💰 **አሁኑኑ ብር አስገብተው ይዘጋጁ!**\n\n` +
                    `👇 **JOIN THE CHANNEL & GROUP to Play:**`;

                const opts = {
                    parse_mode: "Markdown",
                    reply_markup: {
                        inline_keyboard: [
                            [{ text: "🏦 Deposit / ብር አስገባ", callback_data: "dummy_deposit" }],
                            [{ text: "📢 JOIN GROUP / ግሩፕ", url: link }]
                        ]
                    }
                };

                await broadcastToAllUsers(fancyMsg, opts);
                bot.sendMessage(chatId, `✅ Announcement sent.`);
            }
            return;
        }

        if (text === "✏️ Edit User") {
            if (await isSuperAdmin(tgId)) {
                chatStates[chatId] = { step: 'awaiting_edit_search' };
                bot.sendMessage(chatId, "✏️ **Edit User Mode**\n\nSend the **Phone Number** or **Current Username** of the player you want to edit:", { parse_mode: "Markdown", reply_markup: { force_reply: true } });
            }
            return;
        }

        if (text === "👥 View Admins") {
            if (await isSuperAdmin(tgId)) {
                const admins = await db.query("SELECT username, phone_number, role FROM users WHERE role IN ('admin', 'super_admin')");
                let msg = "👑 **Admin List:**\n\n";
                admins.rows.forEach(a => {
                    msg += `👤 ${a.username} (${a.phone_number || 'No Phone'})\nRole: ${a.role}\n\n`;
                });
                bot.sendMessage(chatId, msg, { parse_mode: "Markdown" });
            }
            return;
        }

        if (text === "📜 Admin History") {
            if (await isSuperAdmin(tgId)) {
                // Expanded History Query
                const history = await db.query(
                    `SELECT t.created_at, t.type, t.amount, t.description, 
                            u.username as admin_name, 
                            target.username as target_name,
                            target.telegram_id as target_tg,
                            u.telegram_id as admin_tg
                     FROM transactions t
                     LEFT JOIN users u ON t.admin_id = u.id
                     LEFT JOIN users target ON t.user_id = target.id
                     WHERE t.admin_id IS NOT NULL 
                        OR t.type IN ('deposit', 'withdraw', 'system_profit_deduct', 'admin_bal_adj', 'admin_transfer')
                     ORDER BY t.created_at DESC LIMIT 50`
                );

                if (history.rows.length === 0) {
                    bot.sendMessage(chatId, "📭 No admin history found yet.");
                } else {
                    let logMsg = "📜 **ADMIN HISTORY LOG**\n\n";
                    let currentDay = "";

                    // Bank Admin Info
                    const bankAdminRes = await db.query("SELECT value FROM system_settings WHERE key = 'bank_admin_id'");
                    const bankAdminId = bankAdminRes.rows.length ? bankAdminRes.rows[0].value : null;

                    history.rows.forEach(row => {
                        const date = new Date(row.created_at);
                        const dayStr = date.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
                        const timeStr = date.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' });

                        if (dayStr !== currentDay) {
                            logMsg += `📅 *${dayStr.toUpperCase()}*\n`;
                            currentDay = dayStr;
                        }

                        let icon = "🔧";
                        let title = "ACTION";
                        let sign = "";

                        // DEPOSITS
                        if (row.type === 'deposit') {
                            icon = "🟢";
                            title = "DEPOSIT APPROVED";
                            sign = "+";
                        }
                        // WITHDRAWALS
                        else if (row.type === 'withdraw') {
                            icon = "🔴";
                            title = "WITHDRAWAL PAID";
                            sign = ""; // Amount stored as negative
                        }
                        // POINTS ADD/REMOVE
                        else if (row.type === 'admin_add') { icon = "➕"; title = "POINTS ADDED"; sign = "+"; }
                        else if (row.type === 'admin_remove') { icon = "➖"; title = "POINTS REMOVED"; sign = ""; } // stored neg
                        else if (row.type === 'system_profit_deduct') { icon = "📉"; title = "PROFIT DEDUCTED"; sign = ""; }

                        // NEW TYPES
                        else if (row.type === 'admin_bal_adj') {
                            icon = "💎";
                            title = "ADMIN BALANCE ADJ";
                            sign = row.amount > 0 ? "+" : "";
                        }
                        else if (row.type === 'admin_transfer') {
                            icon = "💸";
                            title = "ADMIN TRANSFER";
                            sign = "+";
                        }

                        let adminTag = row.admin_name || 'System';
                        if (row.admin_tg && String(row.admin_tg) === String(bankAdminId)) adminTag += " (🏦 Bank)";

                        const amountStr = `${sign}${row.amount}`;

                        logMsg += `${icon} **${title}** \`(${timeStr})\`\n`;
                        logMsg += `├ 💰 Amount: **${amountStr}**\n`;
                        if (row.target_name) logMsg += `├ 👤 Target/Player: ${row.target_name}\n`;
                        logMsg += `└ 👮 Admin/Sender: ${adminTag}\n\n`;
                    });

                    if (logMsg.length > 4000) {
                        const chunks = logMsg.match(/.{1,4000}/g);
                        chunks.forEach(chunk => bot.sendMessage(chatId, chunk, { parse_mode: "Markdown" }));
                    } else {
                        bot.sendMessage(chatId, logMsg, { parse_mode: "Markdown" });
                    }
                }
            }
            return;
        }

        if (text === "💎 Manage Admin Balances") {
            if (await isSuperAdmin(tgId)) {
                chatStates[chatId] = { step: 'awaiting_adm_bal_search' };
                bot.sendMessage(chatId, "💎 **Manage Admin Balances**\n\n👇 Send the **Username** of the Admin you want to manage:", { parse_mode: "Markdown", reply_markup: { force_reply: true } });
            }
            return;
        }

        if (text === "📢 Broadcast Group Link" || text.startsWith('/broadcast_link')) {
            if (await isAdmin(msg.from.id)) {
                const groupRes = await db.query("SELECT value FROM system_settings WHERE key = 'group_link'");
                const url = groupRes.rows[0]?.value;
                if (!url) return bot.sendMessage(chatId, "❌ No group link set. Use 'Set Group Link' first.");

                bot.sendMessage(chatId, `📢 Broadcasting group link to users...`);

                const fancyMsg = `👋 **Hello Bingo Players!**\n**ሰላም የቢንጎ ተጫዋቾች!**\n\n` +
                    `🔥 The game is happening NOW!\n` +
                    `🔥 ጨዋታው እየተካሄደ ነው!\n\n` +
                    `👇 **JOIN THE GROUP BELOW / ግሩፑን ይቀላቀሉ:**`;

                const opts = {
                    parse_mode: "Markdown",
                    reply_markup: { inline_keyboard: [[{ text: "📢 JOIN GROUP", url: url }]] }
                };

                await broadcastToAllUsers(fancyMsg, opts);
                bot.sendMessage(chatId, `✅ Sent.`);
            }
            return;
        }

        const mainMenuButtons = ["🚀 Play", "💰 My Points", "🌟 Buy Premium", "🏦 Deposit", "💸 Transfer", "🏧 Withdraw", "🆘 Help", "🔄 Reset", "✏️ Edit Name", "ℹ️ Guide", "🗑️ Delete User", "🔧 SMS & Webhook", "📱 App Link", "📢 Announce Game Day", "✏️ Edit User", "👥 View Admins", "🕹 Active Games", "💰 End Day Report"];
        if (mainMenuButtons.some(btn => text.startsWith(btn))) {
            if (chatStates[chatId]) delete chatStates[chatId];
        }

        const user = await getUser(msg.from.id);
        const userIsAdmin = await isAdmin(msg.from.id);
        const userIsSuperAdmin = await isSuperAdmin(msg.from.id);

        if (text.startsWith("🚀 Play")) {
            if (user) triggerStart(chatId, user);
            else bot.sendMessage(chatId, "⚠️ **Link Account First**", { reply_markup: shareContactKeyboard, parse_mode: "Markdown" });
            return;
        }

        if (text.startsWith("💰 My Points")) {
            if (user) {
                let premStatus = "Inactive";
                if (user.premium_expires_at) {
                    const exp = dayjs(user.premium_expires_at);
                    if (exp.isAfter(dayjs())) premStatus = `Active until ${exp.format('DD/MM/YYYY')}`;
                }
                bot.sendMessage(chatId, `💰 Points: *${user.points}*\n🌟 Premium: ${premStatus}`, { parse_mode: "Markdown" }).catch(() => { });
            }
            return;
        }

        if (text.startsWith("🌟 Buy Premium")) {
            bot.sendMessage(chatId, `🌟 *Premium Packages*\n👇 *Select Duration:*`, { parse_mode: "Markdown", reply_markup: premiumPackages }).catch(() => { });
            return;
        }

        if (text.startsWith("🏦 Deposit")) {
            if (!user) return;
            const bankRes = await db.query("SELECT value FROM system_settings WHERE key = 'bank_details'");
            chatStates[chatId] = { step: 'awaiting_deposit_amount' };
            bot.sendMessage(chatId, `🏦 *Bank Info*\n${bankRes.rows[0]?.value || 'Contact Admin'}\n\n👇 *Enter Amount:*`, { parse_mode: "Markdown", reply_markup: { force_reply: true } });
            return;
        }

        if (text.startsWith("💸 Transfer")) {
            chatStates[chatId] = { step: 'awaiting_transfer_username' };
            bot.sendMessage(chatId, "💸 **Transfer**\nEnter receiver username:", { reply_markup: { force_reply: true } }).catch(() => { });
            return;
        }

        if (text.startsWith("🏧 Withdraw")) {
            if (!user) return;
            chatStates[chatId] = { step: 'awaiting_withdraw_amount', user: user };
            bot.sendMessage(chatId, `🏧 *Withdraw*\nBalance: ${user.points}\nMin Withdrawal: 50\n\nEnter amount:`, { parse_mode: "Markdown", reply_markup: { force_reply: true } }).catch(() => { });
            return;
        }

        if (text.startsWith("✏️ Edit Name")) {
            if (!user) return;
            chatStates[chatId] = { step: 'awaiting_new_username' };
            bot.sendMessage(chatId, "✏️ **Change Username**\n\nEnter your new username:", { parse_mode: "Markdown", reply_markup: { force_reply: true } });
            return;
        }

        if (text.startsWith("ℹ️ Guide") || text.startsWith("🆘 Help")) {
            const guideMsg = `ℹ️ **BINGO BOT USER GUIDE / የተጠቃሚ መመሪያ**\n\n` +
                `🚀 **Play / ይጫወቱ:**\n` +
                `Generates a link to open the Bingo Game App.\n` +
                `ወደ ቢንጎ ጨዋታው መግቢያ ሊንክ ይልካል።\n\n` +
                `💰 **My Points / ነጥቦቼ:**\n` +
                `Check your current balance and premium status.\n` +
                `ያለዎትን ነጥብ እና የፕሪሚየም ሁኔታ ያሳያል።\n\n` +
                `🏦 **Deposit / ገቢ አድርግ:**\n` +
                `Add money to your account via Telebirr/CBE.\n` +
                `በቴሌብር ወይም ባንክ አካውንትዎ ላይ ገንዘብ (ነጥብ) ለመሙላት።\n\n` +
                `💸 **Transfer / አስተላልፍ:**\n` +
                `Send points to another player instantly.\n` +
                `ለሌላ ተጫዋች ነጥብ ለማስተላለፍ።\n\n` +
                `🏧 **Withdraw / ወጪ አድርግ:**\n` +
                `Request to cash out your points.\n` +
                `ነጥብዎን ወደ ገንዘብ ቀይረው ለማውጣት።\n\n` +
                `✏️ **Edit Name / ስም ቀይር:**\n` +
                `Change your display name.\n` +
                `በጨዋታው ላይ የሚታየውን ስምዎን ለመቀየር።\n\n` +
                `🌟 **Buy Premium / ፕሪሚየም ይግዙ:**\n` +
                `Enable Auto-Daub & Auto-Bingo.\n` +
                `ካርዶ ትክክለኛ ቁጥር ሲጠራ እራሱ እንዲመርጥ እና ቢንጎ እንዲል (Auto-Play)።`;
            bot.sendMessage(chatId, guideMsg, { parse_mode: "Markdown" });
            return;
        }

        if (text.startsWith("🔄 Reset")) {
            delete chatStates[chatId];
            let keyboard = userKeyboard;
            if (await isSuperAdmin(tgId)) {
                keyboard = superAdminKeyboard;
            } else if (await isAdmin(tgId)) {
                keyboard = adminKeyboard;
            }
            bot.sendMessage(chatId, "🔄 Cancelled.", { reply_markup: keyboard }).catch(() => { });
            return;
        }

        if (userIsAdmin) {
            if (text.startsWith("🆕 New Game")) {
                const pendingGames = await db.query("SELECT id FROM games WHERE status = 'pending'");
                if (pendingGames.rows.length > 0) {
                    return bot.sendMessage(chatId, `⚠️ **Game #${pendingGames.rows[0].id} is already pending!**\n\nYou must START or ABORT it before creating a new one.`, { parse_mode: "Markdown" });
                }

                chatStates[chatId] = { step: 'awaiting_pattern' };
                const patternKeyboard = {
                    inline_keyboard: [
                        [{ text: "Any Line", callback_data: "rule_any_line" }, { text: "2 Lines", callback_data: "rule_two_lines" }],
                        [{ text: "X Shape", callback_data: "rule_x_shape" }, { text: "L Shape", callback_data: "rule_l_shape" }],
                        [{ text: "Corners", callback_data: "rule_corners" }, { text: "Full House", callback_data: "rule_full_house" }],
                        [{ text: "Plus", callback_data: "rule_plus_sign" }, { text: "U Shape", callback_data: "rule_u_shape" }],
                        [{ text: "Frame", callback_data: "rule_frame" }, { text: "H Shape", callback_data: "rule_letter_h" }],
                        [{ text: "T Shape", callback_data: "rule_letter_t" }]
                    ]
                };
                return bot.sendMessage(chatId, "🎮 *Select Rule:*", { parse_mode: "Markdown", reply_markup: patternKeyboard });
            }
            if (text === "🕹 Active Games") {
                const pendingGames = await db.query("SELECT * FROM games WHERE status = 'pending' ORDER BY id DESC");
                if (pendingGames.rows.length === 0) {
                    bot.sendMessage(chatId, "⚠️ **No pending games found.**", { parse_mode: "Markdown" });
                } else {
                    for (const g of pendingGames.rows) {
                        const creator = g.created_by || "Unknown";
                        const dashMsg = `🎮 *Game #${g.daily_id} Pending*\nBet: ${g.bet_amount}\nOpened by: ${creator}\n\n👇 *Management Panel:*`;
                        const kb = { inline_keyboard: [[{ text: "🔄 Refresh", callback_data: `gm_refresh_${g.id}` }], [{ text: "▶️ START", callback_data: `gm_pre_${g.id}` }], [{ text: "🛑 ABORT", callback_data: `gm_abort_${g.id}` }]] };
                        await bot.sendMessage(chatId, dashMsg, { parse_mode: "Markdown", reply_markup: kb });
                    }
                }
                return;
            }
            if (text.startsWith("📝 Register")) {
                chatStates[chatId] = { step: 'awaiting_register_phone' };
                return bot.sendMessage(chatId, "📝 *New Player*\n\nEnter Phone Number:", { parse_mode: "Markdown" }).catch(() => { });
            }
            if (text.startsWith("📝 Bulk Register")) {
                chatStates[chatId] = { step: 'awaiting_bulk_register' };
                return bot.sendMessage(chatId, "📝 *Bulk Registration*\nSend list (Phone Username):", { parse_mode: "Markdown" }).catch(() => { });
            }
            if (text.startsWith("📈 Global Stats")) {
                try {
                    const userCountRes = await db.query("SELECT COUNT(*) as count FROM users");
                    const totalUsers = userCountRes.rows[0].count;

                    const payoutRes = await db.query("SELECT COALESCE(SUM(pot), 0) as total_payouts, COUNT(*) as count FROM games WHERE status = 'finished'");
                    const totalGames = payoutRes.rows[0].count;
                    const totalPayouts = parseInt(payoutRes.rows[0].total_payouts);

                    const revenueRes = await db.query(`
                    SELECT COALESCE(SUM(g.bet_amount), 0) as total_revenue
                    FROM games g
                    JOIN player_cards pc ON g.id = pc.game_id
                    WHERE g.status = 'finished'
                `);
                    const totalRevenue = parseInt(revenueRes.rows[0].total_revenue);
                    const totalProfit = totalRevenue - totalPayouts;

                    // NEW: Weekly & Monthly
                    const weekRes = await db.query(`
                        SELECT COALESCE(SUM(g.bet_amount), 0) - COALESCE(SUM(g.pot), 0) as profit
                        FROM games g 
                        join player_cards pc on g.id = pc.game_id
                        WHERE g.status = 'finished' AND g.created_at > NOW() - INTERVAL '7 days'
                    `);
                    const weekProfit = parseInt(weekRes.rows[0]?.profit || 0);

                    const monthRes = await db.query(`
                        SELECT COALESCE(SUM(g.bet_amount), 0) - COALESCE(SUM(g.pot), 0) as profit
                        FROM games g 
                        join player_cards pc on g.id = pc.game_id
                        WHERE g.status = 'finished' AND g.created_at > NOW() - INTERVAL '30 days'
                    `);
                    const monthProfit = parseInt(monthRes.rows[0]?.profit || 0);

                    const report = `📈 *GLOBAL STATISTICS*\n\n` +
                        `👥 Total Players: ${totalUsers}\n` +
                        `🎮 Total Games: ${totalGames}\n` +
                        `💰 Total Revenue: ${totalRevenue}\n` +
                        `🏆 Total Payouts: ${totalPayouts}\n` +
                        `💵 Net Profit: ${totalProfit}\n\n` +
                        `📅 *Period Stats:*\n` +
                        `🔹 Weekly Profit: ${weekProfit}\n` +
                        `🔹 Monthly Profit: ${monthProfit}`;

                    bot.sendMessage(chatId, report, { parse_mode: "Markdown" }).catch(() => { });
                } catch (e) { console.error(e); }
                return;
            }
            if (text.startsWith("📊 Daily Stats")) {
                try {
                    const payoutRes = await db.query(`
                    SELECT COUNT(*) as count, COALESCE(SUM(pot), 0) as total_payouts
                    FROM games
                    WHERE status = 'finished' AND created_at::date = CURRENT_DATE
                 `);
                    const count = payoutRes.rows[0].count;
                    const totalPayouts = parseInt(payoutRes.rows[0].total_payouts);

                    const revenueRes = await db.query(`
                    SELECT COALESCE(SUM(g.bet_amount), 0) as total_revenue
                    FROM games g
                    JOIN player_cards pc ON g.id = pc.game_id
                    WHERE g.status = 'finished' AND g.created_at::date = CURRENT_DATE
                 `);
                    const totalRevenue = parseInt(revenueRes.rows[0].total_revenue);
                    const profit = totalRevenue - totalPayouts;

                    bot.sendMessage(chatId, `📊 *Daily Stats*\n\nGames: ${count}\nRevenue: ${totalRevenue}\nPayouts: ${totalPayouts}\nNet Profit: ${profit}`, { parse_mode: "Markdown" }).catch(() => { });
                } catch (e) { console.error(e); }
                return;
            }

            // --- NEW FEATURE: END DAY REPORT ---
            if (text === "💰 End Day Report") {
                try {
                    const payoutRes = await db.query(`
                    SELECT COUNT(*) as count, COALESCE(SUM(pot), 0) as total_payouts
                    FROM games
                    WHERE status = 'finished' AND created_at::date = CURRENT_DATE
                 `);
                    const totalPayouts = parseInt(payoutRes.rows[0].total_payouts);

                    const revenueRes = await db.query(`
                    SELECT COALESCE(SUM(g.bet_amount), 0) as total_revenue
                    FROM games g
                    JOIN player_cards pc ON g.id = pc.game_id
                    WHERE g.status = 'finished' AND g.created_at::date = CURRENT_DATE
                 `);
                    const totalRevenue = parseInt(revenueRes.rows[0].total_revenue);
                    const netProfit = totalRevenue - totalPayouts;

                    // 40% - 30% - 30% Logic
                    const share40 = Math.floor(netProfit * 0.40);
                    const share30 = Math.floor(netProfit * 0.30);

                    // Save to DB (Upsert)
                    await db.query(`
                    INSERT INTO daily_reports (date, total_revenue, total_payout, net_profit, system_share, admin_shares) 
                    VALUES (CURRENT_DATE, $1, $2, $3, $4, $5)
                    ON CONFLICT (date) DO UPDATE SET 
                        total_revenue = EXCLUDED.total_revenue,
                        total_payout = EXCLUDED.total_payout,
                        net_profit = EXCLUDED.net_profit
                 `, [totalRevenue, totalPayouts, netProfit, share40, JSON.stringify({ admin1: share30, admin2: share30 })]);

                    const msg = `📊 **DAILY NET PROFIT REPORT** 📊\n\n` +
                        `💰 **Total Revenue:** ${totalRevenue}\n` +
                        `💸 **Total Payouts:** ${totalPayouts}\n` +
                        `-----------------------------\n` +
                        `📈 **NET PROFIT:** ${netProfit}\n\n` +
                        `**Profit Distribution:**\n` +
                        `🔹 System (40%): ${share40}\n` +
                        `🔹 Admin 1 (30%): ${share30}\n` +
                        `🔹 Admin 2 (30%): ${share30}\n\n` +
                        `✅ *Saved to Database.*`;

                    const opts = {
                        parse_mode: "Markdown",
                        reply_markup: {
                            inline_keyboard: [
                                [{ text: "🛑 ANNOUNCE END OF DAY & CLOSE", callback_data: "end_day_broadcast" }]
                            ]
                        }
                    };

                    bot.sendMessage(chatId, msg, opts);
                } catch (e) { console.error(e); }
                return;
            }

            if (text.startsWith("🏦 Set Bank")) {
                chatStates[chatId] = { step: 'awaiting_bank_update' };
                return bot.sendMessage(chatId, "Enter new Bank Details:").catch(() => { });
            }
            if (text.startsWith("📢 Set Group Link")) {
                chatStates[chatId] = { step: 'awaiting_group_link' };
                return bot.sendMessage(chatId, "1. Send **Group ID** (starts with -100):", { parse_mode: "Markdown" });
            }
            if (text.startsWith("➕ Add Points")) {
                chatStates[chatId] = { step: 'awaiting_add_username' };
                return bot.sendMessage(chatId, "➕ *Add Points*\nEnter username:", { parse_mode: "Markdown" }).catch(() => { });
            }
            if (text.startsWith("➕ Bulk Add")) {
                chatStates[chatId] = { step: 'awaiting_bulk_usernames' };
                return bot.sendMessage(chatId, "➕ *Bulk Add*\nUsernames (comma separated):", { parse_mode: "Markdown" }).catch(() => { });
            }
            if (text.startsWith("➖ Remove Points")) {
                chatStates[chatId] = { step: 'awaiting_remove_username' };
                return bot.sendMessage(chatId, "➖ *Remove Points*\nEnter username:", { parse_mode: "Markdown" }).catch(() => { });
            }
            if (text.startsWith("🗑️ Delete User")) {
                chatStates[chatId] = { step: 'awaiting_delete_username' };
                return bot.sendMessage(chatId, "🗑️ **Delete User**\n\nEnter the username to delete (This will remove all their data!):", { parse_mode: "Markdown" });
            }
            if (text.startsWith("⚠️ Reset All Points")) {
                chatStates[chatId] = { step: 'awaiting_reset_confirm' };
                return bot.sendMessage(chatId, "⚠️ **DANGER ZONE** ⚠️\n\nThis will set ALL players' points to 0.\nAre you sure?\n\nType **CONFIRM** to proceed.", { parse_mode: "Markdown" });
            }
            if (text.startsWith("🔧 SMS & Webhook")) {
                const smsHelp = `🔧 **Download SMS Forwarder App**\n\n` +
                    `👇 **Click link below to download:**\n` +
                    `[Download App](https://drive.google.com/file/d/1kTwutp_QggHMg-3gvZuxrHEoy7gobRQr/view?usp=drive_link)\n\n` +
                    `🔗 **Your Webhook URL:**\n` +
                    `\`${publicUrl}/api/sms-webhook\``;
                return bot.sendMessage(chatId, smsHelp, { parse_mode: "Markdown", disable_web_page_preview: true });
            }
            if (text.startsWith("📱 App Link")) {
                if (!publicUrl) return bot.sendMessage(chatId, "❌ Public URL not set in .env");
                return bot.sendMessage(chatId, `📱 **Bingo App Link:**\n${publicUrl}\n\n_Click to open or copy._`, { parse_mode: "Markdown" });
            }
            if (text.startsWith("📜 Players")) {
                try {
                    const res = await db.query("SELECT username, points, phone_number FROM users ORDER BY created_at DESC LIMIT 200");

                    let msg = "📜 All Players List\n\n";
                    if (res.rows.length === 0) msg += "No players found.";

                    const chunks = [];
                    let currentChunk = msg;

                    res.rows.forEach((u, i) => {
                        const line = `${i + 1}. ${u.username} (${u.phone_number || 'No Phone'}): ${u.points}\n`;
                        if ((currentChunk + line).length > 4000) {
                            chunks.push(currentChunk);
                            currentChunk = line;
                        } else {
                            currentChunk += line;
                        }
                    });
                    chunks.push(currentChunk);

                    for (const chunk of chunks) {
                        await bot.sendMessage(chatId, chunk).catch((e) => { console.error("Player List Send Error:", e); });
                    }
                } catch (e) { console.error(e); }
                return;
            }
            if (text.startsWith("📋 Transactions")) {
                try {
                    const res = await db.query(`
                    SELECT t.*, u.username as user_name
                    FROM transactions t
                    LEFT JOIN users u ON t.user_id = u.id
                    ORDER BY t.created_at DESC LIMIT 15
                `);

                    let msg = "📋 *Last 15 Transactions*\n\n";
                    if (res.rows.length === 0) msg += "No transactions found.";

                    res.rows.forEach(t => {
                        const date = dayjs(t.created_at).format('MM/DD HH:mm');
                        let desc = t.description || 'N/A';
                        const safeUser = escapeMarkdown(t.user_name || 'Unknown');
                        const safeType = escapeMarkdown(t.type);
                        const safeDesc = escapeMarkdown(desc);

                        msg += `🔹 ${date} - *${safeUser}*\n   ${safeType}: ${t.amount} (${safeDesc})\n`;
                    });
                    bot.sendMessage(chatId, msg, { parse_mode: "Markdown" }).catch(e => console.error("Tx Send Error:", e));
                } catch (e) { console.error("Tx Query Error:", e); }
                return;
            }
        }

        if (userIsSuperAdmin) {
            if (text.startsWith("💸 Admin Transfer")) {
                chatStates[chatId] = { step: 'awaiting_adm_transfer_search' };
                return bot.sendMessage(chatId, "💸 *Admin to Admin Transfer*\n\nEnter the username of the Admin you are sending money to:", { parse_mode: "Markdown", reply_markup: { force_reply: true } });
            }
            if (text.startsWith("👑 Promote Admin")) {
                chatStates[chatId] = { step: 'awaiting_promote_username' };
                return bot.sendMessage(chatId, "👑 *Promote to Admin*\nEnter username to promote:", { parse_mode: "Markdown" }).catch(() => { });
            }
            if (text.startsWith("🔻 Demote Admin")) {
                chatStates[chatId] = { step: 'awaiting_demote_username' };
                return bot.sendMessage(chatId, "🔻 *Demote Admin*\nEnter username to remove admin rights:", { parse_mode: "Markdown" }).catch(() => { });
            }
        }

        if (chatStates[chatId]) {
            const state = chatStates[chatId];
            try {
                if (state.step === 'awaiting_register_phone') {
                    state.regPhone = cleanPhone(text);
                    state.step = 'awaiting_register_username';
                    bot.sendMessage(chatId, "👤 *Enter Username:*", { parse_mode: "Markdown" }).catch(() => { });
                }
                else if (state.step === 'awaiting_register_username') {
                    const { user, created, error } = await registerUserByPhone(state.regPhone, text.trim());
                    delete chatStates[chatId];
                    if (error) {
                        bot.sendMessage(chatId, `❌ ${error}`).catch(() => { });
                    } else {
                        const groupRes = await db.query("SELECT value FROM system_settings WHERE key = 'group_link'");
                        const groupUrl = groupRes.rows[0]?.value;
                        const opts = { parse_mode: "Markdown" };
                        if (groupUrl) opts.reply_markup = { inline_keyboard: [[{ text: "📢 Join Group", url: groupUrl }]] };

                        bot.sendMessage(chatId, `✅ *Registered!*\nUser: ${escapeMarkdown(user.username)}`, opts).catch(() => { });
                        bot.sendMessage(chatId, `📩 *Forward this to the player:*`, { parse_mode: "Markdown" }).catch(() => { });
                        bot.sendMessage(chatId, getInviteText(), { parse_mode: "Markdown" }).catch(() => { });
                    }
                }
                else if (state.step === 'awaiting_bulk_register') {
                    const lines = text.split('\n');
                    let successCount = 0;
                    for (const line of lines) {
                        const parts = line.trim().split(/\s+/);
                        if (parts.length >= 2) {
                            await registerUserByPhone(cleanPhone(parts[0]), parts.slice(1).join(' '));
                            successCount++;
                        }
                    }
                    delete chatStates[chatId];
                    bot.sendMessage(chatId, `✅ Processed ${successCount} users.`).catch(() => { });
                    bot.sendMessage(chatId, `📩 *Forward this invite to all of them:*`, { parse_mode: "Markdown" }).catch(() => { });
                    bot.sendMessage(chatId, getInviteText(), { parse_mode: "Markdown" }).catch(() => { });
                }
                else if (state.step === 'awaiting_initial_username') {
                    const username = text.trim();
                    if (username.length < 3) return bot.sendMessage(chatId, "❌ Username too short (min 3 chars).");

                    const result = await linkTelegramAccount(state.regPhone, tgId, username);
                    delete chatStates[chatId];

                    if (result.error) {
                        bot.sendMessage(chatId, `❌ **Error:** ${result.error}\n\nTry /start again.`, { reply_markup: userKeyboard });
                    } else {
                        // JOIN GROUP BUTTON
                        const groupRes = await db.query("SELECT value FROM system_settings WHERE key = 'group_link'");
                        const groupUrl = groupRes.rows[0]?.value;
                        const opts = { parse_mode: "Markdown" };
                        if (groupUrl) opts.reply_markup = { inline_keyboard: [[{ text: "📢 Join Group", url: groupUrl }]] };

                        if (await isAdmin(tgId) || await isSuperAdmin(tgId)) {
                            const kb = (await isSuperAdmin(tgId)) ? superAdminKeyboard : adminKeyboard;
                            bot.sendMessage(chatId, `✅ **Admin Account Linked!**\nRegistered as: ${result.user.username}`, { ...opts, reply_markup: kb });
                        } else {
                            bot.sendMessage(chatId, `✅ **Registered!**\nWelcome, ${result.user.username}!`, { ...opts, reply_markup: userKeyboard });
                        }
                        triggerStart(chatId, result.user);
                    }
                }
                else if (state.step === 'awaiting_deposit_amount') {
                    const amount = parseInt(text);
                    if (isNaN(amount) || amount <= 0) return bot.sendMessage(chatId, "❌ Invalid amount.").catch(() => { });
                    state.amount = amount;
                    state.step = 'awaiting_deposit_proof';
                    bot.sendMessage(chatId, `📸 **Send Screenshot** or Reply with Transaction ID:`);
                }
                else if (state.step === 'awaiting_deposit_proof') {
                    const txnCode = text.trim();
                    const txnRes = await db.query("SELECT * FROM bank_transactions WHERE txn_code = $1", [txnCode]);
                    if (txnRes.rows.length > 0 && txnRes.rows[0].status !== 'claimed') {
                        const actualAmount = txnRes.rows[0].amount;
                        await db.query("UPDATE users SET points = points + $1 WHERE id = $2", [actualAmount, user.id]);
                        await db.query("UPDATE bank_transactions SET status = 'claimed', claimed_by = $1 WHERE id = $2", [user.id, txnRes.rows[0].id]);
                        bot.sendMessage(chatId, `✅ **Instant Success!** +${actualAmount} pts.`, { reply_markup: userKeyboard });
                        delete chatStates[chatId];
                    } else {
                        bot.sendMessage(chatId, "❌ txn not found or claimed. Upload photo instead?");
                    }
                }
                else if (state.step === 'awaiting_withdraw_amount') {
                    const amount = parseInt(text);
                    const user = await getUser(tgId);
                    if (isNaN(amount) || amount <= 0) return bot.sendMessage(chatId, "❌ Invalid Amount.").catch(() => { });
                    if (amount < 50) return bot.sendMessage(chatId, "❌ Minimum withdrawal is 50 Points.").catch(() => { });
                    if (user.points < amount) {
                        delete chatStates[chatId];
                        return bot.sendMessage(chatId, "❌ Insufficient Funds.", { reply_markup: userKeyboard }).catch(() => { });
                    }
                    state.withdrawAmount = amount;
                    state.step = 'awaiting_bank_details';
                    bot.sendMessage(chatId, "🏦 *Bank Info*\nBank, Account, Name:", { parse_mode: "Markdown" }).catch(() => { });
                }
                else if (state.step === 'awaiting_bank_details') {
                    const amount = state.withdrawAmount;
                    const user = await getUser(tgId);

                    // 1. Subtract points
                    await db.query("UPDATE users SET points = points - $1 WHERE id = $2", [amount, user.id]);

                    // 2. Create the Request Record
                    const wdRes = await db.query(
                        "INSERT INTO withdrawal_requests (user_id, telegram_id, amount, bank_details, status) VALUES ($1, $2, $3, $4, 'pending') RETURNING id",
                        [user.id, tgId, amount, text]
                    );
                    const wdId = wdRes.rows[0].id;

                    delete chatStates[chatId];
                    bot.sendMessage(chatId, "✅ **Request Sent**", { reply_markup: userKeyboard }).catch(() => { });

                    const safeUser = escapeMarkdown(user.username);
                    const safeInfo = escapeMarkdown(text);
                    const adminMsg = `🚨 *Withdrawal Request #${wdId}*\nUser: ${safeUser}\nAmt: ${amount}\nInfo: ${safeInfo}`;

                    // 3. Find Admin with Highest Balance (Smart Routing)
                    const richAdminRes = await db.query("SELECT telegram_id, admin_balance FROM users WHERE role IN ('admin', 'super_admin') AND telegram_id IS NOT NULL ORDER BY admin_balance DESC LIMIT 1");
                    let targetAdminId = null;

                    if (richAdminRes.rows.length > 0) {
                        targetAdminId = richAdminRes.rows[0].telegram_id;
                        console.log(`Routing Withdrawal #${wdId} to Admin ${targetAdminId} (Bal: ${richAdminRes.rows[0].admin_balance})`);
                    }

                    const markup = { inline_keyboard: [[{ text: "Approve", callback_data: `wd_approve_${wdId}_${amount}` }], [{ text: "Reject", callback_data: `wd_reject_${wdId}_${amount}` }]] };

                    // 4. Send primarily to Richest Admin, but maybe broadcast if urgent?
                    // Plan: Send to Richest. If he doesn't answer... (complexity).
                    // For now, let's Stick to our Plan: "Send to the admin that have the higher balance".

                    let msgIds = {};
                    if (targetAdminId) {
                        try {
                            const m = await bot.sendMessage(targetAdminId, adminMsg, { parse_mode: "Markdown", reply_markup: markup });
                            msgIds[targetAdminId] = m.message_id;
                        } catch (e) { console.error("Failed to send to rich admin", e); }
                    } else {
                        // Fallback to all admins if no balance info OR Super Admin fallback
                        // Only if NO rich admin found, which shouldn't happen unless 0 admins.
                        msgIds = await broadcastToAdmins(adminMsg, { parse_mode: "Markdown", reply_markup: markup });
                    }

                    // 5. Update the request with message IDs for sync
                    await db.query("UPDATE withdrawal_requests SET admin_msg_ids = $1 WHERE id = $2", [JSON.stringify(msgIds), wdId]);
                }
                else if (state.step === 'awaiting_transfer_username') {
                    const res = await db.query("SELECT * FROM users WHERE LOWER(username) = LOWER($1)", [text.trim()]);
                    if (res.rows.length === 0) return bot.sendMessage(chatId, "❌ User not found.").catch(() => { });
                    state.targetUser = res.rows[0];
                    state.step = 'awaiting_transfer_amount';
                    bot.sendMessage(chatId, `Enter amount for ${state.targetUser.username}:`).catch(() => { });
                }
                else if (state.step === 'awaiting_transfer_amount') {
                    const amount = parseInt(text);
                    const user = await getUser(tgId); // Sender
                    if (user.points < amount) return bot.sendMessage(chatId, "❌ Not enough points.").catch(() => { });

                    await db.query("UPDATE users SET points = points - $1 WHERE telegram_id = $2", [amount, tgId]);
                    await db.query("UPDATE users SET points = points + $1 WHERE id = $2", [amount, state.targetUser.id]);

                    await db.logTransaction(user.id, 'transfer_out', -amount, state.targetUser.id, null, `Transfer to ${state.targetUser.username}`);
                    await db.logTransaction(state.targetUser.id, 'transfer_in', amount, user.id, null, `Transfer from ${user.username}`);

                    delete chatStates[chatId];
                    bot.sendMessage(chatId, "✅ *Sent!*", { reply_markup: userKeyboard, parse_mode: "Markdown" }).catch(() => { });

                    if (state.targetUser.telegram_id) {
                        bot.sendMessage(state.targetUser.telegram_id, `💰 *Received ${amount} Points from ${escapeMarkdown(user.username)}!*\n\nገቢ: ${amount} ነጥብ ከ ${user.username}`, { parse_mode: "Markdown" }).catch(() => { });
                    }
                }
                else if (state.step === 'awaiting_start_seconds') {
                    const seconds = parseInt(text);
                    if (isNaN(seconds) || seconds < 0) return bot.sendMessage(chatId, "❌ Invalid Time.").catch(() => { });
                    startGameLogic(state.gameId, io, null, seconds);
                    bot.sendMessage(chatId, `🚀 *Game #${state.dailyId || state.gameId} Starting in ${seconds}s!*`, { parse_mode: "Markdown" }).catch(() => { });
                    delete chatStates[chatId];
                }
                else if (state.step === 'awaiting_bet') {
                    const betAmount = parseInt(text);
                    if (isNaN(betAmount) || betAmount <= 0) return bot.sendMessage(chatId, "❌ Invalid Bet.").catch(() => { });
                    state.betAmount = betAmount;
                    const pattern = state.pattern || 'any_line';
                    const countRes = await db.query("SELECT COUNT(*) FROM games WHERE created_at::date = CURRENT_DATE");
                    const dailyId = parseInt(countRes.rows[0].count) + 1;

                    // Track who opened it (Added creator_id: tgId)
                    const res = await db.query('INSERT INTO games (bet_amount, status, pot, winning_pattern, daily_id, created_by, creator_id) VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING *', [betAmount, 'pending', 0, pattern, dailyId, user.username, tgId]);
                    const gameId = res.rows[0].id;

                    io.emit('gameStateUpdate', { status: 'pending', gameId, displayId: dailyId, betAmount: betAmount, pot: 0, calledNumbers: [], pattern });

                    const groupRes = await db.query("SELECT value FROM system_settings WHERE key = 'group_chat_id'");
                    const groupChatId = groupRes.rows[0]?.value;
                    const inviteLink = `https://t.me/${botUsername}?start=bingo`;

                    const safePattern = pattern.replace(/_/g, ' ').toUpperCase();

                    // GROUP MESSAGE
                    const inviteMsg = `📢 **Bingo Game #${dailyId} Open!**\n\n` +
                        `Bet: ${betAmount} Points\n` +
                        `Rule: ${safePattern}\n\n` +
                        `⚠️ **Deposit money to get points!**\n` +
                        `⚠️ **ነጥብ ለማግኘት ብር ያስገቡ!**\n\n` +
                        `🆕 **New Game Created! Join Now!**`;

                    // Send URL as button
                    const groupOpts = {
                        parse_mode: "Markdown",
                        reply_markup: {
                            inline_keyboard: [[{ text: "👇 JOIN HERE / ተቀላቀል 👇", url: inviteLink }]]
                        }
                    };

                    // Removed strict check on ID format to allow flexibility
                    if (groupChatId) {
                        bot.sendMessage(groupChatId, inviteMsg, groupOpts).catch(e => console.error("Group Send Error:", e.message));
                    }

                    // ADMIN MESSAGE: Shows "Opened by: [Username]"
                    const dashMsg = `🎮 *Game #${dailyId} Pending*\nBet: ${betAmount}\nOpened by: ${user.username}\n\n👇 *Wait for players then Start:*`;
                    const kb = { inline_keyboard: [[{ text: "🔄 Refresh", callback_data: `gm_refresh_${gameId}` }], [{ text: "▶️ START", callback_data: `gm_pre_${gameId}` }], [{ text: "🛑 Abort", callback_data: `gm_abort_${gameId}` }]] };

                    bot.sendMessage(chatId, dashMsg, { parse_mode: "Markdown", reply_markup: kb }).catch(() => { });
                    delete chatStates[chatId];
                }

                else if (state.step === 'awaiting_group_link') {
                    if (text.startsWith("-")) {
                        await db.query("INSERT INTO system_settings (key, value) VALUES ('group_chat_id', $1) ON CONFLICT (key) DO UPDATE SET value = $1", [text.trim()]);
                        state.step = 'awaiting_group_url';
                        bot.sendMessage(chatId, "✅ Group ID Set!\n\nNow send the **Invite Link** (https://t.me/...) for the join button:");
                    } else {
                        bot.sendMessage(chatId, "❌ Invalid ID. It must start with - (e.g. -100123456). Try again:");
                    }
                }
                else if (state.step === 'awaiting_group_url') {
                    if (text.startsWith("http") || text.startsWith("t.me")) {
                        await db.query("INSERT INTO system_settings (key, value) VALUES ('group_link', $1) ON CONFLICT (key) DO UPDATE SET value = $1", [text.trim()]);
                        bot.sendMessage(chatId, "✅ Group Link Set! Full configuration complete.", { reply_markup: adminKeyboard });
                        delete chatStates[chatId];
                    } else {
                        bot.sendMessage(chatId, "❌ Invalid Link. Must start with http or t.me.");
                    }
                }

                else if (state.step === 'awaiting_bank_update') {
                    await db.query("INSERT INTO system_settings (key, value) VALUES ('bank_details', $1) ON CONFLICT (key) DO UPDATE SET value = $1", [text]);

                    // SAVE ADMIN ID AS BANK ADMIN
                    await db.query("INSERT INTO system_settings (key, value) VALUES ('bank_admin_id', $1) ON CONFLICT (key) DO UPDATE SET value = $1", [String(tgId)]);

                    delete chatStates[chatId];
                    bot.sendMessage(chatId, "✅ Bank Details Updated!", { reply_markup: adminKeyboard }).catch(() => { });

                    // NEW: Broadcast Bank Update
                    await broadcastToAllUsers(`📢 **BANK UPDATE / የባንክ ሂሳብ ዝርዝር**\n\n${text}\n\n⚠️ Please use this new account for deposits!`, { parse_mode: "Markdown" });
                }
                else if (state.step === 'awaiting_add_username') { state.username = text.trim(); state.step = 'awaiting_add_amount'; bot.sendMessage(chatId, "Amount:").catch(() => { }); }
                else if (state.step === 'awaiting_add_amount') {
                    const amount = parseInt(text);
                    const targetRes = await db.query("SELECT id, username FROM users WHERE LOWER(username) = LOWER($1)", [state.username]);
                    if (targetRes.rows.length > 0) {
                        const targetUser = targetRes.rows[0];
                        await db.query("UPDATE users SET points = points + $1 WHERE id = $2", [amount, targetUser.id]);

                        // NEW: Update Admin Balance (Liability) because they (presumably) took cash
                        await db.query("UPDATE users SET admin_balance = admin_balance + $1 WHERE id = $2", [amount, user.id]);
                        const updatedAdmin = await db.query("SELECT admin_balance FROM users WHERE id = $1", [user.id]);
                        const newBal = updatedAdmin.rows[0].admin_balance;

                        await db.logTransaction(targetUser.id, 'admin_add', amount, null, null, 'Added by Admin', user.id);

                        bot.sendMessage(chatId, `✅ Added ${amount} points to ${targetUser.username}.\n💼 Your New Balance: ${newBal}`).catch(() => { });

                        // NEW: Notify Super Admins
                        const superAdmins = await db.query("SELECT telegram_id FROM users WHERE role = 'super_admin'");
                        superAdmins.rows.forEach(sa => {
                            if (sa.telegram_id) {
                                bot.sendMessage(sa.telegram_id, `🔔 **Admin Action Alert**\n\n👤 Admin: **${user.username}**\n➕ Added: ${amount} Points\nTo: ${targetUser.username}\n💼 New Admin Bal: ${newBal}`, { parse_mode: "Markdown" }).catch(() => { });
                            }
                        });

                    } else {
                        bot.sendMessage(chatId, "❌ User not found.").catch(() => { });
                    }
                    delete chatStates[chatId];
                }
                else if (state.step === 'awaiting_bulk_usernames') { state.usernames = text.split(',').map(u => u.trim()); state.step = 'awaiting_bulk_amount'; bot.sendMessage(chatId, "Amount per user:").catch(() => { }); }
                else if (state.step === 'awaiting_bulk_amount') {
                    const amt = parseInt(text);
                    for (const u of state.usernames) {
                        const targetRes = await db.query("SELECT id FROM users WHERE LOWER(username) = LOWER($1)", [u]);
                        if (targetRes.rows.length > 0) {
                            await db.query("UPDATE users SET points = points + $1 WHERE LOWER(username) = LOWER($2)", [amt, u]);
                            await db.logTransaction(targetRes.rows[0].id, 'admin_add', amt, null, null, 'Bulk Add by Admin', user.id);
                        }
                    }
                    delete chatStates[chatId];
                    bot.sendMessage(chatId, "✅ Done.", { reply_markup: adminKeyboard }).catch(() => { });
                }
                else if (state.step === 'awaiting_remove_username') { state.username = text.trim(); state.step = 'awaiting_remove_amount'; bot.sendMessage(chatId, "Amount to remove:").catch(() => { }); }
                else if (state.step === 'awaiting_remove_amount') {
                    const amount = parseInt(text);
                    const targetRes = await db.query("SELECT id FROM users WHERE LOWER(username) = LOWER($1)", [state.username]);
                    if (targetRes.rows.length > 0) {
                        await db.query("UPDATE users SET points = points - $1 WHERE LOWER(username) = LOWER($2)", [amount, state.username]);

                        // DEDUCT FROM ADMIN BALANCE ALSO (They took the points back = cash back to them)
                        // User Request: "When the admin removes points, it must be deducted from their balance also"
                        await db.query("UPDATE users SET admin_balance = COALESCE(admin_balance, 0) - $1 WHERE id = $2", [amount, user.id]);

                        await db.logTransaction(targetRes.rows[0].id, 'admin_remove', -amount, null, null, 'Removed by Admin', user.id);
                        bot.sendMessage(chatId, `✅ Removed ${amount} points.\nDeducted from your Admin Balance.`).catch(() => { });
                    }
                    delete chatStates[chatId];
                }
                else if (state.step === 'awaiting_custom_prize') {
                    const amount = parseInt(text);
                    if (isNaN(amount) || amount <= 0) {
                        return bot.sendMessage(chatId, "❌ Invalid amount. Please enter a number.").catch(() => { });
                    }
                    if (state.max && amount > state.max) {
                        return bot.sendMessage(chatId, `❌ Invalid amount. Max is ${state.max}`).catch(() => { });
                    }
                    await db.query("UPDATE games SET pot = $1 WHERE id = $2", [amount, state.gameId]);
                    chatStates[chatId] = { step: 'awaiting_start_seconds', gameId: state.gameId, dailyId: state.dailyId };
                    bot.sendMessage(chatId, `✅ *Custom Prize set to ${amount}*\n\n⏱ Enter countdown seconds to START (e.g., 10):`, { parse_mode: "Markdown" }).catch(() => { });
                }

                else if (state.step === 'awaiting_new_username') {
                    const newName = text.trim();
                    if (newName.length < 3) return bot.sendMessage(chatId, "❌ Username too short.");

                    const check = await db.query("SELECT id FROM users WHERE LOWER(username) = LOWER($1)", [newName]);
                    if (check.rows.length > 0) return bot.sendMessage(chatId, "❌ Username already taken.");

                    await db.query("UPDATE users SET username = $1 WHERE id = $2", [newName, user.id]);
                    delete chatStates[chatId];
                    bot.sendMessage(chatId, `✅ Username changed to **${newName}**!`, { parse_mode: "Markdown", reply_markup: userKeyboard });
                }

                // --- SUPER ADMIN STATE HANDLERS ---
                else if (state.step === 'awaiting_edit_search') {
                    const query = text.trim();
                    const res = await db.query("SELECT * FROM users WHERE phone_number = $1 OR LOWER(username) = LOWER($1)", [query]);

                    if (res.rows.length === 0) {
                        bot.sendMessage(chatId, "❌ User not found.");
                        delete chatStates[chatId];
                    } else {
                        const targetUser = res.rows[0];
                        state.targetUserId = targetUser.id;
                        state.step = 'awaiting_edit_newname';
                        bot.sendMessage(chatId, `👤 Found: **${targetUser.username}**\nPhone: ${targetUser.phone_number}\nPoints: ${targetUser.points}\n\n👇 **Enter New Username:**`, { parse_mode: "Markdown", reply_markup: { force_reply: true } });
                    }
                }
                else if (state.step === 'awaiting_edit_newname') {
                    const newName = text.trim();
                    if (newName.length < 3) {
                        bot.sendMessage(chatId, "❌ Username too short.");
                    } else {
                        const check = await db.query("SELECT id FROM users WHERE LOWER(username) = LOWER($1)", [newName]);
                        if (check.rows.length > 0) {
                            bot.sendMessage(chatId, "❌ Username already taken.");
                        } else {
                            await db.query("UPDATE users SET username = $1 WHERE id = $2", [newName, state.targetUserId]);
                            bot.sendMessage(chatId, `✅ Username updated to **${newName}**!`, { parse_mode: "Markdown" });
                        }
                    }
                    delete chatStates[chatId];
                }

                // --- MANAGE ADMIN BALANCE HANDLERS ---
                else if (state.step === 'awaiting_adm_bal_search') {
                    const query = text.trim();
                    const res = await db.query("SELECT * FROM users WHERE LOWER(username) = LOWER($1) AND role IN ('admin', 'super_admin')", [query]);
                    if (res.rows.length === 0) {
                        bot.sendMessage(chatId, "❌ Admin not found.");
                        delete chatStates[chatId];
                    } else {
                        state.targetAdmin = res.rows[0];
                        state.step = 'awaiting_adm_bal_action';
                        bot.sendMessage(chatId, `👤 **Admin Found:** ${state.targetAdmin.username}\n💼 **Current Balance:** ${state.targetAdmin.admin_balance || 0}\n\n👇 **Choose Action:**`, {
                            parse_mode: "Markdown",
                            reply_markup: {
                                inline_keyboard: [
                                    [{ text: "➕ Add Balance", callback_data: "adm_bal_add" }],
                                    [{ text: "➖ Remove Balance", callback_data: "adm_bal_remove" }]
                                ]
                            }
                        });
                    }
                }
                else if (state.step === 'awaiting_adm_bal_final') {
                    const amount = parseInt(text);
                    if (isNaN(amount) || amount <= 0) {
                        bot.sendMessage(chatId, "❌ Invalid Amount.");
                    } else {
                        const targetId = state.targetAdmin.id;
                        const action = state.actionType; // 'add' or 'remove'

                        if (action === 'add') {
                            await db.query("UPDATE users SET admin_balance = COALESCE(admin_balance, 0) + $1 WHERE id = $2", [amount, targetId]);
                            await db.logTransaction(targetId, 'admin_bal_adj', amount, null, null, `SuperAdmin Added Balance`, user.id);
                            bot.sendMessage(chatId, `✅ **Added ${amount}** to ${state.targetAdmin.username}'s balance.`);
                            if (state.targetAdmin.telegram_id) bot.sendMessage(state.targetAdmin.telegram_id, `💎 **Super Admin Added Balance**\n➕ ${amount} added.`);
                        } else {
                            await db.query("UPDATE users SET admin_balance = COALESCE(admin_balance, 0) - $1 WHERE id = $2", [amount, targetId]);
                            await db.logTransaction(targetId, 'admin_bal_adj', -amount, null, null, `SuperAdmin Removed Balance`, user.id);
                            bot.sendMessage(chatId, `✅ **Removed ${amount}** from ${state.targetAdmin.username}'s balance.`);
                            if (state.targetAdmin.telegram_id) bot.sendMessage(state.targetAdmin.telegram_id, `💎 **Super Admin Removed Balance**\n➖ ${amount} deducted.`);
                        }
                    }
                    delete chatStates[chatId];
                }

                else if (state.step === 'awaiting_delete_username') {
                    const targetUser = text.trim();
                    const uRes = await db.query("SELECT id, username FROM users WHERE LOWER(username) = LOWER($1)", [targetUser]);

                    if (uRes.rows.length === 0) {
                        bot.sendMessage(chatId, "❌ User not found.");
                    } else {
                        const uid = uRes.rows[0].id;
                        await db.query("DELETE FROM player_cards WHERE user_id = $1", [uid]);
                        await db.query("DELETE FROM deposits WHERE user_id = $1", [uid]);
                        await db.query("DELETE FROM transactions WHERE user_id = $1 OR related_user_id = $1", [uid]);
                        await db.query("UPDATE games SET winner_id = NULL WHERE winner_id = $1", [uid]);

                        await db.query("DELETE FROM users WHERE id = $1", [uid]);
                        bot.sendMessage(chatId, `🗑️ **${uRes.rows[0].username}** has been permanently deleted.`, { parse_mode: "Markdown" });
                    }
                    delete chatStates[chatId];
                }

                else if (state.step === 'awaiting_reset_confirm') {
                    if (text.toUpperCase() === 'CONFIRM') {
                        await db.query("INSERT INTO transactions (type, amount, description) VALUES ('system_reset', 0, 'RESET ALL POINTS BY ADMIN')");
                        await db.query("UPDATE users SET points = 0 WHERE role = 'player'");
                        bot.sendMessage(chatId, "✅ **RESET COMPLETE.** All players now have 0 points.", { parse_mode: "Markdown", reply_markup: adminKeyboard });
                    } else {
                        bot.sendMessage(chatId, "❌ Reset Cancelled.", { reply_markup: adminKeyboard });
                    }
                    delete chatStates[chatId];
                }

                else if (state.step === 'awaiting_promote_username') {
                    const targetUsername = text.trim();
                    const userRes = await db.query("SELECT * FROM users WHERE LOWER(username) = LOWER($1)", [targetUsername]);
                    if (userRes.rows.length === 0) {
                        bot.sendMessage(chatId, "❌ User not found.");
                    } else {
                        const user = userRes.rows[0];
                        await db.query("UPDATE users SET role = 'admin' WHERE id = $1", [user.id]);
                        bot.sendMessage(chatId, `✅ **${user.username}** promoted to Admin!`);
                        if (user.telegram_id) bot.sendMessage(user.telegram_id, "👑 You have been promoted to Admin!", { reply_markup: adminKeyboard });
                    }
                    delete chatStates[chatId];
                }
                else if (state.step === 'awaiting_demote_username') {
                    const targetUsername = text.trim();
                    const userRes = await db.query("SELECT * FROM users WHERE LOWER(username) = LOWER($1)", [targetUsername]);
                    if (userRes.rows.length === 0) {
                        bot.sendMessage(chatId, "❌ User not found.");
                    } else {
                        const user = userRes.rows[0];
                        await db.query("UPDATE users SET role = 'player' WHERE id = $1", [user.id]);
                        bot.sendMessage(chatId, `🔻 **${user.username}** demoted to Player.`);
                        if (user.telegram_id) bot.sendMessage(user.telegram_id, "ℹ️ You have been removed from Admin role.", { reply_markup: userKeyboard });
                    }
                    delete chatStates[chatId];
                }

                // --- ADMIN TRANSFER FLOW ---
                else if (state.step === 'awaiting_adm_transfer_search') {
                    const targetUsername = text.trim();
                    const res = await db.query("SELECT * FROM users WHERE LOWER(username) = LOWER($1) AND role IN ('admin', 'super_admin')", [targetUsername]);
                    if (res.rows.length === 0) {
                        bot.sendMessage(chatId, "❌ Admin not found.");
                        delete chatStates[chatId];
                    } else {
                        state.targetAdmin = res.rows[0];
                        state.step = 'awaiting_adm_transfer_amount';
                        bot.sendMessage(chatId, `✅ Found Admin: **${res.rows[0].username}**\n\n👇 Enter Amount to Transfer:`, { parse_mode: "Markdown" });
                    }
                }
                else if (state.step === 'awaiting_adm_transfer_amount') {
                    const amount = parseInt(text);
                    if (isNaN(amount) || amount <= 0) return bot.sendMessage(chatId, "❌ Invalid Amount.");

                    const senderRes = await db.query("SELECT admin_balance FROM users WHERE id = $1", [user.id]);
                    const currentBal = senderRes.rows[0].admin_balance || 0;

                    // Allow negative balance? Usually no, but for flexible admin ops maybe? Let's enforce 0 for now.
                    if (currentBal < amount) return bot.sendMessage(chatId, `❌ Insufficient Admin Balance. You have ${currentBal}.`);

                    // Create Transfer Record
                    const trRes = await db.query("INSERT INTO admin_transfers (from_admin_id, to_admin_id, amount, status) VALUES ($1, $2, $3, 'pending') RETURNING id", [user.id, state.targetAdmin.id, amount]);
                    const trId = trRes.rows[0].id;

                    // Send confirmation to Target Admin
                    if (state.targetAdmin.telegram_id) {
                        const kb = { inline_keyboard: [[{ text: "✅ Confirm Receipt", callback_data: `adm_confirm_${trId}` }]] };
                        bot.sendMessage(state.targetAdmin.telegram_id, `💸 **Incoming Admin Transfer!**\n\nFrom: ${user.username}\nAmount: ${amount}\n\nPlease confirm when you receive the funds (e.g. via Telebirr).`, { parse_mode: "Markdown", reply_markup: kb });
                    }

                    bot.sendMessage(chatId, `✅ **Request Sent!**\nWaiting for ${state.targetAdmin.username} to confirm receipt.`);
                    delete chatStates[chatId];
                }
            } catch (err) { console.error(err); delete chatStates[chatId]; bot.sendMessage(chatId, "❌ Error.").catch(() => { }); }
        }
    });

    return bot;
};

module.exports = { startBot };