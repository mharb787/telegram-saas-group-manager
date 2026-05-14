const { db } = require('../database');
const { cleanText, cleanWord, toPositiveInt } = require('../utils/validators');

function createDefaultSettings(botId) {
  db.prepare('INSERT OR IGNORE INTO bot_settings (bot_id) VALUES (?)').run(botId);
}

function getSettings(botId) {
  return db.prepare('SELECT * FROM bot_settings WHERE bot_id = ?').get(botId);
}

function updateSetting(botId, key, value) {
  const allowed = new Set([
    'welcome_message',
    'anti_links',
    'anti_spam',
    'max_warnings',
    'mute_minutes',
    'rules_message',
    'language',
    'auto_replies_enabled',
    'punishment'
  ]);

  if (!allowed.has(key)) {
    throw new Error('Unsupported setting');
  }

  let normalized = value;
  if (['welcome_message', 'rules_message'].includes(key)) normalized = cleanText(value, 1500);
  if (['anti_links', 'anti_spam', 'auto_replies_enabled'].includes(key)) normalized = value ? 1 : 0;
  if (key === 'max_warnings') normalized = toPositiveInt(value, 3, 1, 20);
  if (key === 'mute_minutes') normalized = toPositiveInt(value, 30, 1, 10080);
  if (key === 'language') normalized = value === 'en' ? 'en' : 'ar';
  if (key === 'punishment') normalized = value === 'ban' ? 'ban' : 'mute';

  db.prepare(`UPDATE bot_settings SET ${key} = ?, updated_at = CURRENT_TIMESTAMP WHERE bot_id = ?`).run(normalized, botId);
  return getSettings(botId);
}

function listBannedWords(botId) {
  return db.prepare('SELECT * FROM banned_words WHERE bot_id = ? ORDER BY word').all(botId);
}

function addBannedWord(botId, word) {
  const normalized = cleanWord(word);
  if (!normalized) throw new Error('Invalid word');
  db.prepare('INSERT OR IGNORE INTO banned_words (bot_id, word) VALUES (?, ?)').run(botId, normalized);
  return listBannedWords(botId);
}

function removeBannedWord(botId, word) {
  const normalized = cleanWord(word);
  db.prepare('DELETE FROM banned_words WHERE bot_id = ? AND word = ?').run(botId, normalized);
  return listBannedWords(botId);
}

function listAutoReplies(botId) {
  return db.prepare('SELECT * FROM auto_replies WHERE bot_id = ? ORDER BY keyword').all(botId);
}

function addAutoReply(botId, keyword, response) {
  const safeKeyword = cleanWord(keyword);
  const safeResponse = cleanText(response, 1000);
  if (!safeKeyword || !safeResponse) throw new Error('Invalid auto reply');
  db.prepare(`
    INSERT INTO auto_replies (bot_id, keyword, response)
    VALUES (?, ?, ?)
    ON CONFLICT(bot_id, keyword) DO UPDATE SET response = excluded.response
  `).run(botId, safeKeyword, safeResponse);
  return listAutoReplies(botId);
}

function removeAutoReply(botId, keyword) {
  const safeKeyword = cleanWord(keyword);
  db.prepare('DELETE FROM auto_replies WHERE bot_id = ? AND keyword = ?').run(botId, safeKeyword);
  return listAutoReplies(botId);
}

module.exports = {
  createDefaultSettings,
  getSettings,
  updateSetting,
  listBannedWords,
  addBannedWord,
  removeBannedWord,
  listAutoReplies,
  addAutoReply,
  removeAutoReply
};
