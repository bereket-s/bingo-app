const { Pool } = require('pg');

const isProduction = process.env.NODE_ENV === 'production';

const connectionConfig = {
    connectionString: process.env.DATABASE_URL,
    ssl: isProduction ? { rejectUnauthorized: false } : false
};

if (!process.env.DATABASE_URL) {
    connectionConfig.user = process.env.DB_USER || 'postgres';
    connectionConfig.host = process.env.DB_HOST || 'localhost';
    connectionConfig.database = process.env.DB_NAME || 'bingo_db';
    connectionConfig.password = process.env.DB_PASSWORD || '199129';
    connectionConfig.port = parseInt(process.env.DB_PORT || '5432', 10);
    delete connectionConfig.connectionString;
}

const pool = new Pool(connectionConfig);

async function initializeDatabase() {
    const client = await pool.connect();
    try {
        await client.query('BEGIN');

        // Core Tables - Note points DEFAULT 0
        await client.query(`CREATE TABLE IF NOT EXISTS users (id SERIAL PRIMARY KEY, telegram_id BIGINT UNIQUE, username VARCHAR(255) NOT NULL, points INTEGER DEFAULT 0, role VARCHAR(20) DEFAULT 'player', session_token VARCHAR(255) UNIQUE, phone_number VARCHAR(50), has_auto_daub BOOLEAN DEFAULT FALSE, pref_auto_daub BOOLEAN DEFAULT TRUE, pref_auto_bingo BOOLEAN DEFAULT TRUE, premium_expires_at TIMESTAMP WITH TIME ZONE, last_bot_msg_id INTEGER, created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP);`);
        await client.query(`CREATE TABLE IF NOT EXISTS games (id SERIAL PRIMARY KEY, status VARCHAR(50) NOT NULL DEFAULT 'idle', bet_amount INTEGER NOT NULL DEFAULT 0, pot INTEGER NOT NULL DEFAULT 0, winning_pattern VARCHAR(50) DEFAULT 'any_line', winner_id INTEGER REFERENCES users(id), created_by VARCHAR(255), creator_id BIGINT, created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP);`);
        await client.query(`CREATE TABLE IF NOT EXISTS player_cards (id SERIAL PRIMARY KEY, user_id INTEGER NOT NULL REFERENCES users(id), game_id INTEGER NOT NULL REFERENCES games(id), card_data JSONB NOT NULL, original_card_id INTEGER, created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP, UNIQUE(user_id, game_id, id));`);
        await client.query(`CREATE TABLE IF NOT EXISTS deposits (id SERIAL PRIMARY KEY, user_id INTEGER REFERENCES users(id), telegram_id BIGINT, amount INTEGER NOT NULL, proof_image_id VARCHAR(255), status VARCHAR(50) DEFAULT 'pending', request_type VARCHAR(50) DEFAULT 'points', package_duration VARCHAR(50), admin_msg_ids JSONB, created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP);`);
        await client.query(`CREATE TABLE IF NOT EXISTS withdrawal_requests (id SERIAL PRIMARY KEY, user_id INTEGER REFERENCES users(id), telegram_id BIGINT, amount INTEGER NOT NULL, bank_details TEXT, status VARCHAR(50) DEFAULT 'pending', admin_msg_ids JSONB, created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP);`);
        await client.query(`CREATE TABLE IF NOT EXISTS bank_transactions (id SERIAL PRIMARY KEY, txn_code VARCHAR(100) UNIQUE, amount INTEGER NOT NULL, sender_name VARCHAR(255), raw_sms TEXT, status VARCHAR(20) DEFAULT 'unclaimed', claimed_by INTEGER REFERENCES users(id), created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP);`);
        await client.query(`CREATE TABLE IF NOT EXISTS transactions (id SERIAL PRIMARY KEY, user_id INTEGER REFERENCES users(id), type VARCHAR(50) NOT NULL, amount INTEGER NOT NULL, related_user_id INTEGER, game_id INTEGER, description TEXT, created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP);`);
        await client.query(`CREATE TABLE IF NOT EXISTS system_settings (key VARCHAR(50) PRIMARY KEY, value TEXT);`);

        // Default Settings
        await client.query("INSERT INTO system_settings (key, value) VALUES ('house_bots_enabled', 'false') ON CONFLICT (key) DO NOTHING");

        // Migrations
        await client.query(`
            DO $$ BEGIN
                IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'games' AND column_name = 'daily_id') THEN
                    ALTER TABLE games ADD COLUMN daily_id INTEGER DEFAULT 1;
                END IF;
                IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'games' AND column_name = 'created_by') THEN
                    ALTER TABLE games ADD COLUMN created_by VARCHAR(255);
                END IF;
                IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'games' AND column_name = 'creator_id') THEN
                    ALTER TABLE games ADD COLUMN creator_id BIGINT;
                END IF;
                IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'users' AND column_name = 'pref_auto_daub') THEN
                    ALTER TABLE users ADD COLUMN pref_auto_daub BOOLEAN DEFAULT TRUE;
                END IF;
                IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'users' AND column_name = 'pref_auto_bingo') THEN
                    ALTER TABLE users ADD COLUMN pref_auto_bingo BOOLEAN DEFAULT TRUE;
                END IF;
                IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'users' AND column_name = 'last_bot_msg_id') THEN
                    ALTER TABLE users ADD COLUMN last_bot_msg_id INTEGER;
                END IF;
                IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'withdrawal_requests' AND column_name = 'rejection_reason') THEN
                    ALTER TABLE withdrawal_requests ADD COLUMN rejection_reason TEXT;
                END IF;
                IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'games' AND column_name = 'winning_pattern') THEN
                    ALTER TABLE games ADD COLUMN winning_pattern VARCHAR(50) DEFAULT 'any_line';
                END IF;
                IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'games' AND column_name = 'start_time') THEN
                    ALTER TABLE games ADD COLUMN start_time BIGINT;
                END IF;
                IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'deposits' AND column_name = 'admin_msg_ids') THEN
                    ALTER TABLE deposits ADD COLUMN admin_msg_ids JSONB;
                END IF;
                IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'withdrawal_requests' AND column_name = 'admin_msg_ids') THEN
                    ALTER TABLE withdrawal_requests ADD COLUMN admin_msg_ids JSONB;
                END IF;
                
                -- NEW FINANCIAL COLUMNS
                IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'users' AND column_name = 'admin_balance') THEN
                    ALTER TABLE users ADD COLUMN admin_balance INTEGER DEFAULT 0;
                END IF;

                -- FIX: Add admin_id to transactions
                IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'transactions' AND column_name = 'admin_id') THEN
                    ALTER TABLE transactions ADD COLUMN admin_id INTEGER REFERENCES users(id);
                END IF;

                -- HOUSE BOTS
                IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'users' AND column_name = 'is_house_bot') THEN
                    ALTER TABLE users ADD COLUMN is_house_bot BOOLEAN DEFAULT FALSE;
                END IF;


                -- 1. DELETE DUPLICATES (If any exist from the bug)
                DELETE FROM player_cards a USING player_cards b 
                WHERE a.id > b.id AND a.user_id = b.user_id AND a.game_id = b.game_id AND a.original_card_id = b.original_card_id;

                -- 2. ADD STRICT CONSTRAINT
                IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'unique_user_card_per_game') THEN
                    ALTER TABLE player_cards ADD CONSTRAINT unique_user_card_per_game UNIQUE (user_id, game_id, original_card_id);
                END IF;

                -- CRITICAL: Force points default to 0
                ALTER TABLE users ALTER COLUMN points SET DEFAULT 0;
            END $$;
        `);

        // NEW TABLES
        await client.query(`CREATE TABLE IF NOT EXISTS daily_reports (date DATE PRIMARY KEY, total_revenue INTEGER DEFAULT 0, total_payout INTEGER DEFAULT 0, net_profit INTEGER DEFAULT 0, system_share INTEGER DEFAULT 0, admin_shares JSONB DEFAULT '{}'::jsonb, created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP);`);
        await client.query(`CREATE TABLE IF NOT EXISTS admin_transfers (id SERIAL PRIMARY KEY, from_admin_id INTEGER REFERENCES users(id), to_admin_id INTEGER REFERENCES users(id), amount INTEGER NOT NULL, status VARCHAR(50) DEFAULT 'pending', created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP);`);
        await client.query(`CREATE TABLE IF NOT EXISTS image_hashes (hash VARCHAR(64) PRIMARY KEY, user_id INTEGER, created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP);`);

        await client.query('COMMIT');
        console.log('✅ Database initialized.');

    } catch (err) {
        await client.query('ROLLBACK');
        console.error('❌ Database error:', err.stack);
        if (isProduction) process.exit(1);
    } finally {
        client.release();
    }
}

