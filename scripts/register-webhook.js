require("dotenv").config();
const { getLivePixToken, registerWebhook } = require("../src/livepix");

(async () => {
  if (!process.env.PUBLIC_URL) throw new Error("PUBLIC_URL vazio");
  if (!process.env.WEBHOOK_SECRET) throw new Error("WEBHOOK_SECRET vazio");

  const token = await getLivePixToken({
    clientId: process.env.LIVEPIX_CLIENT_ID,
    clientSecret: process.env.LIVEPIX_CLIENT_SECRET,
  });

  const url = `${process.env.PUBLIC_URL}/webhook/livepix?secret=${process.env.WEBHOOK_SECRET}`;
  const data = await registerWebhook({ token, url });

  console.log("✅ Webhook criado na LivePix:", data);
})();
