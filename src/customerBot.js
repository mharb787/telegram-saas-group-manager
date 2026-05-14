const TelegramBot = require('node-telegram-bot-api');
const { db } = require('./database');
const { getSettings, listBannedWords, listAutoReplies } = require('./services/settings');
const { isSubscriptionActive } = require('./services/subscription');
const {
  containsLink,
  containsBannedWord,
  getOrCreateGroup,
  safeDeleteMessage,
  warnUser,
  applyPunishment,
  resetWarnings,
  SpamTracker
} = require('./services/moderation');
const { isGroupChat, toPositiveInt } = require('./utils/validators');

async function isAdmin(bot, chatId, userId) {
  try {
    const member = await bot.getChatMember(chatId, userId);
    return ['creator', 'administrator'].includes(member.status);
  } catch (error) {
    console.warn('getChatMember failed:', error.message);
    return false;
  }
}

function targetUserFromReply(msg) {
  return msg.reply_to_message && msg.reply_to_message.from ? msg.reply_to_message.from.id : null;
}

class CustomerBot {
  constructor(customerBot, token, ownerTelegramId) {
    this.customerBot = customerBot;
    this.ownerTelegramId = ownerTelegramId;
    this.spamTracker = new SpamTracker();
    this.bot = new TelegramBot(token, { polling: true });
    this.registerHandlers();
  }

  async ensureSubscription(chatId) {
    if (isSubscriptionActive(this.customerBot.id)) return true;

    try {
      await this.bot.sendMessage(this.ownerTelegramId, `اشتراك بوت @${this.customerBot.username} منتهي. يرجى تجديد الاشتراك لإعادة تشغيله.`);
    } catch (error) {
      console.warn('notify owner failed:', error.message);
    }

    if (chatId) {
      await this.bot.sendMessage(chatId, 'اشتراك هذا البوت منتهي حالياً.');
    }
    return false;
  }

  registerHandlers() {
    this.bot.on('new_chat_members', (msg) => this.onNewMembers(msg));
    this.bot.on('message', (msg) => this.onMessage(msg));
    this.bot.onText(/^\/rules(@\w+)?/, (msg) => this.sendRules(msg));
    this.bot.onText(/^\/settings(@\w+)?/, (msg) => this.sendSettings(msg));
    this.bot.onText(/^\/warn(@\w+)?/, (msg) => this.adminWarn(msg));
    this.bot.onText(/^\/mute(@\w+)?(?:\s+(\d+))?/, (msg, match) => this.adminMute(msg, match));
    this.bot.onText(/^\/ban(@\w+)?/, (msg) => this.adminBan(msg));
    this.bot.onText(/^\/unban(@\w+)?(?:\s+(\d+))?/, (msg, match) => this.adminUnban(msg, match));

    this.bot.on('polling_error', (error) => {
      console.warn(`Customer bot @${this.customerBot.username} polling error:`, error.message);
    });
  }

  async onNewMembers(msg) {
    if (!isGroupChat(msg) || !(await this.ensureSubscription(msg.chat.id))) return;

    const settings = getSettings(this.customerBot.id);
    getOrCreateGroup(this.customerBot.id, msg.chat);

    for (const member of msg.new_chat_members || []) {
      if (member.is_bot) continue;
      const name = member.first_name || member.username || 'عضو جديد';
      const welcome = settings.welcome_message.replace('{name}', name);
      await this.bot.sendMessage(msg.chat.id, welcome);
    }
  }

  async onMessage(msg) {
    if (!isGroupChat(msg) || !msg.from || msg.from.is_bot) return;
    if (msg.text && msg.text.startsWith('/')) return;
    if (!(await this.ensureSubscription(msg.chat.id))) return;

    const settings = getSettings(this.customerBot.id);
    const text = msg.text || msg.caption || '';
    if (!text) return;

    getOrCreateGroup(this.customerBot.id, msg.chat);

    const replies = settings.auto_replies_enabled ? listAutoReplies(this.customerBot.id) : [];
    const matchedReply = replies.find((reply) => text.toLowerCase().includes(reply.keyword));
    if (matchedReply) {
      await this.bot.sendMessage(msg.chat.id, matchedReply.response, { reply_to_message_id: msg.message_id });
    }

    if (settings.anti_links && containsLink(text)) {
      await safeDeleteMessage(this.bot, msg.chat.id, msg.message_id);
      await warnUser({ bot: this.bot, botId: this.customerBot.id, chat: msg.chat, userId: msg.from.id, settings, reason: 'نشر روابط' });
      return;
    }

    const bannedWord = containsBannedWord(text, listBannedWords(this.customerBot.id));
    if (bannedWord) {
      await safeDeleteMessage(this.bot, msg.chat.id, msg.message_id);
      await warnUser({ bot: this.bot, botId: this.customerBot.id, chat: msg.chat, userId: msg.from.id, settings, reason: `كلمة ممنوعة: ${bannedWord.word}` });
      return;
    }

    if (settings.anti_spam && this.spamTracker.isSpam(msg.chat.id, msg.from.id, text)) {
      await safeDeleteMessage(this.bot, msg.chat.id, msg.message_id);
      await warnUser({ bot: this.bot, botId: this.customerBot.id, chat: msg.chat, userId: msg.from.id, settings, reason: 'سبام' });
    }
  }

