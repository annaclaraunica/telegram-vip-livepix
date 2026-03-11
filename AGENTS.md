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