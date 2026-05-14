const { db } = require('../database');

function addDefaultSubscription(userId, botId) {
  const days = Number.parseInt(process.env.DEFAULT_SUBSCRIPTION_DAYS || '30', 10);
  const start = new Date();
  const end = new Date(start.getTime() + days * 24 * 60 * 60 * 1000);

  db.prepare(`
    INSERT INTO subscriptions (user_id, bot_id, plan, start_date, end_date, status)
    VALUES (?, ?, 'basic', ?, ?, 'active')
  `).run(userId, botId, start.toISOString(), end.toISOString());
}

function getActiveSubscription(botId) {
  const subscription = db.prepare(`
    SELECT * FROM subscriptions
    WHERE bot_id = ?
    ORDER BY id DESC
    LIMIT 1
  `).get(botId);

  if (!subscription) return null;

  const isExpired = subscription.status !== 'active' || new Date(subscription.end_date).getTime() < Date.now();
  if (isExpired && subscription.status !== 'expired') {
    db.prepare('UPDATE subscriptions SET status = ? WHERE id = ?').run('expired', subscription.id);
  }

  return isExpired ? null : subscription;
}

function isSubscriptionActive(botId) {
  return Boolean(getActiveSubscription(botId));
}

module.exports = {
  addDefaultSubscription,
  getActiveSubscription,
  isSubscriptionActive
};
