const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');

const dbPath = process.env.DATABASE_PATH || path.join(process.cwd(), 'data', 'app.sqlite');
const dbDir = path.dirname(dbPath);

if (!fs.existsSync(dbDir)) {
  fs.mkdirSync(dbDir, { recursive: true });
}

const db = new Database(dbPath);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

function migrate() {
  db.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      telegram_id INTEGER NOT NULL UNIQUE,
      username TEXT,
      first_name TEXT,
      language TEXT DEFAULT 'ar',
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS customer_bots (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      telegram_bot_id INTEGER NOT NULL UNIQUE,
      username TEXT NOT NULL,
      first_name TEXT,
      token_encrypted TEXT NOT NULL,
      token_last4 TEXT NOT NULL,
      is_active INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS bot_settings (
      bot_id INTEGER PRIMARY KEY,
      welcome_message TEXT NOT NULL DEFAULT 'مرحبا {name} في المجموعة',
      anti_links INTEGER NOT NULL DEFAULT 1,
      anti_spam INTEGER NOT NULL DEFAULT 1,
      max_warnings INTEGER NOT NULL DEFAULT 3,
      mute_minutes INTEGER NOT NULL DEFAULT 30,
      rules_message TEXT NOT NULL DEFAULT 'يرجى احترام الأعضاء وعدم نشر الروابط أو الرسائل المزعجة.',
      language TEXT NOT NULL DEFAULT 'ar',
      auto_replies_enabled INTEGER NOT NULL DEFAULT 1,
      punishment TEXT NOT NULL DEFAULT 'mute',
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (bot_id) REFERENCES customer_bots(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS groups (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      bot_id INTEGER NOT NULL,
      telegram_group_id INTEGER NOT NULL,
      title TEXT,
      type TEXT,
      is_active INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(bot_id, telegram_group_id),
      FOREIGN KEY (bot_id) REFERENCES customer_bots(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS warnings (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      bot_id INTEGER NOT NULL,
      group_id INTEGER NOT NULL,
      user_telegram_id INTEGER NOT NULL,
      count INTEGER NOT NULL DEFAULT 0,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(bot_id, group_id, user_telegram_id),
      FOREIGN KEY (bot_id) REFERENCES customer_bots(id) ON DELETE CASCADE,
      FOREIGN KEY (group_id) REFERENCES groups(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS banned_words (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      bot_id INTEGER NOT NULL,
      word TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(bot_id, word),
      FOREIGN KEY (bot_id) REFERENCES customer_bots(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS auto_replies (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      bot_id INTEGER NOT NULL,
      keyword TEXT NOT NULL,
      response TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(bot_id, keyword),
      FOREIGN KEY (bot_id) REFERENCES customer_bots(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS subscriptions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      bot_id INTEGER,
      plan TEXT NOT NULL CHECK(plan IN ('basic', 'pro', 'vip')),
      start_date TEXT NOT NULL,
      end_date TEXT NOT NULL,
      status TEXT NOT NULL CHECK(status IN ('active', 'expired')) DEFAULT 'active',
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
      FOREIGN KEY (bot_id) REFERENCES customer_bots(id) ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS idx_customer_bots_user_id ON customer_bots(user_id);
    CREATE INDEX IF NOT EXISTS idx_groups_bot_id ON groups(bot_id);
    CREATE INDEX IF NOT EXISTS idx_warnings_lookup ON warnings(bot_id, group_id, user_telegram_id);
    CREATE INDEX IF NOT EXISTS idx_subscriptions_bot_id ON subscriptions(bot_id);

    CREATE TABLE IF NOT EXISTS real_estate_users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      telegram_id INTEGER NOT NULL UNIQUE,
      username TEXT,
      first_name TEXT,
      display_name TEXT,
      phone TEXT NOT NULL,
      status TEXT NOT NULL CHECK(status IN ('registered', 'blocked')) DEFAULT 'registered',
      gateway_attempts INTEGER NOT NULL DEFAULT 0,
      pending_gateway_chat_id INTEGER,
      pending_gateway_message_id INTEGER,
      pending_gateway_joined_at TEXT,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS real_estate_gateway_visits (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      telegram_id INTEGER NOT NULL,
      chat_id INTEGER NOT NULL,
      joined_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      completed_at TEXT,
      removed_at TEXT
    );

    CREATE TABLE IF NOT EXISTS real_estate_listings (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      public_code TEXT UNIQUE,
      user_telegram_id INTEGER NOT NULL,
      category TEXT NOT NULL,
      listing_type TEXT NOT NULL,
      status TEXT NOT NULL CHECK(status IN ('draft', 'pending', 'published', 'rejected', 'needs_changes')) DEFAULT 'pending',
      payload TEXT NOT NULL,
      photos TEXT NOT NULL,
      admin_message_chat_id INTEGER,
      admin_message_id INTEGER,
      channel_message_id INTEGER,
      review_note TEXT,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS real_estate_meta (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );

    CREATE INDEX IF NOT EXISTS idx_real_estate_users_telegram_id ON real_estate_users(telegram_id);
    CREATE INDEX IF NOT EXISTS idx_real_estate_listings_user ON real_estate_listings(user_telegram_id);
    CREATE INDEX IF NOT EXISTS idx_real_estate_listings_status ON real_estate_listings(status);
  `);

  try {
    db.exec('ALTER TABLE real_estate_users ADD COLUMN pending_gateway_message_id INTEGER');
  } catch (error) {
    if (!String(error.message).includes('duplicate column name')) throw error;
  }
}

module.exports = {
  db,
  migrate
};
