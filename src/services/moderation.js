const { db } = require('../database');

const LINK_RE = /(https?:\/\/|www\.|t\.me\/|telegram\.me\/|discord\.gg\/|[a-z0-9-]+\.[a-z]{2,})(\S*)/i;

function containsLink(text) {
  return LINK_RE.test(text || '');
}

function containsBannedWord(text, words) {
  const lowered = (text || '').toLowerCase();
  return words.find((item) => lowered.includes(item.word));
}

function getOrCreateGroup(botId, chat) {
  db.prepare(`
    INSERT INTO groups (bot_id, telegram_group_id, title, type)
    VALUES (?, ?, ?, ?)
    ON CONFLICT(bot_id, telegram_group_id) DO UPDATE SET
      title = excluded.title,
      type = excluded.type,
      is_active = 1
  `).run(botId, chat.id, chat.title || '', chat.type);

  return db.prepare('SELECT * FROM groups WHERE bot_id = ? AND telegram_group_id = ?').get(botId, chat.id);
}

function incrementWarning(botId, groupId, userTelegramId) {
  db.prepare(`
    INSERT INTO warnings (bot_id, group_id, user_telegram_id, count)
    VALUES (?, ?, ?, 1)
    ON CONFLICT(bot_id, group_id, user_telegram_id) DO UPDATE SET
      count = count + 1,
      updated_at = CURRENT_TIMESTAMP
  `).run(botId, groupId, userTelegramId);

  return db.prepare(`
    SELECT * FROM warnings
    WHERE bot_id = ? AND group_id = ? AND user_telegram_id = ?
  `).get(botId, groupId, userTelegramId);
}

function resetWarnings(botId, groupId, userTelegramId) {
  db.prepare('DELETE FROM warnings WHERE bot_id = ? AND group_id = ? AND user_telegram_id = ?').run(botId, groupId, userTelegramId);
}

async function safeDeleteMessage(bot, chatId, messageId) {
  try {
    await bot.deleteMessage(chatId, messageId);
  } catch (error) {
    console.warn('deleteMessage failed:', error.message);
  }
}

async function applyPunishment(bot, chatId, userId, settings) {
  try {
    if (settings.punishment === 'ban') {
      await bot.banChatMember(chatId, userId);
      return 'ban';
    }

    const untilDate = Math.floor(Date.now() / 1000) + settings.mute_minutes * 60;
    await bot.restrictChatMember(chatId, userId, {
      until_date: untilDate,
      permissions: {
        can_send_messages: false,
        can_send_audios: false,
        can_send_documents: false,
        can_send_photos: false,
        can_send_videos: false,
        can_send_video_notes: false,
        can_send_voice_notes: false,
        can_send_polls: false,
        can_send_other_messages: false,
        can_add_web_page_previews: false
      }
    });
    return 'mute';
  } catch (error) {
    console.warn('applyPunishment failed:', error.message);
    return null;
  }
}

async function warnUser({ bot, botId, chat, userId, settings, reason }) {
  const group = getOrCreateGroup(botId, chat);
  const warning = incrementWarning(botId, group.id, userId);

  if (warning.count >= settings.max_warnings) {
    const action = await applyPunishment(bot, chat.id, userId, settings);
    resetWarnings(botId, group.id, userId);
    if (action === 'ban') return bot.sendMessage(chat.id, `تم حظر المستخدم بسبب: ${reason}`);
    if (action === 'mute') return bot.sendMessage(chat.id, `تم كتم المستخدم ${settings.mute_minutes} دقيقة بسبب: ${reason}`);
  }

  return bot.sendMessage(chat.id, `تحذير ${warning.count}/${settings.max_warnings}: ${reason}`);
}

class SpamTracker {
  constructor() {
    this.messages = new Map();
  }

  isSpam(chatId, userId, text) {
    const key = `${chatId}:${userId}`;
    const now = Date.now();
    const current = this.messages.get(key) || [];
    const recent = current.filter((item) => now - item.at < 12000);
    recent.push({ text, at: now });
    this.messages.set(key, recent);

    const sameTextCount = recent.filter((item) => item.text === text).length;
    return recent.length >= 6 || sameTextCount >= 3;
  }
}

module.exports = {
  containsLink,
  containsBannedWord,
  getOrCreateGroup,
  incrementWarning,
  resetWarnings,
  safeDeleteMessage,
  applyPunishment,
  warnUser,
  SpamTracker
};
