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

        await client.query(`CREATE TABLE IF NOT EXISTS users (id SERIAL PRIMARY KEY, telegram_id BIGINT UNIQUE, username VARCHAR(255) NOT NULL, points INTEGER DEFAULT 100, role VARCHAR(20) DEFAULT 'player', session_token VARCHAR(255) UNIQUE, phone_number VARCHAR(50), has_auto_daub BOOLEAN DEFAULT FALSE, pref_auto_daub BOOLEAN DEFAULT TRUE, pref_auto_bingo BOOLEAN DEFAULT TRUE, premium_expires_at TIMESTAMP WITH TIME ZONE, created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP);`);
        await client.query(`CREATE TABLE IF NOT EXISTS games (id SERIAL PRIMARY KEY, status VARCHAR(50) NOT NULL DEFAULT 'idle', bet_amount INTEGER NOT NULL DEFAULT 0, pot INTEGER NOT NULL DEFAULT 0, winning_pattern VARCHAR(50) DEFAULT 'any_line', winner_id INTEGER REFERENCES users(id), created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP);`);
        await client.query(`CREATE TABLE IF NOT EXISTS player_cards (id SERIAL PRIMARY KEY, user_id INTEGER NOT NULL REFERENCES users(id), game_id INTEGER NOT NULL REFERENCES games(id), card_data JSONB NOT NULL, original_card_id INTEGER, created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP, UNIQUE(user_id, game_id, id));`);
        await client.query(`CREATE TABLE IF NOT EXISTS deposits (id SERIAL PRIMARY KEY, user_id INTEGER REFERENCES users(id), telegram_id BIGINT, amount INTEGER NOT NULL, proof_image_id VARCHAR(255), status VARCHAR(50) DEFAULT 'pending', request_type VARCHAR(50) DEFAULT 'points', package_duration VARCHAR(50), created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP);`);
        await client.query(`CREATE TABLE IF NOT EXISTS bank_transactions (id SERIAL PRIMARY KEY, txn_code VARCHAR(100) UNIQUE, amount INTEGER NOT NULL, sender_name VARCHAR(255), raw_sms TEXT, status VARCHAR(20) DEFAULT 'unclaimed', claimed_by INTEGER REFERENCES users(id), created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP);`);
        await client.query(`CREATE TABLE IF NOT EXISTS transactions (id SERIAL PRIMARY KEY, user_id INTEGER REFERENCES users(id), type VARCHAR(50) NOT NULL, amount INTEGER NOT NULL, related_user_id INTEGER, game_id INTEGER, description TEXT, created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP);`);
        await client.query(`CREATE TABLE IF NOT EXISTS system_settings (key VARCHAR(50) PRIMARY KEY, value TEXT);`);

        // --- MIGRATION: Add daily_id column ---
        await client.query(`
            DO $$ BEGIN
                IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'games' AND column_name = 'daily_id') THEN
                    ALTER TABLE games ADD COLUMN daily_id INTEGER DEFAULT 1;
                END IF;
                IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'users' AND column_name = 'pref_auto_daub') THEN
                    ALTER TABLE users ADD COLUMN pref_auto_daub BOOLEAN DEFAULT TRUE;
                END IF;
                IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'users' AND column_name = 'pref_auto_bingo') THEN
                    ALTER TABLE users ADD COLUMN pref_auto_bingo BOOLEAN DEFAULT TRUE;
                END IF;
                IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'games' AND column_name = 'winning_pattern') THEN
                    ALTER TABLE games ADD COLUMN winning_pattern VARCHAR(50) DEFAULT 'any_line';
                END IF;
            END $$;
        `);

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

const logTransaction = async (userId, type, amount, relatedUserId = null, gameId = null, description = '') => {
    try {
        // description often contains the Transaction ID or Reference (e.g., "SMS Deposit 8H7G6F")
        await pool.query(
            `INSERT INTO transactions (user_id, type, amount, related_user_id, game_id, description) 
             VALUES ($1, $2, $3, $4, $5, $6)`,
            [userId, type, amount, relatedUserId, gameId, description]
        );
    } catch (e) {
        console.error("Failed to log transaction:", e);
    }
};

module.exports = {
  query: (text, params) => pool.query(text, params),
  logTransaction
};