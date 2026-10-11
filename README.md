# SocialFlow

Eén post klaarzetten → AI schrijft de captions → publiceren naar **Instagram, TikTok, Facebook en YouTube** (feed, Reel/Short én story), voor **meerdere accounts/merken** die elk hun eigen koppelingen hebben.

Gebouwd voor Moore Multimedia. Live op [socialflow-amber.vercel.app](https://socialflow-amber.vercel.app).

## Features

- **Eén post → alle kanalen** — foto's en video's naar feed, Reel/Short en story
- **AI-captions per platform** — Claude Opus 4.8 schrijft een eigen tekst + hashtags per kanaal (YouTube krijgt ook een titel)
- **Meerdere accounts** — elk merk/klant een eigen Account met eigen koppelingen
- **OAuth-koppelingen** — Meta (Facebook + Instagram), Instagram Login, TikTok, YouTube
- **Inplannen** — server-side scheduler via cron (+ dry-run/testmodus die de koppeling checkt zonder te posten)
- **Pagina-kiezer per account** — kies met welke Facebook-pagina/Instagram een account post

## Tech

- Next.js 16 (App Router) · React 19 · Tailwind CSS v4 · TypeScript
- Opslag: Upstash Redis (tokens/accounts) + Vercel Blob (media), met lokale `.data/`-fallback
- AI: Anthropic Claude API
- Hosting: Vercel

## Lokaal draaien

```bash
npm install
npm run dev      # http://localhost:3000
```

Maak een `.env.local` (zie hieronder). Zonder sleutels valt de app terug op lokale opslag en een ingebouwde caption-generator.

## Omgevingsvariabelen

Deze staan in `.env.local` (lokaal, **gitignored**) en op Vercel — nooit in de repo:

| Variabele | Waarvoor |
|---|---|
| `ANTHROPIC_API_KEY` | AI-captions (Claude) |
| `APP_URL` | Basis-URL voor OAuth-redirects |
| `META_APP_ID` / `META_APP_SECRET` / `META_GRAPH_VERSION` | Facebook + Instagram |
| `INSTAGRAM_APP_ID` / `INSTAGRAM_APP_SECRET` | Instagram Login (los) |
| `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` | YouTube |
| `TIKTOK_CLIENT_KEY` / `TIKTOK_CLIENT_SECRET` | TikTok |
| `KV_REST_API_URL` / `KV_REST_API_TOKEN` | Upstash Redis |
| `BLOB_READ_WRITE_TOKEN` *of* `BLOB_STORE_ID` | Vercel Blob (media) |
| `CRON_SECRET` | Beveiligt het cron-endpoint |

## Deployen

```bash
npx vercel --prod
```

De cron (`vercel.json`) draait op Vercel Hobby max 1×/dag; voor exacte tijden roept een externe pinger (bv. cron-job.org) `/api/cron/publish?secret=$CRON_SECRET` elke minuut aan.
