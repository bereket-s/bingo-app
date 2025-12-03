const TelegramBot = require('node-telegram-bot-api');
const { getUser, registerUserByPhone, linkTelegramAccount, setGameEndCallback } = require('./gameManager'); 
const db = require('./db'); 
const dayjs = require('dayjs');

let io;
const chatStates = {};
let botUsername = "BingoBot";

const cleanPhone = (p) => p ? p.replace(/\D/g, '') : '';

// Helper to prevent Telegram Markdown errors
const escapeMarkdown = (text) => {
    if (!text) return '';
    return String(text).replace(/[_*[\]()`]/g, '\\$&');
};

const startBot = (database, socketIo, startGameLogic) => {
  io = socketIo;

  const token = process.env.TELEGRAM_TOKEN;
  // Parse Admins: Ensure IDs are numbers. The FIRST one is Super Admin.
  const adminIds = (process.env.ADMIN_TELEGRAM_ID || '')
      .split(',')
      .map(id => parseInt(id.trim(), 10))
      .filter(id => !isNaN(id));

  const superAdminId = adminIds.length > 0 ? adminIds[0] : null;
  const publicUrl = process.env.PUBLIC_URL;

  // Check if user is admin (Env list OR Database role)
  const isAdmin = async (id) => {
      if (adminIds.includes(id)) return true;
      const res = await db.query("SELECT role FROM users WHERE telegram_id = $1", [id]);
      return res.rows.length > 0 && (res.rows[0].role === 'admin' || res.rows[0].role === 'super_admin');
  };

  // Check if user is SUPER admin
  const isSuperAdmin = async (id) => {
      if (id === superAdminId) return true;
      const res = await db.query("SELECT role FROM users WHERE telegram_id = $1", [id]);
      return res.rows.length > 0 && res.rows[0].role === 'super_admin';
  };

  if (!token) {
      console.error("❌ TELEGRAM_TOKEN is missing in .env!");
      return;
  }
  
  const bot = new TelegramBot(token, { polling: true });
  
  bot.getMe().then((me) => {
      botUsername = me.username;
      console.log(`🤖 Telegram Bot initialized: @${botUsername}`);
      console.log(`👑 Super Admin ID: ${superAdminId}`);
  });

  // --- KEYBOARDS ---
  const adminKeyboard = {
      keyboard: [
          [{ text: "🚀 Play / ይጫወቱ" }, { text: "🆕 New Game / አዲስ ጨዋታ" }],
          [{ text: "📝 Register / መዝግብ" }, { text: "🗑️ Delete User / አስወግድ" }], // New Delete Button
          [{ text: "📝 Bulk Register" }, { text: "📜 Players / ተጫዋቾች" }],
          [{ text: "🏦 Set Bank / ባንክ አስገባ" }, { text: "📈 Global Stats" }],
          [{ text: "➕ Add Points" }, { text: "➖ Remove Points" }],
          [{ text: "📋 Transactions" }, { text: "🔄 Reset" }]
      ],
      resize_keyboard: true,
      persistent: true
  };

  const superAdminKeyboard = {
      keyboard: [
          ...adminKeyboard.keyboard, 
          [{ text: "👑 Promote Admin" }, { text: "🔻 Demote Admin" }] 
      ],
      resize_keyboard: true,
      persistent: true
  };

  const userKeyboard = {
      keyboard: [
          [{ text: "🚀 Play Bingo / ጨዋታውን ጀምር" }],
          [{ text: "💰 My Points / ነጥቦቼ" }, { text: "🏦 Deposit / ገቢ አድርግ" }],
          [{ text: "💸 Transfer / አስተላልፍ" }, { text: "🏧 Withdraw / ወጪ አድርግ" }],
          [{ text: "✏️ Edit Name / ስም ቀይር" }, { text: "ℹ️ About / ስለ ቦቱ" }], // New User Buttons
          [{ text: "🌟 Buy Premium / ፕሪሚየም ይግዙ" }, { text: "🆘 Help / እርዳታ" }]
      ],
      resize_keyboard: true,
      persistent: true
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

  // --- GAME END CALLBACK ---
  setGameEndCallback((gameId, winnerText) => {
      const safeWinner = escapeMarkdown(winnerText);
      const msg = `🏁 *GAME #${gameId} FINISHED!* / *ጨዋታ #${gameId} ተጠናቀቀ!*\n\n` +
                  `🏆 Winner: ${safeWinner}\n` +
                  `🏆 አሸናፊ: ${safeWinner}\n\n` +
                  `👇 *Admin Menu Restored:*`;
      broadcastToAdmins(msg, { parse_mode: "Markdown" });
  });

  // --- HELPERS ---
  const broadcastToAdmins = async (text, options = {}) => {
      const envAdmins = adminIds;
      let dbAdmins = [];
      try {
          const res = await db.query("SELECT telegram_id FROM users WHERE role IN ('admin', 'super_admin')");
          dbAdmins = res.rows.map(r => parseInt(r.telegram_id)).filter(id => !isNaN(id));
      } catch (e) { console.error("DB Admin Fetch Error", e); }

      const allAdmins = [...new Set([...envAdmins, ...dbAdmins])];
      
      for (const id of allAdmins) {
          let opts = { ...options };
          if (!opts.reply_markup) {
             if (await isSuperAdmin(id)) {
                 opts.reply_markup = superAdminKeyboard;
             } else {
                 opts.reply_markup = adminKeyboard;
             }
          }
          bot.sendMessage(id, text, opts).catch((e) => {});
      }
  };

  const forwardPhotoToAdmins = async (fileId, caption, replyMarkup) => {
      const envAdmins = adminIds;
      let dbAdmins = [];
      try {
          const res = await db.query("SELECT telegram_id FROM users WHERE role IN ('admin', 'super_admin')");
          dbAdmins = res.rows.map(r => parseInt(r.telegram_id)).filter(id => !isNaN(id));
      } catch (e) { console.error("DB Admin Fetch Error", e); }
      
      const allAdmins = [...new Set([...envAdmins, ...dbAdmins])];

      allAdmins.forEach(id => bot.sendPhoto(id, fileId, { caption, parse_mode: "Markdown", reply_markup: replyMarkup }).catch((e) => {}));
  };

  const getInviteText = () => {
      return `👋 **Bingo Game Invite / የቢንጎ ጨዋታ ግብዣ**\n\n` +
             `You are invited to play Bingo! Follow these steps:\n` +
             `ቢንጎ እንዲጫወቱ ተጋብዘዋል! ለመጀመር እነዚህን ደረጃዎች ይከተሉ:\n\n` +
             `1️⃣ Click this link / ይህንን ሊንክ ይጫኑ:\n` +
             `👉 https://t.me/${botUsername}?start=bingo\n\n` +
             `2️⃣ Press **START** at the bottom / ከታች **START** የሚለውን ይንኩ።\n\n` +
             `3️⃣ Press **📱 Share Contact** / **📱 ስልክ ቁጥር ላክ** የሚለውን ይጫኑ።`;
  };

  const triggerStart = async (chatId, user) => {
      if (!publicUrl) {
          bot.sendMessage(chatId, "❌ **System Error:** PUBLIC_URL is missing in settings.\nPlease contact Admin to fix the server.");
          console.error("❌ Missing PUBLIC_URL in .env");
          return;
      }

      try {
        const token = require('crypto').randomUUID();
        await db.query('UPDATE users SET session_token = $1 WHERE id = $2', [token, user.id]);
        const url = `${publicUrl}?user_id=${user.id}&token=${token}`;
        
        const options = {
            parse_mode: "Markdown",
            reply_markup: {
                inline_keyboard: [[{ text: "🚀 Open Game / ጨዋታውን ክፈት", web_app: { url: url } }]]
            }
        };
        
        const msg = `👋 **Welcome ${user.username}! / እንኳን ደህና መጡ!**\n\n` + 
                    `To play, click the button below:\n` + 
                    `ጨዋታውን ለመጀመር ይህንን ይጫኑ:\n\n` + 
                    `👇👇👇`;
        
        bot.sendMessage(chatId, msg, options).catch(e => console.error("Msg Error:", e.message));
      } catch(e) { console.error("Start Error", e); }
  };

  // --- START COMMAND ---
  bot.onText(/\/start/, async (msg) => {
    const chatId = msg.chat.id;
    const tgId = msg.from.id;

    if (await isSuperAdmin(tgId)) {
         bot.sendMessage(chatId, "👑 *Super Admin Panel*", { parse_mode: "Markdown", reply_markup: superAdminKeyboard }).catch(()=>{});
    } else if (await isAdmin(tgId)) {
        bot.sendMessage(chatId, "👑 *Admin Panel / አስተዳዳሪ*", { parse_mode: "Markdown", reply_markup: adminKeyboard }).catch(()=>{});
    } else {
        try {
            const user = await getUser(tgId);
            if (!user) {
                const welcomeMsg = `👋 **Welcome / እንኳን ደህና መጡ!**\n\n` +
                                   `To play Bingo, we need to register you.\n` +
                                   `ቢንጎ ለመጫወት መመዝገብ ያስፈልጋል።\n\n` +
                                   `👇 **Press the button below:**\n` +
                                   `👇 **ከታች ያለውን ቁልፍ ይጫኑ:**`;
                bot.sendMessage(chatId, welcomeMsg, { reply_markup: shareContactKeyboard }).catch(()=>{});
            } else {
                bot.sendMessage(chatId, `Welcome back, ${user.username}!`, { reply_markup: userKeyboard }).catch(()=>{});
            }
        } catch (err) { console.error(err); }
    }
  });

  // --- PHOTO HANDLER ---
  bot.on('photo', async (msg) => {
    const chatId = msg.chat.id;
    const tgId = msg.from.id;
    const state = chatStates[chatId];
    
    if (!state) return;

    if (state.step === 'awaiting_deposit_proof' || state.step === 'awaiting_premium_proof') {
        const photo = msg.photo[msg.photo.length - 1]; 
        const fileId = photo.file_id;
        const user = await getUser(tgId);

        if (!user) {
            bot.sendMessage(chatId, "❌ User not found. Type /start.");
            delete chatStates[chatId];
            return;
        }

        let amount = 0;
        let type = 'points';
        let duration = null;

        if (state.step === 'awaiting_deposit_proof') {
            amount = state.amount;
        } else {
            type = 'premium';
            duration = state.duration;
            amount = 0;
        }

        try {
            const res = await db.query(
                "INSERT INTO deposits (user_id, telegram_id, amount, proof_image_id, status, request_type, package_duration) VALUES ($1, $2, $3, $4, 'pending', $5, $6) RETURNING id",
                [user.id, tgId, amount, fileId, type, duration]
            );
            const depId = res.rows[0].id;

            bot.sendMessage(chatId, "✅ *Proof Received!*\nSent to admins for approval.", { parse_mode: "Markdown", reply_markup: userKeyboard });
            
            let caption = "";
            let callbackPrefix = "";
            const safeUser = escapeMarkdown(user.username);
            
            if (type === 'points') {
                caption = `💰 *New Deposit*\nUser: ${safeUser}\nAmount: ${amount}\n\n👇 Approve/Reject:`;
                callbackPrefix = "dep";
            } else {
                caption = `🌟 *New Premium Request*\nUser: ${safeUser}\nDuration: ${duration}\n\n👇 Approve/Reject:`;
                callbackPrefix = "prem";
            }

            const markup = {
                inline_keyboard: [
                    [{ text: "✅ Approve", callback_data: `${callbackPrefix}_approve_${depId}_${amount}` }],
                    [{ text: "❌ Reject", callback_data: `${callbackPrefix}_reject_${depId}_${amount}` }]
                ]
            };
            
            forwardPhotoToAdmins(fileId, caption, markup);
            delete chatStates[chatId];

        } catch (e) {
            console.error("Deposit Error:", e);
            bot.sendMessage(chatId, "❌ Database Error.");
        }
    }
  });

  // --- CONTACT SHARED (REGISTRATION) ---
  bot.on('contact', async (msg) => {
    const tgId = msg.from.id;
    const username = msg.contact.first_name || 'Player';
    const phone = cleanPhone(msg.contact.phone_number);
    const chatId = msg.chat.id;
    if (msg.contact.user_id !== tgId) return;
    
    try {
        const result = await linkTelegramAccount(phone, tgId, username);
        if (result.error) {
             bot.sendMessage(chatId, `❌ **Error:** ${result.error}`, { reply_markup: userKeyboard }).catch(()=>{});
        } else {
             // IF USER IS ADMIN, GIVE ADMIN KEYBOARD
             if (await isAdmin(tgId) || await isSuperAdmin(tgId)) {
                 const kb = (await isSuperAdmin(tgId)) ? superAdminKeyboard : adminKeyboard;
                 bot.sendMessage(chatId, `✅ **Admin Account Linked!**\nRegistered as: ${result.user.username}`, { reply_markup: kb, parse_mode: "Markdown" }).catch(()=>{});
             } else {
                 bot.sendMessage(chatId, `✅ **Registered: ${result.user.username}!**`, { reply_markup: userKeyboard, parse_mode: "Markdown" }).catch(()=>{});
             }
             triggerStart(chatId, result.user);
        }
    } catch (err) { console.error(err); }
  });

  // --- CALLBACK QUERY HANDLER ---
  bot.on('callback_query', async (cq) => {
    const action = cq.data;
    const msg = cq.message;
    const chatId = msg.chat.id;
    const adminUser = await getUser(cq.from.id);

    try {
        if (action.startsWith('pkg_')) {
            const duration = action.replace('pkg_', '');
            chatStates[chatId] = { step: 'awaiting_premium_proof', duration: duration };
            
            const bankRes = await db.query("SELECT value FROM system_settings WHERE key = 'bank_details'");
            const bankInfo = bankRes.rows.length ? bankRes.rows[0].value : "Contact Admin.";

            bot.sendMessage(chatId, `💎 *Selected: ${duration.toUpperCase()}*\n\nPay via:\n${bankInfo}\n\n👇 *Send Payment Screenshot Now:*`, { parse_mode: "Markdown" }).catch(()=>{});
            return;
        }

        if (action.startsWith('rule_')) {
            const pattern = action.replace('rule_', '');
            if (!chatStates[chatId] || chatStates[chatId].step !== 'awaiting_pattern') return;
            
            chatStates[chatId].pattern = pattern;
            chatStates[chatId].step = 'awaiting_bet';
            
            bot.sendMessage(chatId, `✅ Rule Selected. Now enter bet amount (e.g., 50):`, { parse_mode: "Markdown" }).catch(()=>{});
            return;
        }

        if (action.startsWith('gm_')) {
            const parts = action.split('_');
            const cmd = parts[1];
            const gameId = parseInt(parts[2]);

            const countRes = await db.query("SELECT COUNT(DISTINCT user_id) as users, COUNT(*) as cards FROM player_cards WHERE game_id = $1", [gameId]);
            const stats = {
                users: countRes.rows.length ? (parseInt(countRes.rows[0].users) || 0) : 0,
                cards: countRes.rows.length ? (parseInt(countRes.rows[0].cards) || 0) : 0
            };
            
            const gameRes = await db.query("SELECT bet_amount, status, pot, winning_pattern FROM games WHERE id = $1", [gameId]);
            if (gameRes.rows.length === 0) return bot.answerCallbackQuery(cq.id, { text: "Game not found" });
            const betAmt = parseInt(gameRes.rows[0].bet_amount) || 0;
            const totalCollected = stats.cards * betAmt;

            if (cmd === 'refresh') {
                 if(gameRes.rows[0].status !== 'pending') return bot.answerCallbackQuery(cq.id, { text: "Game already started or finished!" });

                 const newText = `🎮 *Game #${gameId} Pending*\n\n👥 Players: ${stats.users}\n🎫 Cards Sold: ${stats.cards}\n💰 Total Pool: ${totalCollected}\n\nWaiting for start...`;
                 const kb = { inline_keyboard: [
                     [{ text: `🔄 Refresh (${stats.users})`, callback_data: `gm_refresh_${gameId}` }], 
                     [{ text: "▶️ START (Choose Prize)", callback_data: `gm_pre_${gameId}` }],
                     [{ text: "🛑 ABORT GAME", callback_data: `gm_abort_${gameId}` }]
                 ] };
                 
                 try {
                    await bot.editMessageText(newText, { chat_id: chatId, message_id: msg.message_id, parse_mode: "Markdown", reply_markup: kb });
                    const pattern = gameRes.rows[0].winning_pattern;
                    const inviteLink = `https://t.me/${botUsername}?start=bingo`;
                    const inviteMsg = `📢 **Game #${gameId} Open!**\nBet: ${betAmt}\nRule: ${pattern.replace('_', ' ').toUpperCase()}\n👉 [Join Game](${inviteLink})`;
                 } catch(e) { }
                 await bot.answerCallbackQuery(cq.id, { text: "Stats Refreshed!" });
            } 
            else if (cmd === 'pre') { 
                 if(gameRes.rows[0].status !== 'pending') return bot.answerCallbackQuery(cq.id, { text: "Already active!" });
                 
                 const text = `💰 *Set Prize for Game #${gameId}*\n\nTotal Collected: ${totalCollected}\n\nChoose option:`;
                 const kb = { inline_keyboard: [
                     [{ text: `Standard 70% (${Math.floor(totalCollected * 0.7)})`, callback_data: `gm_setprize_${gameId}_70` }],
                     [{ text: "✏️ Custom Amount", callback_data: `gm_setprize_${gameId}_custom` }]
                 ]};
                 
                 chatStates[chatId] = { ...chatStates[chatId], max: totalCollected, gameId: gameId };
                 
                 bot.sendMessage(chatId, text, { reply_markup: kb, parse_mode: "Markdown" }).catch(()=>{});
                 await bot.answerCallbackQuery(cq.id);
            }
            else if (cmd === 'setprize') {
                 const prizeType = parts[3]; 
                 if (prizeType === '70') {
                     const newPot = Math.floor(totalCollected * 0.7);
                     await db.query("UPDATE games SET pot = $1 WHERE id = $2", [newPot, gameId]);
                     
                     chatStates[chatId] = { step: 'awaiting_start_seconds', gameId: gameId };
                     bot.sendMessage(chatId, `✅ *Prize set to ${newPot}*\n\n⏱ Enter countdown seconds to START (e.g., 10):`, {parse_mode: "Markdown"}).catch(()=>{});
                 } else {
                     chatStates[chatId] = { step: 'awaiting_custom_prize', gameId: gameId, max: totalCollected };
                     bot.sendMessage(chatId, `✏️ *Enter Custom Prize Amount:*\n(Max available: ${totalCollected})`, {parse_mode: "Markdown"}).catch(()=>{});
                 }
                 await bot.answerCallbackQuery(cq.id);
            }
            else if (cmd === 'abort') {
                await db.query("UPDATE games SET status = 'aborted' WHERE id = $1", [gameId]);
                const players = await db.query("SELECT user_id FROM player_cards WHERE game_id = $1", [gameId]);
                for (let p of players.rows) {
                    await db.query("UPDATE users SET points = points + $1 WHERE id = $2", [betAmt, p.user_id]);
                    await db.logTransaction(p.user_id, 'game_refund', betAmt, null, gameId, `Refund for Game #${gameId}`);
                }
                bot.sendMessage(chatId, `🛑 *Game #${gameId} Aborted.*\nAll players refunded.`, { reply_markup: adminKeyboard, parse_mode: "Markdown" }).catch(()=>{});
                await bot.answerCallbackQuery(cq.id, { text: "Game Aborted" });
            }
            return;
        }

        // 4. APPROVALS
        if (action.startsWith('dep_') || action.startsWith('wd_') || action.startsWith('prem_')) {
            const parts = action.split('_'); 
            const type = parts[0]; 
            const decision = parts[1];
            const targetId = parseInt(parts[2]); 
            const val = parts[3]; 

            if (type === 'dep' || type === 'prem') {
                const depRes = await db.query("SELECT * FROM deposits WHERE id = $1", [targetId]);
                if (depRes.rows.length === 0 || depRes.rows[0].status !== 'pending') return bot.answerCallbackQuery(cq.id, {text: "Done already"});
                
                const deposit = depRes.rows[0];
                
                if (type === 'dep') {
                    if (decision === 'approve') {
                        await db.query("UPDATE deposits SET status = 'approved' WHERE id = $1", [targetId]);
                        await db.query("UPDATE users SET points = points + $1 WHERE id = $2", [parseInt(val), deposit.user_id]);
                        
                        await db.logTransaction(deposit.user_id, 'deposit', parseInt(val), null, null, `Deposit Approved by ${adminUser?.username}`);

                        try {
                            bot.editMessageCaption(`✅ *APPROVED*\n+${val} Points`, { chat_id: chatId, message_id: msg.message_id, parse_mode: "Markdown" });
                        } catch(e) { bot.sendMessage(chatId, `✅ Approved Deposit ${targetId}`).catch(()=>{}); }
                        
                        if (deposit.telegram_id) bot.sendMessage(deposit.telegram_id, `✅ *Deposit Accepted!*\n\n+${val} Points`, { parse_mode: "Markdown" }).catch(()=>{});
                    } else {
                        await db.query("UPDATE deposits SET status = 'rejected' WHERE id = $1", [targetId]);
                        try {
                            bot.editMessageCaption(`❌ *REJECTED*`, { chat_id: chatId, message_id: msg.message_id, parse_mode: "Markdown" });
                        } catch(e) { bot.sendMessage(chatId, `❌ Rejected Deposit ${targetId}`).catch(()=>{}); }
                        
                        if (deposit.telegram_id) bot.sendMessage(deposit.telegram_id, `❌ *Deposit Rejected*`, { parse_mode: "Markdown" }).catch(()=>{});
                    }
                }
                else if (type === 'prem') {
                    const duration = deposit.package_duration || '1m';
                    if (decision === 'approve') {
                        let months = 1;
                        if(duration === '3m') months = 3;
                        if(duration === '6m') months = 6;
                        if(duration === '1y') months = 12;
                        const expiry = dayjs().add(months, 'month').format();

                        await db.query("UPDATE deposits SET status = 'approved' WHERE id = $1", [targetId]);
                        await db.query("UPDATE users SET premium_expires_at = $1, pref_auto_daub = TRUE, pref_auto_bingo = TRUE WHERE id = $2", [expiry, deposit.user_id]);
                        
                        try {
                            bot.editMessageCaption(`✅ *PREMIUM (${duration.toUpperCase()}) APPROVED*`, { chat_id: chatId, message_id: msg.message_id, parse_mode: "Markdown" });
                        } catch(e) { bot.sendMessage(chatId, `✅ Approved Premium ${targetId}`).catch(()=>{}); }

                        if (deposit.telegram_id) bot.sendMessage(deposit.telegram_id, `🌟 *Premium Activated!*\nDuration: ${duration.toUpperCase()}`, { parse_mode: "Markdown" }).catch(()=>{});
                    } else {
                        await db.query("UPDATE deposits SET status = 'rejected' WHERE id = $1", [targetId]);
                        try {
                            bot.editMessageCaption(`❌ *PREMIUM REJECTED*`, { chat_id: chatId, message_id: msg.message_id, parse_mode: "Markdown" });
                        } catch(e) { bot.sendMessage(chatId, `❌ Rejected Premium ${targetId}`).catch(()=>{}); }

                        if (deposit.telegram_id) bot.sendMessage(deposit.telegram_id, `❌ *Premium Request Rejected*`, { parse_mode: "Markdown" }).catch(()=>{});
                    }
                }
            } 
            else if (type === 'wd') {
                if (decision === 'approve') {
                    await db.logTransaction(targetId, 'withdraw', -parseInt(val), null, null, `Withdrawal Approved by ${adminUser?.username}`);

                    try {
                        bot.editMessageText("✅ *PAID*", { chat_id: chatId, message_id: msg.message_id, parse_mode: "Markdown" });
                    } catch (e) { bot.sendMessage(chatId, `✅ Withdrawal Paid`).catch(()=>{}); }
                    
                    bot.sendMessage(targetId, `✅ *Withdrawal Sent!*\n\n${val} Points processed.`, { parse_mode: "Markdown" }).catch(()=>{});
                } else {
                    await db.query("UPDATE users SET points = points + $1 WHERE telegram_id = $2", [val, targetId]);
                    try {
                        bot.editMessageText("❌ *REFUNDED*", { chat_id: chatId, message_id: msg.message_id, parse_mode: "Markdown" });
                    } catch (e) { bot.sendMessage(chatId, `❌ Withdrawal Refunded`).catch(()=>{}); }

                    bot.sendMessage(targetId, `❌ *Withdrawal Failed*\nPoints refunded.`, { parse_mode: "Markdown" }).catch(()=>{});
                }
            }
        }
    } catch (err) {
        console.error("Callback Error:", err);
    }
  });

  // --- TEXT MESSAGE HANDLER ---
  bot.on('message', async (msg) => {
    const chatId = msg.chat.id;
    const text = msg.text;
    const tgId = msg.from.id;
    
    if (!text) return;

    // --- FIX: CANCEL STATE IF USER HITS A MENU BUTTON ---
    const mainMenuButtons = ["🚀 Play", "💰 My Points", "🌟 Buy Premium", "🏦 Deposit", "💸 Transfer", "🏧 Withdraw", "🆘 Help", "🔄 Reset", "✏️ Edit Name", "ℹ️ About", "🗑️ Delete User"];
    if (mainMenuButtons.some(btn => text.startsWith(btn))) {
        if (chatStates[chatId]) delete chatStates[chatId];
    }

    const user = await getUser(tgId);

    if (text.startsWith("🚀 Play")) {
        if (user) {
            triggerStart(chatId, user);
        } else {
            // FIX: EXPLICITLY HANDLE UNLINKED ADMINS
            bot.sendMessage(chatId, "⚠️ **Account Not Linked**\n\nYou are an Admin, but your Telegram account isn't linked to a player profile yet.\n\n👇 **Press the button below to link:**", { 
                reply_markup: shareContactKeyboard, 
                parse_mode: "Markdown" 
            });
        }
        return;
    }
    
    if (text.startsWith("💰 My Points")) {
        if (user) {
            let premStatus = "Inactive";
            if (user.premium_expires_at) {
                const exp = dayjs(user.premium_expires_at);
                if (exp.isAfter(dayjs())) premStatus = `Active until ${exp.format('DD/MM/YYYY')}`;
            }
            bot.sendMessage(chatId, `💰 Points: *${user.points}*\n🌟 Premium: ${premStatus}`, { parse_mode: "Markdown" }).catch(()=>{});
        }
        return;
    }

    if (text.startsWith("🌟 Buy Premium")) {
        bot.sendMessage(chatId, `🌟 *Premium Packages*\n👇 *Select Duration:*`, { parse_mode: "Markdown", reply_markup: premiumPackages }).catch(()=>{});
        return;
    }

    if (text.startsWith("🏦 Deposit")) {
        if(!user) return;
        const bankRes = await db.query("SELECT value FROM system_settings WHERE key = 'bank_details'");
        const bankInfo = bankRes.rows.length ? bankRes.rows[0].value : "No bank details set.";
        chatStates[chatId] = { step: 'awaiting_deposit_amount' };
        bot.sendMessage(chatId, `🏦 *Bank Details*\n\n${bankInfo}\n\n👇 *Enter Amount Transferred:*`, { parse_mode: "Markdown", reply_markup: { force_reply: true } }).catch(()=>{});
        return;
    }

    if (text.startsWith("💸 Transfer")) {
        chatStates[chatId] = { step: 'awaiting_transfer_username' };
        bot.sendMessage(chatId, "💸 **Transfer**\nEnter receiver username:", { reply_markup: { force_reply: true } }).catch(()=>{});
        return;
    }

    if (text.startsWith("🏧 Withdraw")) {
        if(!user) return;
        chatStates[chatId] = { step: 'awaiting_withdraw_amount', user: user };
        bot.sendMessage(chatId, `🏧 *Withdraw*\nBalance: ${user.points}\nMin Withdrawal: 50\n\nEnter amount:`, { parse_mode: "Markdown", reply_markup: { force_reply: true } }).catch(()=>{});
        return;
    }

    // --- NEW: Edit Name (Player) ---
    if (text.startsWith("✏️ Edit Name")) {
        if(!user) return;
        chatStates[chatId] = { step: 'awaiting_new_username' };
        bot.sendMessage(chatId, "✏️ **Change Username**\n\nEnter your new username:", { parse_mode: "Markdown", reply_markup: { force_reply: true } });
        return;
    }

    // --- NEW: About / Description ---
    if (text.startsWith("ℹ️ About") || text.startsWith("🆘 Help")) {
        const aboutMsg = `ℹ️ **About BingoBot**\n\n` +
                         `Welcome to the ultimate Bingo game!\n\n` +
                         `🎮 **How to Play:**\n` +
                         `1. Wait for Admin to start a game.\n` +
                         `2. Buy cards using your Points.\n` +
                         `3. Numbers will be called automatically.\n` +
                         `4. If you complete the pattern, press **BINGO!**\n\n` +
                         `💰 **Points:**\n` +
                         `- Deposit money to get points.\n` +
                         `- Win games to earn more points.\n` +
                         `- Withdraw points back to money.\n\n` +
                         `🇪🇹 **Amharic / አማርኛ:**\n` +
                         `ይህ የቢንጎ ጨዋታ ነው። አድሚኑ ጨዋታ ሲጀምር ካርድ ይግዙ። ቁጥሮች ሲጠሩ ይምረጡ። አሸናፊ ሲሆኑ **BINGO** ይበሉ!`;
        bot.sendMessage(chatId, aboutMsg, { parse_mode: "Markdown" });
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
        bot.sendMessage(chatId, "🔄 Cancelled.", { reply_markup: keyboard }).catch(()=>{});
        return;
    }

    // Check permissions for admin commands
    const userIsAdmin = await isAdmin(tgId);
    const userIsSuperAdmin = await isSuperAdmin(tgId);

    if (userIsAdmin) {
        if (text.startsWith("📝 Register")) {
             chatStates[chatId] = { step: 'awaiting_register_phone' };
             return bot.sendMessage(chatId, "📝 *New Player*\n\nEnter Phone Number:", { parse_mode: "Markdown" }).catch(()=>{});
        }
        if (text.startsWith("📝 Bulk Register")) {
            chatStates[chatId] = { step: 'awaiting_bulk_register' };
            return bot.sendMessage(chatId, "📝 *Bulk Registration*\nSend list (Phone Username):", { parse_mode: "Markdown" }).catch(()=>{});
        }
        if (text.startsWith("📈 Global Stats")) {
             try {
                const userCountRes = await db.query("SELECT COUNT(*) as count FROM users");
                const totalUsers = userCountRes.rows[0].count;
                
                const gameCountRes = await db.query("SELECT COUNT(*) as count, COALESCE(SUM(pot), 0) as total_pot FROM games WHERE status = 'finished'");
                const totalGames = gameCountRes.rows[0].count;
                const totalPot = parseInt(gameCountRes.rows[0].total_pot);
                const totalProfit = Math.floor(totalPot * 0.30); 

                const report = `📈 *GLOBAL STATISTICS*\n\n` +
                               `👥 Total Players: ${totalUsers}\n` +
                               `🎮 Total Games: ${totalGames}\n` +
                               `💰 Total Revenue: ${totalPot}\n` +
                               `💵 Total Profit (30%): ${totalProfit}`;

                bot.sendMessage(chatId, report, { parse_mode: "Markdown" }).catch(()=>{});
             } catch(e) { console.error(e); }
             return;
        }
        if (text.startsWith("📊 Daily Stats")) {
             try {
                 const statsRes = await db.query(`
                    SELECT COUNT(*) as count, COALESCE(SUM(pot), 0) as total_pot 
                    FROM games WHERE status = 'finished' AND created_at >= CURRENT_DATE
                 `);
                 const count = statsRes.rows[0].count;
                 const totalPot = parseInt(statsRes.rows[0].total_pot || 0);
                 const profit = Math.floor(totalPot * 0.30);

                 bot.sendMessage(chatId, `📊 *Daily Stats*\n\nGames: ${count}\nRevenue: ${totalPot}\nProfit: ${profit}`, { parse_mode: "Markdown" }).catch(()=>{});
             } catch(e) { console.error(e); }
             return;
        }
        if (text.startsWith("🆕 New Game")) {
            chatStates[chatId] = { step: 'awaiting_pattern' };
            const patternKeyboard = {
                inline_keyboard: [
                    [{ text: "Any Line (ማንኛውም)", callback_data: "rule_any_line" }, { text: "2 Lines (2 መስመር)", callback_data: "rule_two_lines" }],
                    [{ text: "❌ X Shape", callback_data: "rule_x_shape" }, { text: "╚ L Shape", callback_data: "rule_l_shape" }],
                    [{ text: "🔳 Corners", callback_data: "rule_corners" }, { text: "🔲 Frame", callback_data: "rule_frame" }],
                    [{ text: "H Shape", callback_data: "rule_letter_h" }, { text: "T Shape", callback_data: "rule_letter_t" }],
                    [{ text: "➕ Plus Sign", callback_data: "rule_plus_sign" }, { text: "⨆ U Shape", callback_data: "rule_u_shape" }],
                    [{ text: "⬛ Full House (Blackout)", callback_data: "rule_full_house" }]
                ]
            };
            return bot.sendMessage(chatId, "🎮 *Select Rule:*", { parse_mode: "Markdown", reply_markup: patternKeyboard }).catch(()=>{});
        }
        if (text.startsWith("🏦 Set Bank")) {
             chatStates[chatId] = { step: 'awaiting_bank_update' };
             return bot.sendMessage(chatId, "Enter new Bank Details:").catch(()=>{});
        }
        if (text.startsWith("➕ Add Points")) {
            chatStates[chatId] = { step: 'awaiting_add_username' };
            return bot.sendMessage(chatId, "➕ *Add Points*\nEnter username:", { parse_mode: "Markdown" }).catch(()=>{});
        }
        if (text.startsWith("➕ Bulk Add")) {
            chatStates[chatId] = { step: 'awaiting_bulk_usernames' };
            return bot.sendMessage(chatId, "➕ *Bulk Add*\nUsernames (comma separated):", { parse_mode: "Markdown" }).catch(()=>{});
        }
        if (text.startsWith("➖ Remove")) {
            chatStates[chatId] = { step: 'awaiting_remove_username' };
            return bot.sendMessage(chatId, "➖ *Remove Points*\nEnter username:", { parse_mode: "Markdown" }).catch(()=>{});
        }
        if (text.startsWith("📜 Players")) {
             try {
                 const res = await db.query("SELECT username, points, phone_number FROM users ORDER BY created_at DESC LIMIT 200"); 
                 
                 let msg = "📜 *All Players List*\n\n";
                 if(res.rows.length === 0) msg += "No players found.";

                 const chunks = [];
                 let currentChunk = msg;

                 res.rows.forEach((u, i) => {
                     const line = `${i+1}. ${escapeMarkdown(u.username)} (${u.phone_number || 'No Phone'}): ${u.points}\n`;
                     if ((currentChunk + line).length > 4000) {
                         chunks.push(currentChunk);
                         currentChunk = line;
                     } else {
                         currentChunk += line;
                     }
                 });
                 chunks.push(currentChunk);

                 for (const chunk of chunks) {
                     await bot.sendMessage(chatId, chunk, { parse_mode: "Markdown" }).catch(()=>{});
                 }
             } catch(e) { console.error(e); }
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
                if(res.rows.length === 0) msg += "No transactions found.";

                res.rows.forEach(t => {
                    const date = dayjs(t.created_at).format('MM/DD HH:mm');
                    let desc = t.description || 'N/A';
                    // FIX: Escape Markdown characters
                    const safeUser = escapeMarkdown(t.user_name || 'Unknown');
                    const safeType = escapeMarkdown(t.type);
                    const safeDesc = escapeMarkdown(desc);

                    msg += `🔹 ${date} - *${safeUser}*\n   ${safeType}: ${t.amount} (${safeDesc})\n`;
                });
                bot.sendMessage(chatId, msg, { parse_mode: "Markdown" }).catch(e => console.error("Tx Send Error:", e));
            } catch(e) { console.error("Tx Query Error:", e); }
            return;
        }

        // --- NEW: Delete User (Admin) ---
        if (text.startsWith("🗑️ Delete User")) {
            chatStates[chatId] = { step: 'awaiting_delete_username' };
            return bot.sendMessage(chatId, "🗑️ **Delete User**\n\nEnter the username to delete (This will remove all their data!):", { parse_mode: "Markdown" });
        }
    }

    if (userIsSuperAdmin) {
        if (text.startsWith("👑 Promote Admin")) {
            chatStates[chatId] = { step: 'awaiting_promote_username' };
            return bot.sendMessage(chatId, "👑 *Promote to Admin*\nEnter username to promote:", { parse_mode: "Markdown" }).catch(()=>{});
        }
        if (text.startsWith("🔻 Demote Admin")) {
            chatStates[chatId] = { step: 'awaiting_demote_username' };
            return bot.sendMessage(chatId, "🔻 *Demote Admin*\nEnter username to remove admin rights:", { parse_mode: "Markdown" }).catch(()=>{});
        }
    }

    if (chatStates[chatId]) {
        const state = chatStates[chatId];
        try {
            if (state.step === 'awaiting_register_phone') {
                state.regPhone = cleanPhone(text);
                state.step = 'awaiting_register_username';
                bot.sendMessage(chatId, "👤 *Enter Username:*", { parse_mode: "Markdown" }).catch(()=>{});
            }
            else if (state.step === 'awaiting_register_username') {
                const { user, created, error } = await registerUserByPhone(state.regPhone, text.trim());
                delete chatStates[chatId];
                if (error) {
                    bot.sendMessage(chatId, `❌ ${error}`).catch(()=>{});
                } else {
                    bot.sendMessage(chatId, `✅ *Registered!*\nUser: ${escapeMarkdown(user.username)}`, { parse_mode: "Markdown" }).catch(()=>{});
                    bot.sendMessage(chatId, `📩 *Forward this to the player:*`, { parse_mode: "Markdown" }).catch(()=>{});
                    bot.sendMessage(chatId, getInviteText(), { parse_mode: "Markdown" }).catch(()=>{});
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
                bot.sendMessage(chatId, `✅ Processed ${successCount} users.`).catch(()=>{});
                bot.sendMessage(chatId, `📩 *Forward this invite to all of them:*`, { parse_mode: "Markdown" }).catch(()=>{});
                bot.sendMessage(chatId, getInviteText(), { parse_mode: "Markdown" }).catch(()=>{});
            }
            else if (state.step === 'awaiting_deposit_amount') {
                const amount = parseInt(text);
                if (isNaN(amount) || amount <= 0) return bot.sendMessage(chatId, "❌ Invalid amount.").catch(()=>{});
                state.amount = amount;
                state.step = 'awaiting_deposit_proof';
                bot.sendMessage(chatId, "📸 *Upload Screenshot / ፎቶ ይላኩ*", { parse_mode: "Markdown" }).catch(()=>{});
            }
            else if (state.step === 'awaiting_withdraw_amount') {
                const amount = parseInt(text);
                const user = await getUser(tgId);
                if (isNaN(amount) || amount <= 0) return bot.sendMessage(chatId, "❌ Invalid Amount.").catch(()=>{});
                if (amount < 50) return bot.sendMessage(chatId, "❌ Minimum withdrawal is 50 Points.").catch(()=>{});
                if (user.points < amount) {
                    delete chatStates[chatId];
                    return bot.sendMessage(chatId, "❌ Insufficient Funds.", { reply_markup: userKeyboard }).catch(()=>{});
                }
                state.withdrawAmount = amount;
                state.step = 'awaiting_bank_details';
                bot.sendMessage(chatId, "🏦 *Bank Info*\nBank, Account, Name:", { parse_mode: "Markdown" }).catch(()=>{});
            }
            else if (state.step === 'awaiting_bank_details') {
                const amount = state.withdrawAmount;
                const user = await getUser(tgId);
                await db.query("UPDATE users SET points = points - $1 WHERE id = $2", [amount, user.id]);
                delete chatStates[chatId];
                bot.sendMessage(chatId, "✅ **Request Sent**", { reply_markup: userKeyboard }).catch(()=>{});
                
                const safeUser = escapeMarkdown(user.username);
                const safeInfo = escapeMarkdown(text);
                const adminMsg = `🚨 *Withdrawal*\nUser: ${safeUser}\nAmt: ${amount}\nInfo: ${safeInfo}`;
                
                const markup = { inline_keyboard: [[{ text: "Approve", callback_data: `wd_approve_${tgId}_${amount}` }], [{ text: "Reject", callback_data: `wd_reject_${tgId}_${amount}` }]] };
                broadcastToAdmins(adminMsg, { parse_mode: "Markdown", reply_markup: markup });
            }
            else if (state.step === 'awaiting_transfer_username') {
                const res = await db.query("SELECT * FROM users WHERE LOWER(username) = LOWER($1)", [text.trim()]);
                if (res.rows.length === 0) return bot.sendMessage(chatId, "❌ User not found.").catch(()=>{});
                state.targetUser = res.rows[0];
                state.step = 'awaiting_transfer_amount';
                bot.sendMessage(chatId, `Enter amount for ${state.targetUser.username}:`).catch(()=>{});
            }
            else if (state.step === 'awaiting_transfer_amount') {
                const amount = parseInt(text);
                const user = await getUser(tgId); // Sender
                if (user.points < amount) return bot.sendMessage(chatId, "❌ Not enough points.").catch(()=>{});
                
                await db.query("UPDATE users SET points = points - $1 WHERE telegram_id = $2", [amount, tgId]);
                await db.query("UPDATE users SET points = points + $1 WHERE id = $2", [amount, state.targetUser.id]);
                
                await db.logTransaction(user.id, 'transfer_out', -amount, state.targetUser.id, null, `Transfer to ${state.targetUser.username}`);
                await db.logTransaction(state.targetUser.id, 'transfer_in', amount, user.id, null, `Transfer from ${user.username}`);
                
                delete chatStates[chatId];
                bot.sendMessage(chatId, "✅ *Sent!*", { reply_markup: userKeyboard, parse_mode: "Markdown" }).catch(()=>{});

                if (state.targetUser.telegram_id) {
                    bot.sendMessage(state.targetUser.telegram_id, `💰 *Received ${amount} Points from ${escapeMarkdown(user.username)}!*\n\nገቢ: ${amount} ነጥብ ከ ${user.username}`, { parse_mode: "Markdown" }).catch(()=>{});
                }
            }
            else if (state.step === 'awaiting_start_seconds') {
                const seconds = parseInt(text);
                if (isNaN(seconds) || seconds < 0) return bot.sendMessage(chatId, "❌ Invalid Time.").catch(()=>{});
                startGameLogic(state.gameId, io, null, seconds);
                bot.sendMessage(chatId, `🚀 *Game #${state.gameId} Starting in ${seconds}s!*`, { parse_mode: "Markdown" }).catch(()=>{});
                delete chatStates[chatId];
            }
            else if (state.step === 'awaiting_bet') {
                const betAmount = parseInt(text);
                if (isNaN(betAmount) || betAmount <= 0) return bot.sendMessage(chatId, "❌ Invalid Bet.").catch(()=>{});
                state.betAmount = betAmount;
                const pattern = state.pattern || 'any_line';
                const res = await db.query('INSERT INTO games (bet_amount, status, pot, winning_pattern) VALUES ($1, $2, $3, $4) RETURNING *', [betAmount, 'pending', 0, pattern]);
                const gameId = res.rows[0].id;
                io.emit('gameStateUpdate', { status: 'pending', gameId, betAmount: betAmount, pot: 0, calledNumbers: [], pattern });
                
                // --- FIX: SEND INVITE LINK IMMEDIATELY ---
                const inviteLink = `https://t.me/${botUsername}?start=bingo`;
                const inviteMsg = `📢 **Bingo Game #${gameId} Open!**\n\n` +
                                  `Bet: ${betAmount} Points\n` +
                                  `Rule: ${pattern.replace('_', ' ').toUpperCase()}\n\n` +
                                  `👇 **Click here to Join:**\n${inviteLink}`;
                
                const dashMsg = `🎮 *Game #${gameId} Pending*\nBet: ${betAmount}\n\n👇 *Wait for players then Start:*`;
                const kb = { inline_keyboard: [[{ text: "🔄 Refresh", callback_data: `gm_refresh_${gameId}` }], [{ text: "▶️ START", callback_data: `gm_pre_${gameId}` }], [{ text: "🛑 Abort", callback_data: `gm_abort_${gameId}` }]] };
                
                bot.sendMessage(chatId, dashMsg, { parse_mode: "Markdown", reply_markup: kb }).catch(()=>{});
                
                // Send the forwarding message
                setTimeout(() => {
                    bot.sendMessage(chatId, inviteMsg, { parse_mode: "Markdown" }).catch(()=>{});
                    bot.sendMessage(chatId, "⬆️ **Forward the message above to your Group/Channel!**", { parse_mode: "Markdown" }).catch(()=>{});
                }, 500); 

                delete chatStates[chatId]; 
            }
            else if (state.step === 'awaiting_bank_update') {
                await db.query("INSERT INTO system_settings (key, value) VALUES ('bank_details', $1) ON CONFLICT (key) DO UPDATE SET value = $1", [text]);
                delete chatStates[chatId];
                bot.sendMessage(chatId, "✅ Bank Details Updated!", { reply_markup: adminKeyboard }).catch(()=>{});
            }
            else if (state.step === 'awaiting_add_username') { state.username = text.trim(); state.step = 'awaiting_add_amount'; bot.sendMessage(chatId, "Amount:").catch(()=>{}); }
            else if (state.step === 'awaiting_add_amount') { 
                const amount = parseInt(text);
                const targetRes = await db.query("SELECT id FROM users WHERE LOWER(username) = LOWER($1)", [state.username]);
                if(targetRes.rows.length > 0) {
                    await db.query("UPDATE users SET points = points + $1 WHERE LOWER(username) = LOWER($2)", [amount, state.username]); 
                    await db.logTransaction(targetRes.rows[0].id, 'admin_add', amount, null, null, 'Added by Admin');
                    bot.sendMessage(chatId, "✅ Done.").catch(()=>{}); 
                } else {
                    bot.sendMessage(chatId, "❌ User not found.").catch(()=>{}); 
                }
                delete chatStates[chatId]; 
            }
            else if (state.step === 'awaiting_bulk_usernames') { state.usernames = text.split(',').map(u=>u.trim()); state.step = 'awaiting_bulk_amount'; bot.sendMessage(chatId, "Amount per user:").catch(()=>{}); }
            else if (state.step === 'awaiting_bulk_amount') { 
                const amt = parseInt(text); 
                for(const u of state.usernames) {
                    const targetRes = await db.query("SELECT id FROM users WHERE LOWER(username) = LOWER($1)", [u]);
                    if(targetRes.rows.length > 0) {
                        await db.query("UPDATE users SET points = points + $1 WHERE LOWER(username) = LOWER($2)", [amt, u]);
                        await db.logTransaction(targetRes.rows[0].id, 'admin_add', amt, null, null, 'Bulk Add by Admin');
                    }
                }
                delete chatStates[chatId]; 
                bot.sendMessage(chatId, "✅ Done.", {reply_markup: adminKeyboard}).catch(()=>{}); 
            }
            else if (state.step === 'awaiting_remove_username') { state.username = text.trim(); state.step = 'awaiting_remove_amount'; bot.sendMessage(chatId, "Amount to remove:").catch(()=>{}); }
            else if (state.step === 'awaiting_remove_amount') { 
                const amount = parseInt(text);
                const targetRes = await db.query("SELECT id FROM users WHERE LOWER(username) = LOWER($1)", [state.username]);
                if(targetRes.rows.length > 0) {
                    await db.query("UPDATE users SET points = points - $1 WHERE LOWER(username) = LOWER($2)", [amount, state.username]); 
                    await db.logTransaction(targetRes.rows[0].id, 'admin_remove', -amount, null, null, 'Removed by Admin');
                    bot.sendMessage(chatId, "✅ Done.").catch(()=>{}); 
                }
                delete chatStates[chatId]; 
            }
            else if (state.step === 'awaiting_custom_prize') {
                const amount = parseInt(text);
                if (isNaN(amount) || amount <= 0) {
                     return bot.sendMessage(chatId, "❌ Invalid amount. Please enter a number.").catch(()=>{});
                }
                if (state.max && amount > state.max) {
                     return bot.sendMessage(chatId, `❌ Invalid amount. Max is ${state.max}`).catch(()=>{});
                }
                await db.query("UPDATE games SET pot = $1 WHERE id = $2", [amount, state.gameId]);
                chatStates[chatId] = { step: 'awaiting_start_seconds', gameId: state.gameId };
                bot.sendMessage(chatId, `✅ *Custom Prize set to ${amount}*\n\n⏱ Enter countdown seconds to START (e.g., 10):`, { parse_mode: "Markdown" }).catch(()=>{});
            }
            else if (state.step === 'awaiting_promote_username') {
                 const targetUsername = text.trim();
                 const userRes = await db.query("SELECT * FROM users WHERE LOWER(username) = LOWER($1)", [targetUsername]);
                 if (userRes.rows.length === 0) {
                      bot.sendMessage(chatId, "❌ User not found.");
                 } else {
                      const user = userRes.rows[0];
                      await db.query("UPDATE users SET role = 'admin' WHERE id = $1", [user.id]);
                      bot.sendMessage(chatId, `✅ *${escapeMarkdown(user.username)}* promoted to Admin!`, { parse_mode: "Markdown" });
                      if(user.telegram_id) bot.sendMessage(user.telegram_id, "👑 You have been promoted to Admin!", { reply_markup: adminKeyboard });
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
                      bot.sendMessage(chatId, `🔻 *${escapeMarkdown(user.username)}* demoted to Player.`, { parse_mode: "Markdown" });
                      if(user.telegram_id) bot.sendMessage(user.telegram_id, "ℹ️ You have been removed from Admin role.", { reply_markup: userKeyboard });
                 }
                 delete chatStates[chatId];
            }
            
            // --- NEW: Handle Edit Name Input ---
            else if (state.step === 'awaiting_new_username') {
                const newName = text.trim();
                if (newName.length < 3) return bot.sendMessage(chatId, "❌ Username too short.");
                
                // Check if taken
                const check = await db.query("SELECT id FROM users WHERE LOWER(username) = LOWER($1)", [newName]);
                if (check.rows.length > 0) return bot.sendMessage(chatId, "❌ Username already taken.");

                await db.query("UPDATE users SET username = $1 WHERE id = $2", [newName, user.id]);
                delete chatStates[chatId];
                bot.sendMessage(chatId, `✅ Username changed to **${newName}**!`, { parse_mode: "Markdown", reply_markup: userKeyboard });
            }

            // --- NEW: Handle Delete User Input ---
            else if (state.step === 'awaiting_delete_username') {
                const targetUser = text.trim();
                const uRes = await db.query("SELECT id, username FROM users WHERE LOWER(username) = LOWER($1)", [targetUser]);
                
                if (uRes.rows.length === 0) {
                    bot.sendMessage(chatId, "❌ User not found.");
                } else {
                    const uid = uRes.rows[0].id;
                    // Delete dependencies first (cascade manually just in case)
                    await db.query("DELETE FROM player_cards WHERE user_id = $1", [uid]);
                    await db.query("DELETE FROM deposits WHERE user_id = $1", [uid]);
                    await db.query("DELETE FROM transactions WHERE user_id = $1 OR related_user_id = $1", [uid]);
                    await db.query("UPDATE games SET winner_id = NULL WHERE winner_id = $1", [uid]);
                    
                    // Finally delete user
                    await db.query("DELETE FROM users WHERE id = $1", [uid]);
                    bot.sendMessage(chatId, `🗑️ **${uRes.rows[0].username}** has been permanently deleted.`, { parse_mode: "Markdown" });
                }
                delete chatStates[chatId];
            }

        } catch (err) { console.error(err); delete chatStates[chatId]; bot.sendMessage(chatId, "❌ Error.").catch(()=>{}); }
    }
  });

  return bot;
};

module.exports = { startBot };