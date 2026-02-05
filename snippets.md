
# Code Snippets for Premium & User Management Features

## 1. Premium Players List (Super Admin)
This snippet handles the "🌟 Premium Players" button, listing all users with active premium subscriptions.

**Trigger:** `text === "🌟 Premium Players"`
**Location:** `bot.js`

```javascript
if (text === "🌟 Premium Players") {
    if (await isSuperAdmin(tgId)) {
        const res = await db.query("SELECT username, phone_number, premium_expires_at FROM users WHERE premium_expires_at > NOW() ORDER BY premium_expires_at ASC");
        if (res.rows.length === 0) {
            bot.sendMessage(chatId, "🌟 No active premium players.");
        } else {
            let msg = "🌟 **Active Premium Players** 🌟\n\n";
            res.rows.forEach((u, i) => {
                const exp = dayjs(u.premium_expires_at).format('DD/MM/YYYY');
                msg += `${i + 1}. **${u.username}** (${u.phone_number}) - Ends: ${exp}\n`;
            });
            msg += "\n💡 *To manage/cancel, use '👤 Manage User'*";
            bot.sendMessage(chatId, msg, { parse_mode: "Markdown" });
        }
    }
    return;
}
```

## 2. Premium Settings (Super Admin)
This snippet manages the configuration of premium package prices and bank details.

### A. View Settings Menu
**Trigger:** `text === "⚙️ Premium Settings"`
**Location:** `bot.js`

```javascript
if (text === "⚙️ Premium Settings") {
    if (await isSuperAdmin(tgId)) {
        // Fetch Settings
        const keys = ['prem_price_1m', 'prem_price_3m', 'prem_price_6m', 'prem_price_1y', 'prem_bank_details'];
        const res = await db.query("SELECT key, value FROM system_settings WHERE key = ANY($1)", [keys]);
        const settings = {};
        res.rows.forEach(r => settings[r.key] = r.value);

        const p1m = settings['prem_price_1m'] || '150';
        const p3m = settings['prem_price_3m'] || '400';
        const p6m = settings['prem_price_6m'] || '750';
        const p1y = settings['prem_price_1y'] || '1400';
        const bank = settings['prem_bank_details'] || '(Default Bank)';

        const msg = `⚙️ **Premium Configuration**\n\n` +
            `**Prices (ETB):**\n` +
            `• 1 Month: ${p1m}\n` +
            `• 3 Months: ${p3m}\n` +
            `• 6 Months: ${p6m}\n` +
            `• 1 Year: ${p1y}\n\n` +
            `**Bank Details:**\n${bank}`;

        const kb = {
            inline_keyboard: [
                [{ text: "Edit 1 Month", callback_data: "pset_1m" }, { text: "Edit 3 Months", callback_data: "pset_3m" }],
                [{ text: "Edit 6 Months", callback_data: "pset_6m" }, { text: "Edit 1 Year", callback_data: "pset_1y" }],
                [{ text: "🏦 Edit Bank Details", callback_data: "pset_bank" }]
            ]
        };
        bot.sendMessage(chatId, msg, { parse_mode: "Markdown", reply_markup: kb });
    }
    return;
}
```

### B. Callback Handler for Edit Buttons
**Trigger:** Callback `pset_`
**Location:** `bot.js`

```javascript
// PREMIUM SETTINGS CALLBACKS
if (action.startsWith('pset_')) {
    const target = action.replace('pset_', '');
    if (target === 'bank') {
        chatStates[chatId] = { step: 'awaiting_prem_bank' };
        bot.sendMessage(chatId, "🏦 **Enter New Premium Bank Details:**\n(Account Number, Name, etc.)", { reply_markup: { force_reply: true } });
    } else {
        // Price Target: 1m, 3m, 6m, 1y
        chatStates[chatId] = { step: 'awaiting_prem_price', target: target };
        bot.sendMessage(chatId, `💰 **Enter Price for ${target} (ETB):**`, { reply_markup: { force_reply: true } });
    }
    await bot.answerCallbackQuery(cq.id);
    return;
}
```

### C. State Handlers for User Input
**Trigger:** `awaiting_prem_price` / `awaiting_prem_bank`
**Location:** `bot.js`

```javascript
// --- PREMIUM SETTINGS STATE ---
else if (state.step === 'awaiting_prem_price') {
    const price = parseInt(text);
    if (isNaN(price) || price <= 0) return bot.sendMessage(chatId, "❌ Invalid Price.");

    const key = `prem_price_${state.target}`; // e.g., prem_price_1m
    await db.query("INSERT INTO system_settings (key, value) VALUES ($1, $2) ON CONFLICT (key) DO UPDATE SET value = $2", [key, String(price)]);

    bot.sendMessage(chatId, `✅ **Price Updated!**\n${state.target} = ${price} ETB`, { reply_markup: superAdminKeyboard });
    delete chatStates[chatId];
}
else if (state.step === 'awaiting_prem_bank') {
    await db.query("INSERT INTO system_settings (key, value) VALUES ('prem_bank_details', $1) ON CONFLICT (key) DO UPDATE SET value = $1", [text]);
    bot.sendMessage(chatId, `✅ **Premium Bank Details Updated!**`, { reply_markup: superAdminKeyboard });
    delete chatStates[chatId];
}
```

## 3. Manage User (Super Admin)
This feature allows searching for a user and performing actions like Rename, Give/Cancel Premium, or Delete.

