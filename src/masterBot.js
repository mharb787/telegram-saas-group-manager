const TelegramBot = require('node-telegram-bot-api');
const { db } = require('./database');
const { verifyToken, encryptToken } = require('./customerBotManager');
const { createDefaultSettings, getSettings, updateSetting, listBannedWords, addBannedWord, removeBannedWord, listAutoReplies, addAutoReply, removeAutoReply } = require('./services/settings');
const { addDefaultSubscription } = require('./services/subscription');
const { isValidBotToken, isPrivateChat, cleanText } = require('./utils/validators');

const sessions = new Map();

function dashboardKeyboard(botId) {
  return {
    inline_keyboard: [
      [
        { text: 'رسالة الترحيب', callback_data: `set:welcome_message:${botId}` },
        { text: 'قوانين المجموعة', callback_data: `set:rules_message:${botId}` }
      ],
      [
        { text: 'منع الروابط', callback_data: `toggle:anti_links:${botId}` },
        { text: 'منع السبام', callback_data: `toggle:anti_spam:${botId}` }
      ],
      [
        { text: 'الكلمات الممنوعة', callback_data: `menu:banned:${botId}` },
        { text: 'الردود التلقائية', callback_data: `menu:replies:${botId}` }
      ],
      [
        { text: 'عدد الإنذارات', callback_data: `set:max_warnings:${botId}` },
        { text: 'مدة الكتم', callback_data: `set:mute_minutes:${botId}` }
      ],
      [
        { text: 'العقوبة: كتم/حظر', callback_data: `punishment:toggle:${botId}` }
      ],
      [
        { text: 'العربية', callback_data: `lang:ar:${botId}` },
        { text: 'English', callback_data: `lang:en:${botId}` }
      ],
      [
        { text: 'تحديث اللوحة', callback_data: `dashboard:${botId}` }
      ]
    ]
  };
}

function getUserBots(userId) {
  return db.prepare(`
    SELECT cb.*
    FROM customer_bots cb
    JOIN users u ON u.id = cb.user_id
    WHERE u.telegram_id = ?
    ORDER BY cb.id DESC
  `).all(userId);
}

function upsertUser(from) {
  db.prepare(`
    INSERT INTO users (telegram_id, username, first_name, language)
    VALUES (?, ?, ?, ?)
    ON CONFLICT(telegram_id) DO UPDATE SET
      username = excluded.username,
      first_name = excluded.first_name
  `).run(from.id, from.username || '', from.first_name || '', from.language_code === 'en' ? 'en' : 'ar');

  return db.prepare('SELECT * FROM users WHERE telegram_id = ?').get(from.id);
}

function formatSettings(botRecord) {
  const settings = getSettings(botRecord.id);
  const words = listBannedWords(botRecord.id).map((item) => item.word).join(', ') || 'لا يوجد';
  const repliesCount = listAutoReplies(botRecord.id).length;

  return [
    `لوحة بوت @${botRecord.username}`,
    '',
    `الترحيب: ${settings.welcome_message}`,
    `منع الروابط: ${settings.anti_links ? 'مفعل' : 'متوقف'}`,
    `منع السبام: ${settings.anti_spam ? 'مفعل' : 'متوقف'}`,
    `الكلمات الممنوعة: ${words}`,
    `الإنذارات قبل العقوبة: ${settings.max_warnings}`,
    `مدة الكتم: ${settings.mute_minutes} دقيقة`,
    `العقوبة بعد الإنذارات: ${settings.punishment === 'ban' ? 'حظر' : 'كتم'}`,
    `القوانين: ${settings.rules_message}`,
    `اللغة: ${settings.language}`,
    `الردود التلقائية: ${settings.auto_replies_enabled ? 'مفعلة' : 'متوقفة'} (${repliesCount})`
  ].join('\n');
}

