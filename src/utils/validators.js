function isValidBotToken(token) {
  return typeof token === 'string' && /^\d{6,12}:[A-Za-z0-9_-]{30,80}$/.test(token.trim());
}

function cleanText(input, maxLength = 1000) {
  if (typeof input !== 'string') return '';
  return input.trim().replace(/\0/g, '').slice(0, maxLength);
}

function cleanWord(input) {
  return cleanText(input, 80).toLowerCase();
}

function toPositiveInt(input, fallback, min = 1, max = 10080) {
  const value = Number.parseInt(input, 10);
  if (!Number.isFinite(value) || value < min || value > max) return fallback;
  return value;
}

function isPrivateChat(msg) {
  return msg && msg.chat && msg.chat.type === 'private';
}

function isGroupChat(msg) {
  return msg && msg.chat && ['group', 'supergroup'].includes(msg.chat.type);
}

module.exports = {
  isValidBotToken,
  cleanText,
  cleanWord,
  toPositiveInt,
  isPrivateChat,
  isGroupChat
};