initializeDatabase();

const logTransaction = async (userId, type, amount, relatedUserId = null, gameId = null, description = '', adminId = null) => {
    try {
        await pool.query(
            `INSERT INTO transactions (user_id, type, amount, related_user_id, game_id, description, admin_id) 
             VALUES ($1, $2, $3, $4, $5, $6, $7)`,
            [userId, type, amount, relatedUserId, gameId, description, adminId]
        );
    } catch (e) {
        console.error("Failed to log transaction:", e);
    }
};

// Safer Account Linking - Explicitly sets points to 0
async function linkTelegramAccount(phone, tgId, username) {
    try {
        const userCheck = await pool.query("SELECT * FROM users WHERE LOWER(username) = LOWER($1)", [username]);
        if (userCheck.rows.length > 0 && userCheck.rows[0].phone_number !== phone) {
            return { error: "Username taken! Try another one." };
        }
        const userByPhone = await pool.query('SELECT * FROM users WHERE phone_number = $1', [phone]);
        const userByTg = await pool.query('SELECT * FROM users WHERE telegram_id = $1', [tgId]);

        if (userByPhone.rows.length > 0) {
            const updatedUser = await pool.query('UPDATE users SET telegram_id = $1 WHERE phone_number = $2 RETURNING *', [tgId, phone]);
            if (userByTg.rows.length > 0 && userByTg.rows[0].id !== updatedUser.rows[0].id) {
                await pool.query('DELETE FROM users WHERE id = $1', [userByTg.rows[0].id]);
            }
            return { user: updatedUser.rows[0], status: 'account_linked' };
        }
        else if (userByTg.rows.length > 0) {
            const updatedUser = await pool.query('UPDATE users SET phone_number = $1, username = $2 WHERE telegram_id = $3 RETURNING *', [phone, username, tgId]);
            return { user: updatedUser.rows[0], status: 'profile_updated' };
        }
        else {
            // FIXED: Explicitly insert 0 points
            const newUser = await pool.query('INSERT INTO users (phone_number, telegram_id, username, points) VALUES ($1, $2, $3, 0) RETURNING *', [phone, tgId, username]);
            return { user: newUser.rows[0], status: 'new_user_created' };
        }
    } catch (err) {
        console.error("Link Account Error:", err);
        return { error: "Database error during registration." };
    }
}

module.exports = {
    query: (text, params) => pool.query(text, params),
    logTransaction,
    linkTelegramAccount
};