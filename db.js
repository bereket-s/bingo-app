const { Pool } = require('pg');

const isProduction = process.env.NODE_ENV === 'production';

const connectionConfig = {
  connectionString: process.env.DATABASE_URL,
  ssl: isProduction ? { rejectUnauthorized: false } : false
};

// Fallback for local development if DATABASE_URL is not set
if (!process.env.DATABASE_URL) {
  connectionConfig.user = process.env.DB_USER ;
  connectionConfig.host = process.env.DB_HOST ;
  connectionConfig.database = process.env.DB_NAME ;
  connectionConfig.password = process.env.DB_PASSWORD ;
  connectionConfig.port = parseInt(process.env.DB_PORT , 10);
  // Remove connectionString if using individual params
  delete connectionConfig.connectionString;
}

const pool = new Pool(connectionConfig);

async function initializeDatabase() {
    const client = await pool.connect();
    try {
        await client.query('BEGIN');

        // 1. Create Users Table with ROLE
        await client.query(`
            CREATE TABLE IF NOT EXISTS users (
                id SERIAL PRIMARY KEY,
                telegram_id BIGINT UNIQUE,
                username VARCHAR(255) NOT NULL,
                points INTEGER DEFAULT 0, 
                role VARCHAR(20) DEFAULT 'player', 
                session_token VARCHAR(255) UNIQUE,
                phone_number VARCHAR(50),
                has_auto_daub BOOLEAN DEFAULT FALSE,
                pref_auto_daub BOOLEAN DEFAULT TRUE,
                pref_auto_bingo BOOLEAN DEFAULT TRUE,
                premium_expires_at TIMESTAMP WITH TIME ZONE,
                created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
            );
        `);

        // --- MIGRATION CHECKS ---
        await client.query(`
            DO $$ BEGIN
                IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'users' AND column_name = 'pref_auto_daub') THEN
                    ALTER TABLE users ADD COLUMN pref_auto_daub BOOLEAN DEFAULT TRUE;
                END IF;
                IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'users' AND column_name = 'pref_auto_bingo') THEN
                    ALTER TABLE users ADD COLUMN pref_auto_bingo BOOLEAN DEFAULT TRUE;
                END IF;
                IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'users' AND column_name = 'created_at') THEN
                    ALTER TABLE users ADD COLUMN created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP;
                END IF;
                IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'users' AND column_name = 'role') THEN
                    ALTER TABLE users ADD COLUMN role VARCHAR(20) DEFAULT 'player';
                END IF;
            END $$;
        `);

        // 2. SELF-HEALING (Duplicates cleanup)
        await client.query(`
            DELETE FROM users a USING users b WHERE a.id < b.id AND a.username = b.username;
            DELETE FROM users a USING users b WHERE a.id < b.id AND LOWER(a.username) = LOWER(b.username);
            DELETE FROM users a USING users b WHERE a.id < b.id AND a.phone_number = b.phone_number;
        `);

        // 3. Constraints
        await client.query(`
            DO $$ BEGIN
                IF NOT EXISTS (SELECT 1 FROM information_schema.table_constraints WHERE constraint_name = 'users_username_key') THEN
                    ALTER TABLE users ADD CONSTRAINT users_username_key UNIQUE (username);
                END IF;
                IF NOT EXISTS (SELECT 1 FROM information_schema.table_constraints WHERE constraint_name = 'users_phone_number_key') THEN
                    ALTER TABLE users ADD CONSTRAINT users_phone_number_key UNIQUE (phone_number);
                END IF;
            END $$;
        `);
        await client.query(`CREATE UNIQUE INDEX IF NOT EXISTS users_username_lower_idx ON users (LOWER(username));`);

        // 4. Games Table
        await client.query(`
            CREATE TABLE IF NOT EXISTS games (
                id SERIAL PRIMARY KEY,
                status VARCHAR(50) NOT NULL DEFAULT 'idle',
                bet_amount INTEGER NOT NULL DEFAULT 0,
                pot INTEGER NOT NULL DEFAULT 0,
                winning_pattern VARCHAR(50) DEFAULT 'any_line',
                winner_id INTEGER REFERENCES users(id),
                created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
            );
        `);
        
        await client.query(`
            DO $$ BEGIN
                IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'games' AND column_name = 'winning_pattern') THEN
                    ALTER TABLE games ADD COLUMN winning_pattern VARCHAR(50) DEFAULT 'any_line';
                END IF;
            END $$;
        `);

        // 5. Player Cards
        await client.query(`
            CREATE TABLE IF NOT EXISTS player_cards (
                id SERIAL PRIMARY KEY,
                user_id INTEGER NOT NULL REFERENCES users(id),
                game_id INTEGER NOT NULL REFERENCES games(id),
                card_data JSONB NOT NULL,
                original_card_id INTEGER,
                created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
                UNIQUE(user_id, game_id, id) 
            );
        `);

        // 6. Deposits
        await client.query(`
            CREATE TABLE IF NOT EXISTS deposits (
                id SERIAL PRIMARY KEY,
                user_id INTEGER REFERENCES users(id),
                telegram_id BIGINT,
                amount INTEGER NOT NULL,
                proof_image_id VARCHAR(255),
                status VARCHAR(50) DEFAULT 'pending',
                request_type VARCHAR(50) DEFAULT 'points',
                package_duration VARCHAR(50),
                created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
            );
        `);

        // 7. Transactions Table
        await client.query(`
            CREATE TABLE IF NOT EXISTS transactions (
                id SERIAL PRIMARY KEY,
                user_id INTEGER REFERENCES users(id),
                type VARCHAR(50) NOT NULL, 
                amount INTEGER NOT NULL,
                related_user_id INTEGER, 
                game_id INTEGER, 
                description TEXT,
                created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
            );
        `);

        // 8. System Settings
        await client.query(`
            CREATE TABLE IF NOT EXISTS system_settings (
                key VARCHAR(50) PRIMARY KEY,
                value TEXT
            );
        `);

        await client.query('COMMIT');
        console.log('✅ Database initialized and verified.');

    } catch (err) {
        await client.query('ROLLBACK');
        console.error('❌ Database initialization error:', err.stack);
        // Don't exit process in dev, might just be connection blip
        if (isProduction) process.exit(1);
    } finally {
        client.release();
    }
}

initializeDatabase();

const logTransaction = async (userId, type, amount, relatedUserId = null, gameId = null, description = '') => {
    try {
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