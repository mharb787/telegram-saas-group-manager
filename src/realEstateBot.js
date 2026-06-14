const TelegramBot = require('node-telegram-bot-api');
const { db } = require('./database');

const sessions = new Map();
const pendingTimers = new Map();

const categories = {
  apartment: 'شقة',
  house: 'منزل',
  land: 'أرض',
  garage: 'كراج',
  roof: 'رووف'
};

const landKinds = {
  residential: 'سكنية',
  commercial: 'تجارية',
  agricultural: 'زراعية',
  unknown: 'غير محدد'
};

const currencies = {
  usd: 'دولار أمريكي',
  jod: 'دينار أردني',
  ils: 'شيكل إسرائيلي'
};

const regions = {
  north_gaza: 'شمال غزة',
  gaza_city: 'غزة المدينة',
  central: 'الوسطى',
  khan_younis: 'خانيونس',
  rafah: 'رفح'
};

const subregions = {
  north_gaza: {
    beit_lahia: 'بيت لاهيا',
    jabalia: 'جباليا',
    beit_hanoun: 'بيت حانون'
  },
  gaza_city: {
    east_gaza: 'شرق غزة',
    west_gaza: 'غرب غزة'
  },
  central: {
    nuseirat: 'النصيرات',
    bureij: 'البريج',
    deir_al_balah: 'دير البلح',
    maghazi: 'المغازي',
    zawaida: 'الزوايدة'
  },
  khan_younis: {
    east_khan_younis: 'شرق خانيونس',
    west_khan_younis: 'غرب خانيونس'
  },
  rafah: {
    east_rafah: 'شرق رفح',
    west_rafah: 'غرب رفح'
  }
};

function envNumber(name, fallback) {
  const value = Number.parseInt(process.env[name] || '', 10);
  return Number.isFinite(value) ? value : fallback;
}

function envChatId(name, fallback = '') {
  const value = process.env[name];
  if (!value) return fallback;
  const trimmed = value.trim();
  if (trimmed.startsWith('@')) return trimmed;
  const numeric = Number.parseInt(trimmed, 10);
  return Number.isFinite(numeric) ? numeric : trimmed;
}

function requiredEnv(name) {
  if (!process.env[name]) throw new Error(`${name} is required for real estate mode`);
  return process.env[name];
}

function isPrivate(msg) {
  return msg.chat && msg.chat.type === 'private';
}

function isGatewayChat(chatId, config) {
  if (!config.gatewayGroupId) return true;
  return String(chatId) === String(config.gatewayGroupId);
}

function mainMenu() {
  return {
    inline_keyboard: [
      [
        { text: 'عرض عقار', callback_data: 'menu:submit' },
        { text: 'الدخول إلى مجموعة العروض', callback_data: 'menu:offers_group' }
      ],
      [
        { text: 'إعلاناتي', callback_data: 'menu:mine' },
        { text: 'تعديل بياناتي', callback_data: 'menu:profile' }
      ]
    ]
  };
}

function userKeyboard() {
  return {
    keyboard: [
      [{ text: 'عرض عقار' }, { text: 'إعلاناتي' }],
      [{ text: 'تعديل البروفايل' }, { text: 'الدخول للمجموعة' }],
      [{ text: 'حذف الحساب' }]
    ],
    resize_keyboard: true,
    is_persistent: true
  };
}

function contactKeyboard() {
  return {
    keyboard: [[{ text: 'مشاركة رقم الهاتف', request_contact: true }]],
    resize_keyboard: true,
    one_time_keyboard: true
  };
}

function deleteAccount(telegramId) {
  db.prepare('DELETE FROM real_estate_users WHERE telegram_id = ?').run(telegramId);
}

function removeKeyboard() {
  return { remove_keyboard: true };
}

function upsertVisit(telegramId, chatId) {
  db.prepare(`
    INSERT INTO real_estate_gateway_visits (telegram_id, chat_id)
    VALUES (?, ?)
  `).run(telegramId, chatId);
}

function getUser(telegramId) {
  return db.prepare('SELECT * FROM real_estate_users WHERE telegram_id = ?').get(telegramId);
}

function isRegistered(telegramId) {
  const user = getUser(telegramId);
  return Boolean(user && user.status === 'registered' && user.phone && user.display_name);
}

function isBlocked(telegramId) {
  const user = getUser(telegramId);
  return Boolean(user && user.status === 'blocked');
}

function touchGatewayAttempt(member, chatId) {
  const existing = getUser(member.id);
  if (!existing) {
    db.prepare(`
      INSERT INTO real_estate_users
        (telegram_id, username, first_name, display_name, phone, gateway_attempts, pending_gateway_chat_id, pending_gateway_joined_at)
      VALUES (?, ?, ?, '', '', 1, ?, CURRENT_TIMESTAMP)
    `).run(member.id, member.username || '', member.first_name || '', chatId);
    return 1;
  }

  const attempts = existing.gateway_attempts + 1;
  db.prepare(`
    UPDATE real_estate_users
    SET username = ?, first_name = ?, gateway_attempts = ?, pending_gateway_chat_id = ?,
        pending_gateway_joined_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP
    WHERE telegram_id = ?
  `).run(member.username || '', member.first_name || '', attempts, chatId, member.id);
  return attempts;
}

function markRegistered(from, phone, displayName) {
  db.prepare(`
    INSERT INTO real_estate_users
      (telegram_id, username, first_name, display_name, phone, status, pending_gateway_chat_id)
    VALUES (?, ?, ?, ?, ?, 'registered', NULL)
    ON CONFLICT(telegram_id) DO UPDATE SET
      username = excluded.username,
      first_name = excluded.first_name,
      display_name = excluded.display_name,
      phone = excluded.phone,
      status = 'registered',
      pending_gateway_chat_id = NULL,
      updated_at = CURRENT_TIMESTAMP
  `).run(from.id, from.username || '', from.first_name || '', displayName, phone);

  db.prepare(`
    UPDATE real_estate_gateway_visits
    SET completed_at = CURRENT_TIMESTAMP
    WHERE telegram_id = ? AND completed_at IS NULL
  `).run(from.id);
}

