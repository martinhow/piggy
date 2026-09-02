# Savings Lottery

A habit-building savings app that rewards consistency and uses forfeited savings to fund a shared prize pool.

## Concept

Users set a personal savings goal, such as saving **£10,000 in 10 months**. The app translates this into a regular contribution target—for example, roughly **£30 per day** over 300 days. Users who consistently meet their savings commitments earn entries into a periodic lottery.

## How it works

1. **Set a goal**
   - Choose a savings target and timeframe.
   - The app calculates the required daily, weekly, or monthly contribution.
2. **Save consistently**
   - Make the required deposits for each savings period.
   - Each amount saved earns lottery tickets.
3. **Miss consecutive periods**
   - If a user fails to save for a defined number of consecutive periods (for example, three), the money accumulated in their savings pot is forfeited into the shared lottery pool.
4. **Enter the draw**
   - Only users still successfully following their savings plan can participate.
   - Ticket allocation is proportional to the amount saved:
     - £1 saved = 1 ticket
     - £1,000 saved = 1,000 tickets
5. **Win the pool**
   - A single winner is selected at the end of each draw period, such as monthly or quarterly.
   - If no one forfeits savings, no lottery is run.

## Why it matters

The product is designed to make saving more motivating by combining:

- Clear, personalised savings goals
- Accountability for missed contributions
- A shared reward for successful savers
- A lottery-style incentive without relying on investment returns

## Comparison

The concept is loosely similar to prize-linked savings products such as NS&I Premium Bonds. However, instead of distributing returns generated from investments, this model’s prize pool is funded by savings forfeited by users who repeatedly fail to meet their commitments.

## Open questions

- What counts as a missed savings period: daily, weekly, or monthly?
- How many consecutive misses trigger forfeiture?
- Should draws be monthly, quarterly, or configurable?
- How are funds held securely and separately from company funds?
- What regulatory approvals or lottery licences are required in the UK?
- How should users be protected from setting unrealistic goals?

## Disclaimer

This is an early concept. Any implementation involving user savings, prize draws, or forfeited funds would require legal, regulatory, and financial-compliance review.

## Development

This repository is a TypeScript monorepo:

- `apps/web` — React frontend, served by Vite on `http://localhost:5173`
- `apps/api` — Express API, served on `http://localhost:3000`
- `packages/shared` — types and utilities used by both apps

### Getting started

```bash
npm install
npm run dev
```

Copy `apps/api/.env.example` to `apps/api/.env` before adding environment-specific API settings.

### Commands

```bash
npm run dev       # run frontend and API together
npm run build     # build every workspace
npm run typecheck # check every workspace
npm run lint      # lint every workspace
```

### Lottery API (development only)

The API currently uses an in-memory implementation of the lottery rules. Set `PRIZE_POOL_STARTING_PENCE` to seed the prize pool, then use these endpoints:

- `POST /api/lottery/plans` — create a daily plan with `userId`, `targetPence`, `requiredContributionPence`, and `createdAt` (`YYYY-MM-DD`)
- `POST /api/lottery/plans/:planId/daily-contributions` — submit `amountPence` and `date`; a third consecutive contribution below the required amount forfeits the entire pot
- `POST /api/lottery/draws/monthly` — run a winner-takes-all draw with `drawnAt`; tickets are one per whole £1 saved
- `GET /api/lottery` — inspect the current pool, plans, and draw history

All amounts are integer pence. This is deliberately a prototype: it does not persist data, connect to payment providers, or move funds.
