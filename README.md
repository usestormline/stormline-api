# Stormline API

[![CI](https://github.com/usestormline/stormline-api/actions/workflows/ci.yml/badge.svg)](https://github.com/usestormline/stormline-api/actions/workflows/ci.yml) [![License](https://img.shields.io/badge/license-Apache--2.0-blue.svg)](LICENSE)

The server-side intelligence API for Stormline. It normalizes official economic events, financial news, corroborated geopolitical context, canonical Robinhood Chain Stock Token identities, market context, and non-custodial portfolio reads.

## Security and data boundaries
Provider credentials stay server-side. This repository contains no production database, user records, wallet secrets, cached provider payloads, or licensed conflict datasets. ACLED remains disabled unless the operator has appropriate commercial access.

## Quick start
```bash
pnpm install
cp .env.example .env
pnpm typecheck
pnpm build
```
Configure a PostgreSQL development database and blank provider credentials through a secret manager. Never commit `.env`. The API contract and generated clients are in [stormline-sdk](https://github.com/usestormline/stormline-sdk).

## Community
Read [CONTRIBUTING.md](CONTRIBUTING.md), [SECURITY.md](SECURITY.md), and [GOVERNANCE.md](GOVERNANCE.md). Support: support@usestormline.com · Updates: https://x.com/UseStormLine