function blockUser(telegramId) {
  db.prepare(`
    UPDATE real_estate_users
    SET status = 'blocked', updated_at = CURRENT_TIMESTAMP
    WHERE telegram_id = ?
  `).run(telegramId);
}

function nextListingCode() {
  const row = db.prepare('SELECT seq FROM sqlite_sequence WHERE name = ?').get('real_estate_listings');
  const next = ((row && row.seq) || 0) + 1;
  return `A${String(next).padStart(4, '0')}`;
}

function rows(items, perRow = 2) {
  const result = [];
  for (let index = 0; index < items.length; index += perRow) {
    result.push(items.slice(index, index + perRow));
  }
  return result;
}

function withCancel(inlineKeyboard) {
  return [...inlineKeyboard, [{ text: 'إلغاء', callback_data: 'flow:cancel' }]];
}

function escapeHtml(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function promptOptions(inlineKeyboard) {
  return {
    parse_mode: 'HTML',
    reply_markup: {
      inline_keyboard: withCancel(inlineKeyboard)
    }
  };
}

function deletePrompt(bot, query) {
  if (!query.message) return Promise.resolve();
  return bot.deleteMessage(query.message.chat.id, query.message.message_id).catch(() => {});
}

function valueLabel(key, value) {
  if (key === 'category') return categories[value] || value;
  if (key === 'listing_type') return value === 'sale' ? 'بيع' : 'إيجار';
  if (key === 'roof_state') return value === 'open' ? 'مساحة مفتوحة' : 'بناء قائم';
  if (key === 'has_extra_land') return value === 'yes' ? 'نعم' : 'لا';
  if (key === 'land_kind') return landKinds[value] || value;
  if (key === 'currency') return currencies[value] || value;
  if (key === 'region') return regions[value] || value;
  if (key === 'subregion') {
    for (const options of Object.values(subregions)) {
      if (options[value]) return options[value];
    }
    return value;
  }
  return value;
}

function progressLines(session) {
  const labels = {
    category: '🏷️ نوع العقار',
    listing_type: '📌 نوع العرض',
    roof_state: '🏗️ حالة الرووف',
    floors: '🏢 عدد الطوابق',
    land_area: '📐 مساحة الأرض',
    building_area: '🏠 مساحة البناء',
    bathrooms: '🚿 عدد الحمامات',
    rooms: '🛏️ عدد الغرف',
    has_extra_land: '🌿 أرض/حديقة إضافية',
    extra_land_area: '🌿 مساحة الإضافي',
    area: '📐 المساحة',
    floor: '🏢 الطابق',
    street_width: '🛣️ عرض الشارع',
    land_kind: '🧭 نوع الأرض',
    region: '📍 المنطقة',
    subregion: '📍 المنطقة الفرعية',
    address_detail: '📝 العنوان التفصيلي',
    currency: '💱 العملة',
    price_value: '💰 قيمة السعر',
    contact_phone: '☎️ رقم التواصل',
    notes: '🗒️ ملاحظات'
  };

  return Object.keys(labels)
    .filter((key) => session.data[key] && session.data[key] !== '-')
    .map((key) => `${escapeHtml(labels[key])}: ${escapeHtml(valueLabel(key, session.data[key]))}`);
}

function promptText(session, question) {
  const lines = progressLines(session);
  const formattedQuestion = `❓ <b>${escapeHtml(question)}</b>`;
  if (!lines.length) return formattedQuestion;
  return `${lines.join('\n')}\n\n${formattedQuestion}`;
}

function askCategory(bot, chatId) {
  return bot.sendMessage(chatId, '❓ <b>اختر نوع العقار:</b>', {
    parse_mode: 'HTML',
    reply_markup: {
      inline_keyboard: [
        [
          { text: 'شقة', callback_data: 'cat:apartment' },
          { text: 'منزل', callback_data: 'cat:house' },
          { text: 'أرض', callback_data: 'cat:land' },
          { text: 'كراج', callback_data: 'cat:garage' },
          { text: 'رووف', callback_data: 'cat:roof' }
        ],
        [{ text: 'إلغاء', callback_data: 'flow:cancel' }]
      ]
    }
  });
}

function askListingType(bot, chatId) {
  const session = sessions.get(chatId);
  return bot.sendMessage(chatId, promptText(session, 'اختر نوع العرض:'), promptOptions([[
    { text: 'بيع', callback_data: 'type:sale' },
    { text: 'إيجار', callback_data: 'type:rent' }
  ]]));
}

function questionPlan(session) {
  const commonTail = [
    ['region', 'اختر المنطقة:'],
    ['subregion', 'اختر المنطقة الفرعية:'],
    ['address_detail', 'اكتب العنوان التفصيلي:'],
    ['currency', 'اختر عملة السعر:'],
    ['price_value', 'اكتب قيمة السعر. السعر إلزامي:'],
    ['contact', 'اختر رقم التواصل:'],
    ['notes', 'اكتب ملاحظات إضافية أو أرسل "-" للتخطي:'],
    ['photos', 'أرسل صورة واحدة على الأقل للعقار. يمكنك إرسال أكثر من صورة، ثم اضغط تم.']
  ];

  const byCategory = {
    house: [
      ['floors', 'كم عدد الطوابق؟'],
      ['land_area', 'ما مساحة الأرض بالمتر المربع؟'],
      ['building_area', 'ما مساحة البناء بالمتر المربع؟'],
      ['bathrooms', 'كم عدد الحمامات؟'],
      ['rooms', 'كم عدد الغرف؟'],
      ['has_extra_land', 'هل يوجد أرض/حديقة إضافية؟']
    ],
    apartment: [
      ['area', 'ما المساحة بالمتر المربع؟'],
      ['rooms', 'كم عدد الغرف؟'],
      ['bathrooms', 'كم عدد الحمامات؟'],
      ['floor', 'في أي طابق؟']
    ],
    land: [
      ['area', 'ما مساحة الأرض بالمتر المربع؟'],
      ['street_width', 'كم عرض الشارع بالمتر؟'],
      ['land_kind', 'اختر نوع الأرض:']
    ],
    garage: [
      ['area', 'ما المساحة بالمتر المربع؟']
    ],
    roof: session.data.roof_state === 'open'
      ? [['area', 'ما المساحة بالمتر المربع؟']]
      : [
        ['area', 'ما المساحة بالمتر المربع؟'],
        ['rooms', 'كم عدد الغرف؟'],
        ['bathrooms', 'كم عدد الحمامات؟']
      ]
  };

  const plan = [...byCategory[session.category], ...commonTail];
  if (session.data.has_extra_land === 'yes' && !plan.find(([key]) => key === 'extra_land_area')) {
    const index = plan.findIndex(([key]) => key === 'has_extra_land');
    plan.splice(index + 1, 0, ['extra_land_area', 'ما مساحة الأرض/الحديقة الإضافية بالمتر المربع؟']);
  }
  return plan;
}

function currentQuestion(session) {
  return questionPlan(session)[session.stepIndex];
}

function contactChoice(bot, chatId) {
  const session = sessions.get(chatId);
  return bot.sendMessage(chatId, promptText(session, 'اختر رقم التواصل:'), promptOptions([[
    { text: 'استخدام رقمي المسجل', callback_data: 'contact:registered' },
    { text: 'إضافة رقم آخر للتواصل', callback_data: 'contact:other' }
  ]]));
}

function landKindChoice(bot, chatId) {
  const session = sessions.get(chatId);
  return bot.sendMessage(chatId, promptText(session, 'اختر نوع الأرض:'), promptOptions([[
    { text: 'سكنية', callback_data: 'landkind:residential' },
    { text: 'تجارية', callback_data: 'landkind:commercial' },
    { text: 'زراعية', callback_data: 'landkind:agricultural' },
    { text: 'غير محدد', callback_data: 'landkind:unknown' }
  ]]));
}

function yesNo(bot, chatId, key) {
  const session = sessions.get(chatId);
  return bot.sendMessage(chatId, promptText(session, 'اختر:'), promptOptions([[
    { text: 'نعم', callback_data: `${key}:yes` },
    { text: 'لا', callback_data: `${key}:no` }
  ]]));
}

function roofStateChoice(bot, chatId) {
  const session = sessions.get(chatId);
  return bot.sendMessage(chatId, promptText(session, 'ما حالة الرووف؟'), promptOptions([[
    { text: 'بناء قائم', callback_data: 'roof:built' },
    { text: 'مساحة مفتوحة', callback_data: 'roof:open' }
  ]]));
}

function regionChoice(bot, chatId) {
  const session = sessions.get(chatId);
  return bot.sendMessage(chatId, promptText(session, 'اختر المنطقة:'), promptOptions(
    rows(Object.entries(regions).map(([key, text]) => ({ text, callback_data: `region:${key}` })), 5)
  ));
}

function subregionChoice(bot, chatId, session) {
  const options = subregions[session.data.region] || {};
  return bot.sendMessage(chatId, promptText(session, 'اختر المنطقة الفرعية:'), promptOptions(
    rows(Object.entries(options).map(([key, text]) => ({ text, callback_data: `subregion:${key}` })), 5)
  ));
}

function currencyChoice(bot, chatId) {
  const session = sessions.get(chatId);
  return bot.sendMessage(chatId, promptText(session, 'اختر عملة السعر:'), promptOptions(
    rows(Object.entries(currencies).map(([key, text]) => ({ text, callback_data: `currency:${key}` })), 3)
  ));
}

function numberChoice(bot, chatId, session, key, question) {
  return bot.sendMessage(chatId, promptText(session, `${question}\nيمكنك اختيار رقم أو كتابة العدد يدويًا.`), promptOptions([[
    1, 2, 3, 4, 5
  ].map((value) => ({
    text: String(value),
    callback_data: `number:${key}:${value}`
  }))]));
}

async function askNext(bot, chatId, session) {
  const question = currentQuestion(session);
  if (!question) return showSummary(bot, chatId, session);
  const [key, text] = question;

  if (['floors', 'bathrooms', 'rooms', 'floor'].includes(key)) return numberChoice(bot, chatId, session, key, text);
  if (key === 'contact') return contactChoice(bot, chatId);
  if (key === 'land_kind') return landKindChoice(bot, chatId);
  if (key === 'has_extra_land') return yesNo(bot, chatId, 'extraLand');
  if (key === 'region') return regionChoice(bot, chatId);
  if (key === 'subregion') return subregionChoice(bot, chatId, session);
  if (key === 'currency') return currencyChoice(bot, chatId);
  if (key === 'photos') {
    return bot.sendMessage(chatId, promptText(session, text), promptOptions([[{ text: 'تم', callback_data: 'photos:done' }]]));
  }
  return bot.sendMessage(chatId, promptText(session, text), promptOptions([]));
}

function listingLines(payload, options = {}) {
  const lines = [
    options.admin ? `طلب إعلان رقم: #${payload.public_code}` : `عقار جديد في غزة\nرقم الإعلان: #${payload.public_code}`,
    '',
    `🏷️ النوع: ${categories[payload.category]}`,
    `📌 نوع العرض: ${payload.listing_type === 'sale' ? 'بيع' : 'إيجار'}`
  ];

  const labels = {
    roof_state: '🏗️ حالة الرووف',
    floors: '🏢 عدد الطوابق',
    land_area: '📐 مساحة الأرض',
    building_area: '🏠 مساحة البناء',
    bathrooms: '🚿 عدد الحمامات',
    rooms: '🛏️ عدد الغرف',
    has_extra_land: '🌿 أرض/حديقة إضافية',
    extra_land_area: '🌿 مساحة الإضافي',
    area: '📐 المساحة',
    floor: '🏢 الطابق',
    street_width: '🛣️ عرض الشارع',
    land_kind: '🧭 نوع الأرض',
    region: '📍 المنطقة',
    subregion: '📍 المنطقة الفرعية',
    address_detail: '📝 العنوان التفصيلي',
    currency: '💱 العملة',
    price_value: '💰 السعر',
    contact_phone: '☎️ للتواصل',
    notes: '🗒️ ملاحظات'
  };

  for (const key of Object.keys(labels)) {
    if (!payload[key] || payload[key] === '-') continue;
    let value = payload[key];
    if (key === 'roof_state') value = value === 'open' ? 'مساحة مفتوحة' : 'بناء قائم';
    if (key === 'has_extra_land') value = value === 'yes' ? 'نعم' : 'لا';
    if (key === 'land_kind') value = landKinds[value] || value;
    if (key === 'region') value = regions[value] || value;
    if (key === 'subregion') value = valueLabel(key, value);
    if (key === 'currency') value = currencies[value] || value;
    lines.push(`${labels[key]}: ${value}`);
  }

  if (options.admin) {
    lines.push('', `المستخدم: ${payload.user_display_name}`);
    lines.push(`رقم المستخدم المسجل: ${payload.registered_phone}`);
    lines.push(`Telegram ID: ${payload.user_telegram_id}`);
    lines.push(`الصور: ${payload.photos_count}`);
  }

  return lines.join('\n');
}

function normalizeDigits(value) {
  return String(value)
    .replace(/[٠-٩]/g, (digit) => String('٠١٢٣٤٥٦٧٨٩'.indexOf(digit)))
    .replace(/[۰-۹]/g, (digit) => String('۰۱۲۳۴۵۶۷۸۹'.indexOf(digit)));
}

function parsePositiveNumber(value) {
  const normalized = normalizeDigits(value).replace(',', '.');
  const match = normalized.match(/\d+(?:\.\d+)?/);
  if (!match) return null;
  const number = Number.parseFloat(match[0]);
  return Number.isFinite(number) && number > 0 ? number : null;
}

function validateAnswer(key, text, session) {
  const value = (text || '').trim();
  if (!value) return 'هذا الحقل إلزامي.';
  if (key === 'price_value' && value === '-') return 'السعر إلزامي ولا يمكن تخطيه.';
  if (['floors', 'bathrooms', 'rooms', 'floor'].includes(key) && !Number.isInteger(parsePositiveNumber(value))) {
    return 'اكتب رقمًا صحيحًا أو اختر من الأزرار.';
  }
  if (['land_area', 'building_area', 'extra_land_area', 'area'].includes(key) && !parsePositiveNumber(value)) {
    return 'اكتب مساحة صحيحة بالأرقام.';
  }
  if (['building_area', 'extra_land_area'].includes(key)) {
    const landArea = parsePositiveNumber(session.data.land_area);
    const currentArea = parsePositiveNumber(value);
    if (landArea && currentArea && currentArea > landArea) {
      return 'لا يمكن أن تكون هذه المساحة أكبر من مساحة الأرض الكلية.';
    }
  }
  return null;
}

async function showSummary(bot, chatId, session) {
  const user = getUser(chatId);
  session.data.public_code = nextListingCode();
  session.data.category = session.category;
  session.data.listing_type = session.listingType;
  session.data.user_display_name = user.display_name;
  session.data.registered_phone = user.phone;
  session.data.user_telegram_id = chatId;
  session.data.photos_count = session.photos.length;

  const summary = `${listingLines(session.data)}\n\nهل تريد إرسال الإعلان للإدارة؟`;
  return bot.sendPhoto(chatId, session.photos[0], {
    caption: summary,
    reply_markup: {
      inline_keyboard: [
        [
          { text: 'إرسال للإدارة', callback_data: 'submit:send' },
          { text: 'تعديل من البداية', callback_data: 'menu:submit' }
        ],
        [{ text: 'إلغاء', callback_data: 'flow:cancel' }]
      ]
    }
  });
}

async function sendListingToAdmin(bot, config, chatId, session) {
  if (!session.photos.length) {
    return bot.sendMessage(chatId, 'يجب إرسال صورة واحدة على الأقل.');
  }

  const payload = { ...session.data };
  const result = db.prepare(`
    INSERT INTO real_estate_listings (public_code, user_telegram_id, category, listing_type, payload, photos)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(
    payload.public_code,
    chatId,
    session.category,
    session.listingType,
    JSON.stringify(payload),
    JSON.stringify(session.photos)
  );

  const adminText = listingLines(payload, { admin: true });
  const keyboard = {
    inline_keyboard: [
      [
        { text: 'موافقة ونشر', callback_data: `admin:approve:${result.lastInsertRowid}` },
        { text: 'رفض', callback_data: `admin:reject:${result.lastInsertRowid}` }
      ],
      [{ text: 'طلب تعديل', callback_data: `admin:changes:${result.lastInsertRowid}` }]
    ]
  };

  const firstPhoto = session.photos[0];
  const message = await bot.sendPhoto(config.adminChatId, firstPhoto, {
    caption: adminText,
    reply_markup: keyboard
  });

  db.prepare(`
    UPDATE real_estate_listings
    SET admin_message_chat_id = ?, admin_message_id = ?
    WHERE id = ?
  `).run(config.adminChatId, message.message_id, result.lastInsertRowid);

  sessions.delete(chatId);
  await bot.sendMessage(chatId, 'تم إرسال إعلانك للإدارة للمراجعة.', { reply_markup: userKeyboard() });
  return bot.sendMessage(chatId, 'يمكنك متابعة الخيارات من القائمة:', { reply_markup: mainMenu() });
}

async function publishListing(bot, config, listing) {
  const payload = JSON.parse(listing.payload);
  const photos = JSON.parse(listing.photos);
  const caption = listingLines(payload);
  let channelMessageId = null;

  if (photos.length === 1) {
    const sent = await bot.sendPhoto(config.offersGroupId, photos[0], { caption });
    channelMessageId = sent.message_id;
  } else {
    const media = photos.slice(0, 10).map((photo, index) => ({
      type: 'photo',
      media: photo,
      caption: index === 0 ? caption : undefined
    }));
    const sent = await bot.sendMediaGroup(config.offersGroupId, media);
    channelMessageId = sent && sent[0] ? sent[0].message_id : null;
  }

  db.prepare(`
    UPDATE real_estate_listings
    SET status = 'published', channel_message_id = ?, updated_at = CURRENT_TIMESTAMP
    WHERE id = ?
  `).run(channelMessageId, listing.id);

  await bot.sendMessage(listing.user_telegram_id, 'تمت الموافقة على إعلانك ونشره في مجموعة عروض عقارات غزة.');
}

async function sendOffersGroupLink(bot, chatId, config) {
  if (config.offersGroupInviteLink) {
    return bot.sendMessage(chatId, 'يمكنك الآن الدخول إلى مجموعة عروض عقارات غزة:', {
      reply_markup: {
        inline_keyboard: [[{ text: 'الدخول إلى المجموعة', url: config.offersGroupInviteLink }]]
      }
    });
  }

  try {
    const invite = await bot.createChatInviteLink(config.offersGroupId, {
      member_limit: 1,
      creates_join_request: false
    });
    return bot.sendMessage(chatId, 'يمكنك الآن الدخول إلى مجموعة عروض عقارات غزة:', {
      reply_markup: {
        inline_keyboard: [[{ text: 'الدخول إلى المجموعة', url: invite.invite_link }]]
      }
    });
  } catch (error) {
    console.warn('create offers group invite failed:', error.message);
    return bot.sendMessage(chatId, 'تم تسجيلك بنجاح. تواصل مع الإدارة للحصول على رابط المجموعة.');
  }
}

async function offersGroupUrl(bot, config) {
  if (config.offersGroupInviteLink) return config.offersGroupInviteLink;
  const invite = await bot.createChatInviteLink(config.offersGroupId, {
    member_limit: 1,
    creates_join_request: false
  });
  return invite.invite_link;
}

async function sendRegistrationSuccess(bot, chatId, config) {
  const keyboard = mainMenu().inline_keyboard;
  try {
    const url = await offersGroupUrl(bot, config);
    keyboard.unshift([{ text: 'تم تسجيلك بنجاح - الدخول إلى المجموعة', url }]);
  } catch (error) {
    console.warn('create registration invite failed:', error.message);
  }

  await bot.sendMessage(chatId, 'تم تفعيل قائمة الخيارات أسفل المحادثة.', {
    reply_markup: userKeyboard()
  });

  return bot.sendMessage(chatId, 'تم تسجيلك بنجاح. اختر من القائمة:', {
    reply_markup: { inline_keyboard: keyboard }
  });
}

function startListingFlow(bot, chatId, fromId) {
  if (!isRegistered(fromId)) return startRegistration(bot, chatId);
  sessions.set(fromId, { action: 'listing', stepIndex: 0, data: {}, photos: [] });
  return askCategory(bot, chatId);
}

function sendMyListings(bot, chatId, fromId) {
  const rows = db.prepare(`
    SELECT public_code, category, status, created_at
    FROM real_estate_listings
    WHERE user_telegram_id = ?
    ORDER BY id DESC
    LIMIT 10
  `).all(fromId);
  if (!rows.length) return bot.sendMessage(chatId, 'لا يوجد لديك إعلانات حتى الآن.', { reply_markup: userKeyboard() });
  return bot.sendMessage(chatId, rows.map((row) => `#${row.public_code} - ${categories[row.category]} - ${row.status}`).join('\n'), {
    reply_markup: userKeyboard()
  });
}

