require('dotenv').config();

const express = require('express');
const { migrate } = require('./database');
const { createMasterBot } = require('./masterBot');
const { CustomerBotManager } = require('./customerBotManager');

const port = Number.parseInt(process.env.PORT || '3000', 10);

async function main() {
  migrate();

  const app = express();
  app.use(express.json());

  const customerBotManager = new CustomerBotManager();
  customerBotManager.startAll();
  createMasterBot(customerBotManager);

  app.get('/', (req, res) => {
    res.json({
      ok: true,
      service: 'telegram-saas-group-manager'
    });
  });

  app.get('/health', (req, res) => {
    res.json({ ok: true, uptime: process.uptime() });
  });

  app.listen(port, () => {
    console.log(`Server listening on port ${port}`);
  });
}

main().catch((error) => {
  console.error('Fatal startup error:', error);
  process.exit(1);
});