  async sendRules(msg) {
    if (!isGroupChat(msg) || !(await this.ensureSubscription(msg.chat.id))) return;
    const settings = getSettings(this.customerBot.id);
    await this.bot.sendMessage(msg.chat.id, settings.rules_message);
  }

  async sendSettings(msg) {
    if (!isGroupChat(msg) || !(await this.ensureSubscription(msg.chat.id))) return;
    if (!(await isAdmin(this.bot, msg.chat.id, msg.from.id))) return;
    const settings = getSettings(this.customerBot.id);
    await this.bot.sendMessage(msg.chat.id, [
      `Anti links: ${settings.anti_links ? 'ON' : 'OFF'}`,
      `Anti spam: ${settings.anti_spam ? 'ON' : 'OFF'}`,
      `Max warnings: ${settings.max_warnings}`,
      `Mute minutes: ${settings.mute_minutes}`,
      `Language: ${settings.language}`
    ].join('\n'));
  }

  async adminWarn(msg) {
    if (!isGroupChat(msg) || !(await this.ensureSubscription(msg.chat.id))) return;
    if (!(await isAdmin(this.bot, msg.chat.id, msg.from.id))) return;
    const userId = targetUserFromReply(msg);
    if (!userId) return this.bot.sendMessage(msg.chat.id, 'استخدم الأمر كرد على رسالة المستخدم.');
    const settings = getSettings(this.customerBot.id);
    return warnUser({ bot: this.bot, botId: this.customerBot.id, chat: msg.chat, userId, settings, reason: 'تحذير من المشرف' });
  }

  async adminMute(msg, match) {
    if (!isGroupChat(msg) || !(await this.ensureSubscription(msg.chat.id))) return;
    if (!(await isAdmin(this.bot, msg.chat.id, msg.from.id))) return;
    const userId = targetUserFromReply(msg);
    if (!userId) return this.bot.sendMessage(msg.chat.id, 'استخدم الأمر كرد على رسالة المستخدم.');
    const settings = getSettings(this.customerBot.id);
    settings.mute_minutes = toPositiveInt(match && match[2], settings.mute_minutes, 1, 10080);
    await applyPunishment(this.bot, msg.chat.id, userId, { ...settings, punishment: 'mute' });
    return this.bot.sendMessage(msg.chat.id, `تم كتم المستخدم ${settings.mute_minutes} دقيقة.`);
  }

  async adminBan(msg) {
    if (!isGroupChat(msg) || !(await this.ensureSubscription(msg.chat.id))) return;
    if (!(await isAdmin(this.bot, msg.chat.id, msg.from.id))) return;
    const userId = targetUserFromReply(msg);
    if (!userId) return this.bot.sendMessage(msg.chat.id, 'استخدم الأمر كرد على رسالة المستخدم.');
    await applyPunishment(this.bot, msg.chat.id, userId, { punishment: 'ban' });
    return this.bot.sendMessage(msg.chat.id, 'تم حظر المستخدم.');
  }

  async adminUnban(msg, match) {
    if (!isGroupChat(msg) || !(await this.ensureSubscription(msg.chat.id))) return;
    if (!(await isAdmin(this.bot, msg.chat.id, msg.from.id))) return;
    const userId = targetUserFromReply(msg) || (match && match[2]);
    if (!userId) return this.bot.sendMessage(msg.chat.id, 'استخدم الأمر كرد على رسالة المستخدم أو اكتب ID بعد الأمر.');

    try {
      await this.bot.unbanChatMember(msg.chat.id, Number(userId), { only_if_banned: true });
      const group = getOrCreateGroup(this.customerBot.id, msg.chat);
      resetWarnings(this.customerBot.id, group.id, Number(userId));
      return this.bot.sendMessage(msg.chat.id, 'تم إلغاء الحظر وتصفير الإنذارات.');
    } catch (error) {
      console.warn('unban failed:', error.message);
      return this.bot.sendMessage(msg.chat.id, 'تعذر إلغاء الحظر.');
    }
  }

  stop() {
    return this.bot.stopPolling();
  }
}

module.exports = CustomerBot;
