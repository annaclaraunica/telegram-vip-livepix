
require("dotenv").config();
const { getLivePixToken, registerWebhook } = require("../src/livepix");
(async()=>{
  const token = await getLivePixToken({ clientId: process.env.LIVEPIX_CLIENT_ID, clientSecret: process.env.LIVEPIX_CLIENT_SECRET });
  const url = `${process.env.PUBLIC_URL}/webhook/livepix?secret=${process.env.WEBHOOK_SECRET}`;
  const data = await registerWebhook({ token, url });
  console.log("✅ Webhook LivePix registrado:", data);
})();
