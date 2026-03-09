require("dotenv").config()
const { getLivePixToken, registerWebhook } = require("../src/livepix")

async function main() {
  const token = await getLivePixToken({
    clientId: process.env.LIVEPIX_CLIENT_ID,
    clientSecret: process.env.LIVEPIX_CLIENT_SECRET,
  })
  const url = `${process.env.PUBLIC_URL.replace(/\/$/, "")}/webhook/livepix?secret=${process.env.WEBHOOK_SECRET}`
  const out = await registerWebhook({ token, url })
  console.log(JSON.stringify(out, null, 2))
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