function confirmDeleteAccount(bot, chatId) {
  return bot.sendMessage(chatId, 'هل أنت متأكد من حذف حسابك وبيانات التسجيل؟', {
    reply_markup: {
      inline_keyboard: [
        [
          { text: 'نعم، حذف الحساب', callback_data: 'account:delete_confirm' },
          { text: 'إلغاء', callback_data: 'account:delete_cancel' }
        ]
      ]
    }
  });
}

function startRegistration(bot, chatId) {
  if (isBlocked(chatId)) {
    return bot.sendMessage(chatId, 'تم إيقاف التسجيل لهذا الحساب بسبب تجاوز عدد محاولات الدخول. تواصل مع الإدارة للمراجعة.');
  }

  sessions.set(chatId, { action: 'awaiting_contact' });
  return bot.sendMessage(chatId, [
    'لإتمام التسجيل، يرجى مشاركة رقم هاتفك الرسمي من خلال الزر التالي.',
    'لا يمكن قبول الرقم مكتوبًا يدويًا.'
  ].join('\n'), { reply_markup: contactKeyboard() });
}

async function handleNewGatewayMember(bot, config, msg, member) {
  if (member.is_bot) return;
  upsertVisit(member.id, msg.chat.id);

  if (isRegistered(member.id)) return;

  const attempts = touchGatewayAttempt(member, msg.chat.id);
  const botUsername = config.botUsername ? `https://t.me/${config.botUsername}?start=register` : undefined;

  if (attempts > config.maxGatewayAttempts) {
    blockUser(member.id);
    try {
      await bot.banChatMember(msg.chat.id, member.id);
    } catch (error) {
      console.warn('gateway ban failed:', error.message);
    }
    return;
  }

  const text = [
    `أهلاً ${member.first_name || ''}.`,
    'للبقاء في مجموعة عروض عقارات غزة يجب إتمام التسجيل عبر البوت في الخاص.',
    `لديك ${config.registrationGraceMinutes} دقيقة لإتمام التسجيل.`
  ].join('\n');

  const options = botUsername
    ? { reply_markup: { inline_keyboard: [[{ text: 'إتمام التسجيل', url: botUsername }]] } }
    : {};
  await bot.sendMessage(msg.chat.id, text, options);

  const timerKey = `${msg.chat.id}:${member.id}`;
  clearTimeout(pendingTimers.get(timerKey));
  const timer = setTimeout(async () => {
    if (isRegistered(member.id)) return;
    try {
      await bot.banChatMember(msg.chat.id, member.id);
      await bot.unbanChatMember(msg.chat.id, member.id, { only_if_banned: true });
      db.prepare(`
        UPDATE real_estate_gateway_visits
        SET removed_at = CURRENT_TIMESTAMP
        WHERE telegram_id = ? AND chat_id = ? AND removed_at IS NULL
      `).run(member.id, msg.chat.id);
    } catch (error) {
      console.warn('gateway timeout removal failed:', error.message);
    }
  }, config.registrationGraceMinutes * 60 * 1000);
  pendingTimers.set(timerKey, timer);
}