function createMasterBot(customerBotManager) {
  if (!process.env.MASTER_BOT_TOKEN) {
    throw new Error('MASTER_BOT_TOKEN is required');
  }

  const bot = new TelegramBot(process.env.MASTER_BOT_TOKEN, { polling: true });

  bot.onText(/^\/start/, async (msg) => {
    if (!isPrivateChat(msg)) return;
    const user = upsertUser(msg.from);
    const bots = getUserBots(msg.from.id);

    if (!bots.length) {
      sessions.set(msg.from.id, { action: 'awaiting_token' });
      return bot.sendMessage(msg.chat.id, [
        'مرحبا بك في Master Bot.',
        'أرسل Bot Token الخاص ببوت العميل من BotFather لربطه.',
        'لن يتم عرض التوكن مرة أخرى بعد حفظه.'
      ].join('\n'));
    }

    const keyboard = {
      inline_keyboard: [
        ...bots.map((item) => [{ text: `@${item.username}`, callback_data: `dashboard:${item.id}` }]),
        [{ text: 'ربط بوت جديد', callback_data: 'connect:new' }]
      ]
    };
    return bot.sendMessage(msg.chat.id, `أهلا ${user.first_name || ''}. اختر بوتاً لإدارته:`, { reply_markup: keyboard });
  });

  bot.on('message', async (msg) => {
    if (!isPrivateChat(msg) || !msg.text || msg.text.startsWith('/')) return;

    const session = sessions.get(msg.from.id);
    if (!session) return;

    try {
      if (session.action === 'awaiting_token') {
        const token = cleanText(msg.text, 200);
        if (!isValidBotToken(token)) {
          return bot.sendMessage(msg.chat.id, 'صيغة التوكن غير صحيحة. أرسل التوكن كما هو من BotFather.');
        }

        const me = await verifyToken(token);
        if (!me || !me.id || !me.username) {
          return bot.sendMessage(msg.chat.id, 'تعذر التحقق من التوكن.');
        }

        const user = upsertUser(msg.from);
        const encrypted = encryptToken(token);
        const result = db.prepare(`
          INSERT INTO customer_bots (user_id, telegram_bot_id, username, first_name, token_encrypted, token_last4)
          VALUES (?, ?, ?, ?, ?, ?)
        `).run(user.id, me.id, me.username, me.first_name || '', encrypted, token.slice(-4));

        createDefaultSettings(result.lastInsertRowid);
        addDefaultSubscription(user.id, result.lastInsertRowid);

        const customerBot = db.prepare(`
          SELECT cb.*, u.telegram_id AS owner_telegram_id
          FROM customer_bots cb
          JOIN users u ON u.id = cb.user_id
          WHERE cb.id = ?
        `).get(result.lastInsertRowid);
        customerBotManager.startBot(customerBot);

        sessions.delete(msg.from.id);
        return bot.sendMessage(msg.chat.id, `تم ربط بوت @${me.username} بنجاح.`, {
          reply_markup: dashboardKeyboard(result.lastInsertRowid)
        });
      }

      if (session.action === 'set_setting') {
        updateSetting(session.botId, session.key, msg.text);
        sessions.delete(msg.from.id);
        const customerBot = db.prepare('SELECT * FROM customer_bots WHERE id = ?').get(session.botId);
        return bot.sendMessage(msg.chat.id, formatSettings(customerBot), { reply_markup: dashboardKeyboard(session.botId) });
      }

      if (session.action === 'add_banned_word') {
        addBannedWord(session.botId, msg.text);
        sessions.delete(msg.from.id);
        return bot.sendMessage(msg.chat.id, 'تمت إضافة الكلمة الممنوعة.');
      }

      if (session.action === 'remove_banned_word') {
        removeBannedWord(session.botId, msg.text);
        sessions.delete(msg.from.id);
        return bot.sendMessage(msg.chat.id, 'تم حذف الكلمة إن كانت موجودة.');
      }

      if (session.action === 'add_auto_reply_keyword') {
        sessions.set(msg.from.id, { action: 'add_auto_reply_response', botId: session.botId, keyword: msg.text });
        return bot.sendMessage(msg.chat.id, 'أرسل نص الرد التلقائي.');
      }

      if (session.action === 'add_auto_reply_response') {
        addAutoReply(session.botId, session.keyword, msg.text);
        sessions.delete(msg.from.id);
        return bot.sendMessage(msg.chat.id, 'تم حفظ الرد التلقائي.');
      }

      if (session.action === 'remove_auto_reply') {
        removeAutoReply(session.botId, msg.text);
        sessions.delete(msg.from.id);
        return bot.sendMessage(msg.chat.id, 'تم حذف الرد التلقائي إن كان موجوداً.');
      }
    } catch (error) {
      console.warn('Master message handler failed:', error.message);
      sessions.delete(msg.from.id);
      return bot.sendMessage(msg.chat.id, 'حدث خطأ أثناء تنفيذ الطلب. حاول مرة أخرى.');
    }
  });

  bot.on('callback_query', async (query) => {
    const data = query.data || '';
    const chatId = query.message.chat.id;
    const fromId = query.from.id;

    try {
      if (data === 'connect:new') {
        sessions.set(fromId, { action: 'awaiting_token' });
        await bot.answerCallbackQuery(query.id);
        return bot.sendMessage(chatId, 'أرسل Bot Token الخاص بالبوت الجديد.');
      }

      const [action, key, rawBotId] = data.split(':');
      const botId = Number(rawBotId || key);
      const customerBot = db.prepare(`
        SELECT cb.*
        FROM customer_bots cb
        JOIN users u ON u.id = cb.user_id
        WHERE cb.id = ? AND u.telegram_id = ?
      `).get(botId, fromId);

      if (!customerBot) {
        await bot.answerCallbackQuery(query.id, { text: 'غير مصرح' });
        return;
      }

      if (action === 'dashboard') {
        await bot.answerCallbackQuery(query.id);
        return bot.sendMessage(chatId, formatSettings(customerBot), { reply_markup: dashboardKeyboard(botId) });
      }

      if (action === 'toggle') {
        const settings = getSettings(botId);
        updateSetting(botId, key, !settings[key]);
        await bot.answerCallbackQuery(query.id, { text: 'تم التحديث' });
        return bot.sendMessage(chatId, formatSettings(customerBot), { reply_markup: dashboardKeyboard(botId) });
      }

      if (action === 'lang') {
        updateSetting(botId, 'language', key);
        await bot.answerCallbackQuery(query.id, { text: 'تم تغيير اللغة' });
        return bot.sendMessage(chatId, formatSettings(customerBot), { reply_markup: dashboardKeyboard(botId) });
      }

      if (action === 'punishment') {
        const settings = getSettings(botId);
        updateSetting(botId, 'punishment', settings.punishment === 'ban' ? 'mute' : 'ban');
        await bot.answerCallbackQuery(query.id, { text: 'تم تغيير العقوبة' });
        return bot.sendMessage(chatId, formatSettings(customerBot), { reply_markup: dashboardKeyboard(botId) });
      }

      if (action === 'set') {
        sessions.set(fromId, { action: 'set_setting', botId, key });
        await bot.answerCallbackQuery(query.id);
        return bot.sendMessage(chatId, 'أرسل القيمة الجديدة الآن.');
      }

      if (action === 'menu' && key === 'banned') {
        await bot.answerCallbackQuery(query.id);
        return bot.sendMessage(chatId, 'إدارة الكلمات الممنوعة:', {
          reply_markup: {
            inline_keyboard: [
              [{ text: 'إضافة كلمة', callback_data: `banned:add:${botId}` }],
              [{ text: 'حذف كلمة', callback_data: `banned:remove:${botId}` }]
            ]
          }
        });
      }

      if (action === 'menu' && key === 'replies') {
        await bot.answerCallbackQuery(query.id);
        return bot.sendMessage(chatId, 'إدارة الردود التلقائية:', {
          reply_markup: {
            inline_keyboard: [
              [{ text: 'إضافة رد', callback_data: `reply:add:${botId}` }],
              [{ text: 'حذف رد', callback_data: `reply:remove:${botId}` }],
              [{ text: 'تشغيل/إيقاف', callback_data: `toggle:auto_replies_enabled:${botId}` }]
            ]
          }
        });
      }

      if (action === 'banned') {
        sessions.set(fromId, { action: key === 'add' ? 'add_banned_word' : 'remove_banned_word', botId });
        await bot.answerCallbackQuery(query.id);
        return bot.sendMessage(chatId, key === 'add' ? 'أرسل الكلمة المراد منعها.' : 'أرسل الكلمة المراد حذفها.');
      }

      if (action === 'reply') {
        sessions.set(fromId, { action: key === 'add' ? 'add_auto_reply_keyword' : 'remove_auto_reply', botId });
        await bot.answerCallbackQuery(query.id);
        return bot.sendMessage(chatId, key === 'add' ? 'أرسل الكلمة المفتاحية.' : 'أرسل الكلمة المفتاحية للرد المراد حذفه.');
      }
    } catch (error) {
      console.warn('callback handler failed:', error.message);
      await bot.answerCallbackQuery(query.id, { text: 'حدث خطأ' });
    }
  });

  bot.on('polling_error', (error) => {
    console.warn('Master bot polling error:', error.message);
  });

  return bot;
}

module.exports = {
  createMasterBot
};
