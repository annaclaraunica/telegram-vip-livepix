# Telegram Bot Professional v6

Projeto Node.js para:

- vendas via LivePix
- entrega VIP no Telegram
- grants temporarios no Google Drive
- remarketing e painel admin

## Rodando local

```bash
npm install
cp .env.example .env
npm start
```

## Teste gratis em cloud

Para teste inicial sem custo:

- `Render Free` para o web service
- `Render Free Postgres`
- `Upstash Redis Free`
- jobs no proprio processo web com `RUN_JOBS_IN_WEB=true`

Guia curto em [DEPLOY_RENDER.md](D:\Telegram_bot_final\DEPLOY_RENDER.md).

Limitacoes:

- o `web` gratuito do Render entra em idle
- o `Postgres Free` do Render expira
- isso serve para homologacao, nao para 24h profissional

## Seguranca

- use `.env.example` apenas como modelo
- nunca versionar `.env` ou variantes com segredo
- manter credenciais reais apenas no ambiente local ou no provedor de deploy