function createRealEstateBot() {
  const offersGroupId = envChatId('OFFERS_GROUP_ID', envChatId('OFFERS_CHANNEL_ID', ''));
  const config = {
    token: requiredEnv('REAL_ESTATE_BOT_TOKEN'),
    adminChatId: envChatId('ADMIN_CHAT_ID'),
    gatewayGroupId: envChatId('GATEWAY_GROUP_ID', ''),
    offersGroupId,
    offersGroupInviteLink: process.env.OFFERS_GROUP_INVITE_LINK || process.env.CHANNEL_INVITE_LINK || '',
    registrationGraceMinutes: envNumber('REGISTRATION_GRACE_MINUTES', 15),
    maxGatewayAttempts: envNumber('MAX_GATEWAY_ATTEMPTS', 3),
    botUsername: process.env.REAL_ESTATE_BOT_USERNAME || ''
  };

  if (!config.adminChatId) {
    throw new Error('ADMIN_CHAT_ID is required for real estate mode');
  }

  if (!config.offersGroupId) {
    throw new Error('OFFERS_GROUP_ID is required for real estate mode');
  }

  const bot = new TelegramBot(config.token, { polling: true });

  bot.onText(/^\/start/, async (msg) => {
    if (!isPrivate(msg)) return;
    if (isBlocked(msg.from.id)) {
      return bot.sendMessage(msg.chat.id, 'تم إيقاف التسجيل لهذا الحساب بسبب تجاوز عدد محاولات الدخول. تواصل مع الإدارة للمراجعة.');
    }
    if (isRegistered(msg.from.id)) {
      await bot.sendMessage(msg.chat.id, 'أهلاً بك. قائمة الخيارات جاهزة أسفل المحادثة.', { reply_markup: userKeyboard() });
      return bot.sendMessage(msg.chat.id, 'اختر من القائمة:', { reply_markup: mainMenu() });
    }
    return startRegistration(bot, msg.chat.id);
  });

  bot.on('new_chat_members', async (msg) => {
    if (!isGatewayChat(msg.chat.id, config)) return;
    for (const member of msg.new_chat_members || []) {
      await handleNewGatewayMember(bot, config, msg, member);
    }
  });

  bot.on('contact', async (msg) => {
    if (!isPrivate(msg)) return;
    const session = sessions.get(msg.from.id);
    if (!session || session.action !== 'awaiting_contact') return;
    if (!msg.contact || msg.contact.user_id !== msg.from.id) {
      return bot.sendMessage(msg.chat.id, 'يجب مشاركة رقمك الرسمي من الزر، وليس رقمًا آخر.', { reply_markup: contactKeyboard() });
    }
    session.action = 'awaiting_name';
    session.phone = msg.contact.phone_number;
    sessions.set(msg.from.id, session);
    return bot.sendMessage(msg.chat.id, 'الرجاء إدخال الاسم أو الكنية التي تريد اعتمادها في النظام.', { reply_markup: removeKeyboard() });
  });

  bot.on('message', async (msg) => {
    if (!isPrivate(msg) || !msg.from || msg.from.is_bot) return;
    if (msg.contact) return;
    if (msg.text && msg.text.startsWith('/')) return;

    const text = (msg.text || '').trim();
    if (isRegistered(msg.from.id) && !sessions.has(msg.from.id)) {
      if (text === 'عرض عقار') return startListingFlow(bot, msg.chat.id, msg.from.id);
      if (text === 'إعلاناتي') return sendMyListings(bot, msg.chat.id, msg.from.id);
      if (text === 'تعديل البروفايل' || text === 'تعديل بياناتي') return startRegistration(bot, msg.chat.id);
      if (text === 'الدخول للمجموعة') return sendOffersGroupLink(bot, msg.chat.id, config);
      if (text === 'حذف الحساب') return confirmDeleteAccount(bot, msg.chat.id);
    }

    const session = sessions.get(msg.from.id);
    if (!session) return;

    if (session.action === 'awaiting_contact') {
      return bot.sendMessage(msg.chat.id, 'لا يمكن قبول الرقم مكتوبًا يدويًا. يرجى استخدام زر مشاركة رقم الهاتف فقط.', { reply_markup: contactKeyboard() });
    }

    if (session.action === 'awaiting_name') {
      const name = (msg.text || '').trim();
      if (name.length < 2) return bot.sendMessage(msg.chat.id, 'اكتب اسمًا أو كنية من حرفين على الأقل.');
      markRegistered(msg.from, session.phone, name);
      sessions.delete(msg.from.id);
      return sendRegistrationSuccess(bot, msg.chat.id, config);
    }

    if (session.action === 'listing') {
      const question = currentQuestion(session);
      if (!question) return;
      const [key] = question;

      if (key === 'photos') {
        if (msg.photo && msg.photo.length) {
          session.photos.push(msg.photo[msg.photo.length - 1].file_id);
          sessions.set(msg.from.id, session);
          return bot.sendMessage(msg.chat.id, `تم استلام الصورة رقم ${session.photos.length}. أرسل صورة أخرى أو اضغط تم.`, {
            reply_markup: { inline_keyboard: withCancel([[{ text: 'تم', callback_data: 'photos:done' }]]) }
          });
        }
        return bot.sendMessage(msg.chat.id, 'أرسل صورة للعقار. صورة واحدة على الأقل إلزامية.');
      }

      if (['contact', 'land_kind', 'has_extra_land', 'region', 'subregion', 'currency'].includes(key)) return;
      const error = validateAnswer(key, msg.text, session);
      if (error) return bot.sendMessage(msg.chat.id, error);
      session.data[key] = msg.text.trim();
      session.stepIndex += 1;
      sessions.set(msg.from.id, session);
      return askNext(bot, msg.chat.id, session);
    }

    if (session.action === 'awaiting_other_contact') {
      const phone = (msg.text || '').trim();
      if (phone.length < 6) return bot.sendMessage(msg.chat.id, 'اكتب رقم تواصل صحيح.');
      session.listing.data.contact_phone = phone;
      session.listing.stepIndex += 1;
      sessions.set(msg.from.id, session.listing);
      return askNext(bot, msg.chat.id, session.listing);
    }

    if (session.action === 'admin_note') {
      const listing = db.prepare('SELECT * FROM real_estate_listings WHERE id = ?').get(session.listingId);
      if (!listing) return sessions.delete(msg.from.id);
      const status = session.noteType === 'reject' ? 'rejected' : 'needs_changes';
      db.prepare(`
        UPDATE real_estate_listings
        SET status = ?, review_note = ?, updated_at = CURRENT_TIMESTAMP
        WHERE id = ?
      `).run(status, msg.text || '', listing.id);
      await bot.sendMessage(listing.user_telegram_id, `${status === 'rejected' ? 'تم رفض إعلانك' : 'يحتاج إعلانك إلى تعديل'}.\nالسبب: ${msg.text || '-'}`);
      sessions.delete(msg.from.id);
      return bot.sendMessage(msg.chat.id, 'تم إرسال الملاحظة للمستخدم.');
    }
  });

  bot.on('callback_query', async (query) => {
    const data = query.data || '';
    const chatId = query.message.chat.id;
    const fromId = query.from.id;

    try {
      if (data === 'menu:submit') {
        await bot.answerCallbackQuery(query.id);
        await deletePrompt(bot, query);
        return startListingFlow(bot, chatId, fromId);
      }

      if (data === 'menu:offers_group' || data === 'menu:channel') {
        await bot.answerCallbackQuery(query.id);
        await deletePrompt(bot, query);
        if (!isRegistered(fromId)) return startRegistration(bot, chatId);
        return sendOffersGroupLink(bot, chatId, config);
      }

      if (data === 'menu:profile') {
        await bot.answerCallbackQuery(query.id);
        await deletePrompt(bot, query);
        return startRegistration(bot, chatId);
      }

      if (data === 'menu:mine') {
        await bot.answerCallbackQuery(query.id);
        await deletePrompt(bot, query);
        return sendMyListings(bot, chatId, fromId);
      }

      if (data === 'account:delete_cancel') {
        await bot.answerCallbackQuery(query.id);
        await deletePrompt(bot, query);
        return bot.sendMessage(chatId, 'تم إلغاء حذف الحساب.', { reply_markup: userKeyboard() });
      }

      if (data === 'account:delete_confirm') {
        await bot.answerCallbackQuery(query.id);
        await deletePrompt(bot, query);
        sessions.delete(fromId);
        deleteAccount(fromId);
        return bot.sendMessage(chatId, 'تم حذف حسابك من النظام. يمكنك التسجيل مرة أخرى في أي وقت.', { reply_markup: removeKeyboard() });
      }

      if (data === 'flow:cancel') {
        sessions.delete(fromId);
        await bot.answerCallbackQuery(query.id);
        await deletePrompt(bot, query);
        await bot.sendMessage(chatId, 'تم إلغاء العملية.', { reply_markup: userKeyboard() });
        return bot.sendMessage(chatId, 'اختر من القائمة:', { reply_markup: mainMenu() });
      }

      if (data.startsWith('cat:')) {
        const session = sessions.get(fromId);
        if (!session || session.action !== 'listing') return;
        session.category = data.split(':')[1];
        session.data.category = session.category;
        sessions.set(fromId, session);
        await bot.answerCallbackQuery(query.id);
        await deletePrompt(bot, query);
        if (session.category === 'roof') return roofStateChoice(bot, chatId);
        return askListingType(bot, chatId);
      }

      if (data.startsWith('roof:')) {
        const session = sessions.get(fromId);
        if (!session || session.action !== 'listing') return;
        session.data.roof_state = data.split(':')[1];
        sessions.set(fromId, session);
        await bot.answerCallbackQuery(query.id);
        await deletePrompt(bot, query);
        return askListingType(bot, chatId);
      }

      if (data.startsWith('type:')) {
        const session = sessions.get(fromId);
        if (!session || session.action !== 'listing') return;
        session.listingType = data.split(':')[1];
        session.data.listing_type = session.listingType;
        sessions.set(fromId, session);
        await bot.answerCallbackQuery(query.id);
        await deletePrompt(bot, query);
        return askNext(bot, chatId, session);
      }

      if (data.startsWith('number:')) {
        const session = sessions.get(fromId);
        if (!session || session.action !== 'listing') return;
        const [, key, value] = data.split(':');
        const question = currentQuestion(session);
        if (!question || question[0] !== key) return;
        session.data[key] = value;
        session.stepIndex += 1;
        sessions.set(fromId, session);
        await bot.answerCallbackQuery(query.id);
        await deletePrompt(bot, query);
        return askNext(bot, chatId, session);
      }

      if (data.startsWith('extraLand:')) {
        const session = sessions.get(fromId);
        if (!session || session.action !== 'listing') return;
        session.data.has_extra_land = data.split(':')[1];
        session.stepIndex += 1;
        sessions.set(fromId, session);
        await bot.answerCallbackQuery(query.id);
        await deletePrompt(bot, query);
        return askNext(bot, chatId, session);
      }

      if (data.startsWith('landkind:')) {
        const session = sessions.get(fromId);
        if (!session || session.action !== 'listing') return;
        session.data.land_kind = data.split(':')[1];
        session.stepIndex += 1;
        sessions.set(fromId, session);
        await bot.answerCallbackQuery(query.id);
        await deletePrompt(bot, query);
        return askNext(bot, chatId, session);
      }

      if (data.startsWith('region:')) {
        const session = sessions.get(fromId);
        if (!session || session.action !== 'listing') return;
        session.data.region = data.split(':')[1];
        delete session.data.subregion;
        session.stepIndex += 1;
        sessions.set(fromId, session);
        await bot.answerCallbackQuery(query.id);
        await deletePrompt(bot, query);
        return askNext(bot, chatId, session);
      }

      if (data.startsWith('subregion:')) {
        const session = sessions.get(fromId);
        if (!session || session.action !== 'listing') return;
        session.data.subregion = data.split(':')[1];
        session.stepIndex += 1;
        sessions.set(fromId, session);
        await bot.answerCallbackQuery(query.id);
        await deletePrompt(bot, query);
        return askNext(bot, chatId, session);
      }

      if (data.startsWith('currency:')) {
        const session = sessions.get(fromId);
        if (!session || session.action !== 'listing') return;
        session.data.currency = data.split(':')[1];
        session.stepIndex += 1;
        sessions.set(fromId, session);
        await bot.answerCallbackQuery(query.id);
        await deletePrompt(bot, query);
        return askNext(bot, chatId, session);
      }

      if (data.startsWith('contact:')) {
        const session = sessions.get(fromId);
        if (!session || session.action !== 'listing') return;
        const choice = data.split(':')[1];
        await bot.answerCallbackQuery(query.id);
        await deletePrompt(bot, query);
        if (choice === 'registered') {
          const user = getUser(fromId);
          session.data.contact_phone = user.phone;
          session.stepIndex += 1;
          sessions.set(fromId, session);
          return askNext(bot, chatId, session);
        }
        sessions.set(fromId, { action: 'awaiting_other_contact', listing: session });
        return bot.sendMessage(chatId, 'اكتب رقم التواصل الذي تريد ظهوره في الإعلان:', {
          reply_markup: { inline_keyboard: withCancel([]) }
        });
      }

      if (data === 'photos:done') {
        const session = sessions.get(fromId);
        if (!session || session.action !== 'listing') return;
        await bot.answerCallbackQuery(query.id);
        if (!session.photos.length) return bot.sendMessage(chatId, 'يجب إرسال صورة واحدة على الأقل.');
        session.stepIndex += 1;
        sessions.set(fromId, session);
        await deletePrompt(bot, query);
        return askNext(bot, chatId, session);
      }

      if (data === 'submit:send') {
        const session = sessions.get(fromId);
        if (!session || session.action !== 'listing') return;
        await bot.answerCallbackQuery(query.id);
        await deletePrompt(bot, query);
        return sendListingToAdmin(bot, config, chatId, session);
      }

      if (data.startsWith('admin:')) {
        if (String(fromId) !== String(config.adminChatId)) {
          await bot.answerCallbackQuery(query.id, { text: 'غير مصرح' });
          return;
        }
        const [, action, rawId] = data.split(':');
        const listing = db.prepare('SELECT * FROM real_estate_listings WHERE id = ?').get(Number(rawId));
        if (!listing) {
          await bot.answerCallbackQuery(query.id, { text: 'الإعلان غير موجود' });
          return;
        }
        await bot.answerCallbackQuery(query.id);
        if (action === 'approve') {
          await publishListing(bot, config, listing);
          return bot.sendMessage(chatId, `تم نشر الإعلان #${listing.public_code}.`);
        }
        sessions.set(fromId, { action: 'admin_note', listingId: listing.id, noteType: action === 'reject' ? 'reject' : 'changes' });
        return bot.sendMessage(chatId, action === 'reject' ? 'اكتب سبب الرفض:' : 'اكتب التعديل المطلوب من المستخدم:');
      }
    } catch (error) {
      console.warn('real estate callback failed:', error.message);
      await bot.answerCallbackQuery(query.id, { text: 'حدث خطأ' });
    }
  });

  bot.on('polling_error', (error) => {
    console.warn('Real estate bot polling error:', error.message);
  });

  return bot;
}

module.exports = {
  createRealEstateBot
};
