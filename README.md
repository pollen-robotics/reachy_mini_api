---
title: Reachy Mini API
emoji: 🤖
colorFrom: blue
colorTo: purple
sdk: docker
app_port: 7860
pinned: false
short_description: Backend API for the Reachy Mini app store
---

# Reachy Mini API

Backend service for the Reachy Mini app store. Split out of the showcase
website so the mobile app's backend can be deployed independently of the
marketing site.

## Endpoints

| Route | Purpose | Consumer |
|-------|---------|----------|
| `GET /api/js-apps` | JS app catalog (categorized + moderated) | mobile app |
| `GET /api/apps` | full catalog (Python + JS) | website |
| `GET /api/mcp-tools` | MCP tool catalog (Spaces tagged `reachy-mini-tool`, with resolved `mcpUrl`) | mobile app |
| `GET /api/categories` | category taxonomy | clients |
| `POST /api/openai/ephemeral` | mint short-lived OpenAI Realtime keys | mobile app |
| `GET /api/oauth-config` | public OAuth client id | website (fallback) |
| `GET /api/health` | health probe | monitoring |
| `POST /api/refresh` / `refresh-categories` / `refresh-moderation` | admin triggers | ops |

## Configuration

Set these in the Space's *Settings -> Variables and secrets* (see
[.env.example](.env.example)):

- `HF_TOKEN` (required, **write** access to `STORE_DATASET`) - LLM
  categorization + moderation, and persisting their caches.
- `OPENAI_API_KEY` (required) - master key used server-side only to mint
  ephemeral Realtime session keys.
- `STORE_DATASET` - single dataset holding `app-list.json`,
  `block-list.json`, `categories.json`, `moderation.json`. Defaults to
  `pollen-robotics/reachy-mini-official-app-store`.

## Stable hostname

The mobile app targets a frozen API base URL. In production this Space
must answer on that stable host (`pollen-robotics-reachy-mini.hf.space`)
via the existing redirect, so moving/rebuilding the backend never
requires an App Store resubmission.

## Local dev

```bash
npm install
HF_TOKEN=hf_xxx OPENAI_API_KEY=sk-xxx PORT=3001 npm start
```
