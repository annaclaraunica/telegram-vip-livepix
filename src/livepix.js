const axios = require("axios");

async function getLivePixToken({ clientId, clientSecret }) {
  const url = "https://oauth.livepix.gg/oauth2/token";
  const body = new URLSearchParams({
    grant_type: "client_credentials",
    client_id: clientId,
    client_secret: clientSecret,
    scope: "webhooks payments:read payments:write account:read wallet:read",
  });
  const { data } = await axios.post(url, body.toString(), {
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
  });
  return data.access_token;
}

async function createPayment({ token, amountCents, currency = "BRL", redirectUrl }) {
  const { data } = await axios.post(
    "https://api.livepix.gg/v2/payments",
    { amount: amountCents, currency, redirectUrl },
    { headers: { Authorization: `Bearer ${token}` } }
  );
  return data.data;
}

async function registerWebhook({ token, url }) {
  const { data } = await axios.post(
    "https://api.livepix.gg/v2/webhooks",
    { url },
    { headers: { Authorization: `Bearer ${token}` } }
  );
  return data.data;
}

module.exports = { getLivePixToken, createPayment, registerWebhook };
