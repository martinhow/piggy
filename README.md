# Piggy

TypeScript web application monorepo.

## Apps

- `apps/web` — React frontend, served by Vite on `http://localhost:5173`
- `apps/api` — Express API, served on `http://localhost:3000`
- `packages/shared` — types and utilities that can be used by both apps

## Getting started

```bash
npm install
npm run dev
```

Copy `apps/api/.env.example` to `apps/api/.env` before adding environment-specific API settings.

## Commands

```bash
npm run dev       # run frontend and API together
npm run build     # build every workspace
npm run typecheck # check every workspace
npm run lint      # lint every workspace
```
