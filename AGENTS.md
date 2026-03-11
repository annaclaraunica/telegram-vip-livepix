# Telegram VIP + LivePix Bot

## Stack

Node.js
Express
Telegraf
PostgreSQL
Google Drive API

## Architecture

src/index.js
Main server

src/routes
HTTP routes

src/services
Business logic

src/jobs
Background jobs

src/lib
Utilities and database access

## Critical rules

Payments must be idempotent.

VIP access expires automatically.

Content download links are one-time use.

Google Drive permissions expire automatically.

All database access must go through db.js.



\# Projeto: Telegram VIP + LivePix



\## Stack

\- Node.js

\- Express

\- Telegraf

\- PostgreSQL

\- Google Drive API



\## Objetivo

Transformar este projeto em uma arquitetura profissional estável 24h.



\## Regras obrigatórias

\- Nunca expor segredos do .env

\- Todo processamento de pagamento deve ser idempotente

\- Todo acesso VIP deve ter expiração automática

\- Todo link de conteúdo deve ser one-time use quando aplicável

\- Toda operação crítica de pagamento deve usar transação no banco

\- Toda lógica de banco deve ficar centralizada em src/lib/db.js

\- Sempre preferir mudanças pequenas, seguras e revisáveis

\- Antes de alterar, explicar o plano e os arquivos que serão modificados

\- Após alterar, mostrar diff resumido e comandos para testar



\## Prioridades atuais

1\. Estabilidade 24h

2\. Separação entre rotas, serviços e jobs

3\. Logs estruturados

4\. Healthcheck

5\. Jobs resilientes

6\. Painel admin básico funcional

