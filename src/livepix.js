const axios = require("axios")

const HTTP_TIMEOUT_MS = Number(process.env.LIVEPIX_HTTP_TIMEOUT_MS || 20000)

function ensure(value, message) {
  if (!value) throw new Error(message)
  return value
}

async function postJson(url, body, config = {}) {
  const response = await axios.post(url, body, {
    timeout: HTTP_TIMEOUT_MS,
    validateStatus: () => true,
    ...config,
  })

  if (response.status < 200 || response.status >= 300) {
    const details = typeof response.data === "string"
      ? response.data
      : JSON.stringify(response.data || {})
    throw new Error(`LivePix HTTP ${response.status}: ${details}`)
  }
  return response.data
}

async function getLivePixToken({ clientId, clientSecret }) {
  ensure(clientId, "LIVEPIX_CLIENT_ID ausente")
  ensure(clientSecret, "LIVEPIX_CLIENT_SECRET ausente")
  const body = new URLSearchParams({
    grant_type: "client_credentials",
    client_id: clientId,
    client_secret: clientSecret,
    scope: "webhooks payments:read payments:write account:read wallet:read",
  })
  const data = await postJson("https://oauth.livepix.gg/oauth2/token", body.toString(), {
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
  })
  return ensure(data && data.access_token, "Token LivePix inválido")
}

async function createPayment({ token, amountCents, currency = "BRL", redirectUrl }) {
  ensure(token, "Token LivePix ausente")
  ensure(amountCents, "amountCents ausente")
  ensure(redirectUrl, "redirectUrl ausente")
  const data = await postJson("https://api.livepix.gg/v2/payments", {
    amount: Number(amountCents),
    currency,
    redirectUrl,
  }, {
    headers: { Authorization: `Bearer ${token}` },
  })
  return ensure(data && data.data, "Resposta de pagamento LivePix inválida")
}

async function registerWebhook({ token, url }) {
  ensure(token, "Token LivePix ausente")
  ensure(url, "URL ausente")
  const data = await postJson("https://api.livepix.gg/v2/webhooks", { url }, {
    headers: { Authorization: `Bearer ${token}` },
  })
  return ensure(data && data.data, "Resposta de webhook LivePix inválida")
}

module.exports = { getLivePixToken, createPayment, registerWebhook }
