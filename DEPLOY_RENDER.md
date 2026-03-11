# Deploy Render de Teste Gratis

## Objetivo

Modo inicial de teste com custo zero:

- `1 web service` no Render Free
- `1 Postgres` no Render Free
- `1 Redis` no Upstash Free
- jobs rodando no proprio `web` com `RUN_JOBS_IN_WEB=true`

Esse modo serve para homologacao. Nao e 24h profissional porque o `web` gratuito do Render entra em idle e o Postgres gratuito expira. Fonte: https://render.com/docs/free

## Arquitetura de teste

- `telegram-vip-livepix-web`
  - atende HTTP
  - recebe webhooks
  - expoe `/health` e `/readyz`
  - executa jobs no mesmo processo

## Variaveis obrigatorias

Nunca subir valores reais dessas variaveis para o repositorio. Use apenas variaveis do Render e o arquivo `.env.example` como modelo local.

- `DATABASE_URL`
- `APP_BASE_URL`
- `WEBHOOK_SECRET`
- `TELEGRAM_WEBHOOK_SECRET`
- `TELEGRAM_BOT_TOKEN`
- `TELEGRAM_VIP_CHAT_ID`
- `ADMIN_USER`
- `ADMIN_PASS`
- `LIVEPIX_CLIENT_ID`
- `LIVEPIX_CLIENT_SECRET`
- `APP_ROLE=web`
- `RUN_JOBS_IN_WEB=true`

## Variaveis recomendadas

- `REDIS_URL`
- `REDIS_QUEUE_PREFIX`
- `GOOGLE_SERVICE_ACCOUNT_JSON`
- `GOOGLE_DRIVE_FOLDER_ID`
- `SUPPORT_WHATSAPP_URL`
- `INSTAGRAM_URL`
- `FREE_GROUP_URL`

## Ordem recomendada

1. Criar o `Postgres Free` no Render.
2. Criar o `Redis Free` no Upstash.
3. Subir o `web` usando o `render.yaml`.
4. Configurar `DATABASE_URL` e `REDIS_URL`.
5. Validar `GET /readyz`.
6. Registrar o webhook LivePix.
7. Validar Telegram e LivePix.

## Smoke test

### Web

- `GET /health`
- `GET /readyz`
- `GET /admin` deve pedir autenticacao

### Jobs no web

- verificar logs de:
  - `Servidor iniciado` com `jobsEnabled: true`
  - `Scheduler de jobs inicializado`
  - `Job iniciado`

### LivePix

- enviar payload simulado para `/webhook/livepix?secret=...`

### Telegram

- confirmar que o `web` registrou o webhook sem erro

## Quando sair do gratis

Passe para `web + worker` separados quando quiser operacao 24h de verdade:

- `web` sempre ativo
- `worker` dedicado
- `Postgres` persistente
- `Redis` persistente
