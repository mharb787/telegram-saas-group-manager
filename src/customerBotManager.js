const crypto = require('crypto');
const TelegramBot = require('node-telegram-bot-api');
const CustomerBot = require('./customerBot');
const { db } = require('./database');

const TOKEN_ALGORITHM = 'aes-256-gcm';

function getTokenKey() {
  const secret = process.env.TOKEN_SECRET || 'development_secret_change_me';
  return crypto.createHash('sha256').update(secret).digest();
}

function encryptToken(token) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv(TOKEN_ALGORITHM, getTokenKey(), iv);
  const encrypted = Buffer.concat([cipher.update(token, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `${iv.toString('base64')}:${tag.toString('base64')}:${encrypted.toString('base64')}`;
}

function decryptToken(payload) {
  const [ivRaw, tagRaw, encryptedRaw] = payload.split(':');
  const decipher = crypto.createDecipheriv(TOKEN_ALGORITHM, getTokenKey(), Buffer.from(ivRaw, 'base64'));
  decipher.setAuthTag(Buffer.from(tagRaw, 'base64'));
  return Buffer.concat([
    decipher.update(Buffer.from(encryptedRaw, 'base64')),
    decipher.final()
  ]).toString('utf8');
}

async function verifyToken(token) {
  const probe = new TelegramBot(token, { polling: false });
  return probe.getMe();
}

class CustomerBotManager {
  constructor() {
    this.running = new Map();
  }

  startAll() {
    const bots = db.prepare(`
      SELECT cb.*, u.telegram_id AS owner_telegram_id
      FROM customer_bots cb
      JOIN users u ON u.id = cb.user_id
      WHERE cb.is_active = 1
    `).all();

    for (const bot of bots) {
      this.startBot(bot);
    }
  }

  startBot(customerBot) {
    if (this.running.has(customerBot.id)) return;

    try {
      const token = decryptToken(customerBot.token_encrypted);
      const instance = new CustomerBot(customerBot, token, customerBot.owner_telegram_id);
      this.running.set(customerBot.id, instance);
      console.log(`Started customer bot @${customerBot.username}`);
    } catch (error) {
      console.warn(`Failed to start customer bot ${customerBot.id}:`, error.message);
    }
  }

  stopBot(botId) {
    const instance = this.running.get(botId);
    if (!instance) return;
    instance.stop();
    this.running.delete(botId);
  }
}

module.exports = {
  CustomerBotManager,
  encryptToken,
  decryptToken,
  verifyToken
};
