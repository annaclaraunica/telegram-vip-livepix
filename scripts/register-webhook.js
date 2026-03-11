require('dotenv').config();
const env = require('../src/config/env');
const { getLivePixToken, registerWebhook } = require('../src/livepix');

async function main() {
  const token = await getLivePixToken({
    clientId: env.livepixClientId,
    clientSecret: env.livepixClientSecret
  });
  const url = `${env.appBaseUrl.replace(/\/$/, '')}/webhook/livepix?secret=${env.webhookSecret}`;
  const out = await registerWebhook({ token, url });
  console.log(JSON.stringify(out, null, 2));
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