### A. Initial Search Prompt
**Trigger:** `text === "👤 Manage User"`
**Location:** `bot.js`

```javascript
if (text === "👤 Manage User") {
    if (await isSuperAdmin(tgId)) {
        chatStates[chatId] = { step: 'awaiting_edit_search' };
        bot.sendMessage(chatId, "👤 **Manage User**\n\nSend the **Phone Number** or **Current Username** of the player:", { parse_mode: "Markdown", reply_markup: { force_reply: true } });
    }
    return;
}
```

### B. Search Logic & Action Menu
**Trigger:** `awaiting_edit_search`
**Location:** `bot.js`

```javascript
else if (state.step === 'awaiting_edit_search') {
    const query = text.trim();
    const res = await db.query("SELECT * FROM users WHERE phone_number = $1 OR LOWER(username) = LOWER($1)", [query]);

    if (res.rows.length === 0) {
        bot.sendMessage(chatId, "❌ User not found.");
        delete chatStates[chatId];
    } else {
        const targetUser = res.rows[0];
        state.targetUser = targetUser;
        state.step = 'awaiting_manage_action';

        let premStatus = "Inactive";
        if (targetUser.premium_expires_at) {
            const exp = dayjs(targetUser.premium_expires_at);
            if (exp.isAfter(dayjs())) premStatus = `✅ Active until ${exp.format('DD/MM/YYYY')}`;
        }

        const msg = `👤 **Manage User: ${targetUser.username}**\n` +
            `📱 Phone: ${targetUser.phone_number}\n` +
            `💰 Points: ${targetUser.points}\n` +
            `🌟 Premium: ${premStatus}\n\n` +
            `👇 **Select Action:**`;

        const kb = {
            inline_keyboard: [
                [{ text: "✏️ Change Username", callback_data: "mng_rename" }],
                [{ text: "➕ Give Premium", callback_data: "mng_give_prem" }, { text: "❌ Cancel Premium", callback_data: "mng_cancel_prem" }],
                [{ text: "🗑️ Delete User (DANGER)", callback_data: "mng_delete" }]
            ]
        };
        bot.sendMessage(chatId, msg, { parse_mode: "Markdown", reply_markup: kb });
    }
}
```

### C. Action Callback Handlers
**Trigger:** Callback `mng_`
**Location:** `bot.js`

```javascript
if (action.startsWith('mng_')) {
    const act = action.replace('mng_', '');
    if (!chatStates[chatId] || !chatStates[chatId].targetUser) {
        return bot.answerCallbackQuery(cq.id, { text: "Session expired. Search user again.", show_alert: true });
    }
    const targetUser = chatStates[chatId].targetUser;

    if (act === 'rename') {
        chatStates[chatId].step = 'awaiting_edit_newname';
        bot.sendMessage(chatId, `👇 **Enter New Username for ${targetUser.username}:**`, { reply_markup: { force_reply: true } });
    }
    else if (act === 'give_prem') {
        const kb = {
            inline_keyboard: [
                [{ text: "1 Month", callback_data: "mng_prem_1m" }],
                [{ text: "3 Months", callback_data: "mng_prem_3m" }],
                [{ text: "6 Months", callback_data: "mng_prem_6m" }],
                [{ text: "1 Year", callback_data: "mng_prem_1y" }]
            ]
        };
        bot.sendMessage(chatId, "💎 Select Premium Duration:", { reply_markup: kb });
    }
    else if (act.startsWith('prem_')) {
        const dur = act.replace('prem_', '');
        let months = 1;
        if (dur === '3m') months = 3;
        if (dur === '6m') months = 6;
        if (dur === '1y') months = 12;

        const expiry = dayjs().add(months, 'month').format();
        await db.query("UPDATE users SET premium_expires_at = $1, pref_auto_daub = TRUE, pref_auto_bingo = TRUE WHERE id = $2", [expiry, targetUser.id]);

        bot.sendMessage(chatId, `✅ Given **${dur}** Premium to ${targetUser.username}.`);
        if (targetUser.telegram_id) bot.sendMessage(targetUser.telegram_id, `🌟 **You have been given Premium!**\nDuration: ${dur}`).catch(() => { });
        delete chatStates[chatId];
    }
    else if (act === 'cancel_prem') {
        await db.query("UPDATE users SET premium_expires_at = NULL, pref_auto_daub = FALSE WHERE id = $1", [targetUser.id]);
        bot.sendMessage(chatId, `❌ Premium Cancelled for ${targetUser.username}.`);
        if (targetUser.telegram_id) bot.sendMessage(targetUser.telegram_id, `❌ Your Premium Subscription has been cancelled by Admin.`).catch(() => { });
        delete chatStates[chatId];
    }
    else if (act === 'delete') {
        const uid = targetUser.id;
        await db.query("DELETE FROM player_cards WHERE user_id = $1", [uid]);
        await db.query("DELETE FROM deposits WHERE user_id = $1", [uid]);
        await db.query("DELETE FROM transactions WHERE user_id = $1 OR related_user_id = $1", [uid]);
        await db.query("UPDATE games SET winner_id = NULL WHERE winner_id = $1", [uid]);
        await db.query("DELETE FROM users WHERE id = $1", [uid]);
        bot.sendMessage(chatId, `🗑️ **${targetUser.username}** deleted permanently.`);
        delete chatStates[chatId];
    }
    await bot.answerCallbackQuery(cq.id);
    return;
}
```
