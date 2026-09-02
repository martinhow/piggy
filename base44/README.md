# Savings Lottery — Budgeting Backend

Base44-native entities and backend functions implementing the budgeting
mechanism only (goal → daily target → piggy bank → savings pot →
forfeiture-to-lottery-pot). The lottery draw itself (tickets, winner
selection) is a separate, not-yet-built feature — this code only opens
the door for it by sweeping forfeited savings into a `LotteryPot`.

Written to Base44's own conventions (Deno backend functions +
JSON-Schema entities) so it can be pushed straight into an existing
Base44 project with the Base44 CLI. See **Deploying into Base44** below.

**Note on `apps/api/src/lottery.ts`**: this repo already has a
separate, earlier in-memory Express implementation of an overlapping
mechanism (`LotteryService`) — fixed-per-period contributions, no
piggy-bank/savings-pot split, and it already includes the lottery draw
itself. This `base44/` folder does **not** touch or replace that code.
The two need reconciling before both exist in the same product — see
the team conversation about which path (Base44-native functions vs.
the Express API) this project is actually taking.

## The mechanism, as specified

1. A user picks a target and a timeframe: "save £X over D days." The
   daily target is `£X / D`.
2. The user pre-funds a **piggy bank pot** (a buffer — e.g. £300 up
   front for a £33.33/day plan).
3. Every day, the system tries to move that day's target amount from
   the piggy bank pot into the **savings pot**. If the piggy bank has
   enough, it moves and the day is a **hit**.
4. If the piggy bank doesn't have enough that day, it's a **miss** —
   whatever partial balance is there is left alone (not swept, not
   credited).
5. **3 consecutive misses** forfeits the *entire* savings pot — it's
   swept to the shared **lottery pot**, and the goal ends (`status:
   "failed"`). The user would start a fresh goal to try again.
6. If the savings pot reaches the target amount, the goal is marked
   `"completed"`.

## Decisions made explicit (confirmed, not assumed)

These were genuinely ambiguous in the original spec and were confirmed
before building, since they change the state machine:

- **Partial shortfall**: if the piggy bank has *some* money but less
  than the day's target, that money is left untouched and the day
  still counts as a miss. (Not swept, not partial-credited.)
- **After forfeiture**: the goal ends as `"failed"`. It does **not**
  reset and continue — a forfeited goal is over.
- **Day boundary**: per-user (per-goal) local timezone, not a single
  global UTC cutoff. Each `SavingsGoal` stores its own `timezone`.

## Money handling

All amounts are stored and moved as **integer pence**, never floats
(fields are suffixed `_pence`). `£10,000 / 300 days = £33.333...`
can't be represented or moved as money without drift, so
`dailyTargetForDay()` distributes the exact remainder-in-pence across
the first N days (one extra penny each) so the 300 daily amounts sum
to *exactly* £10,000 — verified in the test suite. API request/response
bodies use plain pounds (e.g. `10000`, `33.3`); conversion happens at
the edges (`poundsToPence` / `penceToPounds` in `shared/budgeting.ts`).

## Entities (`entities/*.jsonc`)

| Entity | Purpose |
|---|---|
| `Wallet` | One per user. `main_balance_pence` — general funds not yet allocated to a goal. |
| `SavingsGoal` | One per savings challenge. Carries `target_amount_pence`, `duration_days`, `timezone`, `status`, `piggy_bank_balance_pence`, `savings_pot_balance_pence`, `current_streak_misses`, and the bookkeeping fields the scheduler uses (`days_evaluated_count`, `last_evaluated_date`). |
| `Transaction` | Append-only audit ledger for every money movement — deposits, piggy bank funding, daily hits/misses, forfeitures, completions. |
| `LotteryPot` | Minimal placeholder that just accumulates forfeited pence (`total_balance_pence`). The draw/winner logic is a separate feature. |

**MVP simplification**: a user has at most one *active* `SavingsGoal`
at a time (enforced in `createGoal`, not by the schema) — once a goal
completes or fails, they're free to start a new one. Multiple
concurrent goals per user would be a small, contained change if you
want it later.

## Functions (`functions/*/entry.ts`)

| Function | Trigger | What it does |
|---|---|---|
| `createGoal` | User (SDK call) | Validates input, blocks a 2nd concurrent active goal, creates the `SavingsGoal`, optionally logs initial piggy-bank funding. |
| `depositToMain` | User (SDK call) | Adds funds to the caller's `Wallet.main_balance_pence`. **Simulated** — there's no real payment provider wired up; swap the body for a Stripe/Open Banking webhook handler when that exists. |
| `fundPiggyBank` | User (SDK call) | Moves money from the caller's main balance into one of their own active goals' piggy bank — how a user tops up to avoid/recover from a miss. |
| `evaluateDailyContributions` | **Scheduled** (hourly cron, see its `function.jsonc`) | The core daily job. Runs as `asServiceRole` since no user is logged in on a cron trigger. See below for why hourly. |

Read-only lookups (get a goal, list a user's transactions, etc.) don't
need custom functions — Base44 auto-generates CRUD for every entity, so
the frontend can call `base44.entities.SavingsGoal.filter({...})`
directly.

### Why the daily job runs hourly, not at midnight

Each goal has its own timezone, so one global "run at midnight UTC"
cron can't correctly serve every user's actual midnight. Instead,
`evaluateDailyContributions` runs every hour and, for each active goal,
computes *that goal's* current local calendar date and catches up on
any day(s) not yet evaluated (`pendingEvaluationDates` in
`shared/budgeting.ts`). This is idempotent and self-healing: a goal
gets evaluated exactly once per local day regardless of which hour it
rolls over in, and if a run is ever missed, the next run catches up.

### Business logic lives in one pure, tested file

`shared/budgeting.ts` has **no** Base44/Deno imports — it's plain
TypeScript that transforms plain data (`evaluateGoalDay`,
`dailyTargetForDay`, the date helpers). Every `entry.ts` function is a
thin wrapper: fetch state → call the pure function → persist the
result → log a `Transaction`. This is deliberate: the money-movement
rules are the part that has to be exactly right, so they're isolated
from the SDK/database plumbing and covered by real unit tests instead
of only being "correct by inspection."

## Testing

From the repo root, matching the same `node:test` + `tsx` convention
already used in `apps/api`:

```bash
npx tsx --test base44/shared/budgeting.test.ts
```

24 tests, all passing, covering:

- The exact-penny distribution of daily targets (no floating-point
  drift across a full 300-day run).
- Hit / miss / forfeiture / completion transitions individually.
- A full 300-day simulation of the README's own £10,000-over-300-days
  example, asserting the total moved is exactly £10,000.
- A simulation where a user saves for 10 days, then goes dark for 3
  and forfeits mid-goal.
- Timezone-aware date handling (`localDateString`, `pendingEvaluationDates`,
  `nextDateString`), including a case where London and Auckland
  disagree about what day it is.

No `@base44/sdk`-dependent code (the `entry.ts` files) can be exercised
outside a real Base44 project/CLI, since they import `npm:@base44/sdk`
(a Deno-only specifier) and call live entity APIs — that's expected;
they're intentionally kept thin so the untested surface is small.

`tsconfig.json` in this folder is scoped to `base44/` only (it isn't
part of the root npm workspaces) and lets you type-check the functions
against `shared/base44-sdk.d.ts` — a hand-written stub of the real SDK,
kept in sync with `entities/*.jsonc` by hand, useful until the project
is deployed and `base44 types` can generate real ones:

```bash
npx tsc -p base44/tsconfig.json
```

## Deploying into Base44

1. Point the Base44 CLI at this project (or copy/git-merge just the
   `base44/` folder into wherever the teammate's Base44 project source
   lives), preserving the `entities/`, `functions/`, and `shared/`
   structure.
2. `base44 entities push` to deploy the four entity schemas.
3. `base44 functions push` (or `base44 deploy` for everything) to
   deploy the four functions. Deploying `evaluateDailyContributions`
   also registers its hourly cron automation (declared in its
   `function.jsonc`) — no separate cron setup needed.
4. Run `base44 types` to generate TypeScript types from the live
   entities, and swap them in for `shared/base44-sdk.d.ts` if you want
   generated types instead of the hand-maintained stub.
5. Wire the frontend to `base44.functions.createGoal(...)`,
   `depositToMain`, `fundPiggyBank`, and read goal/transaction state
   directly via `base44.entities.SavingsGoal.filter(...)` /
   `base44.entities.Transaction.filter(...)`.

## Open questions / deliberately out of scope

Carried over from the project README, still unresolved, worth deciding
before this goes near real money:

- Real payment rail for `depositToMain` (currently simulated).
- What happens if a goal runs past its planned `duration_days` without
  completing or forfeiting (currently: keeps charging the final day's
  rate indefinitely until it completes or fails — a reasonable but
  unconfirmed default).
- Whether a user should be able to run more than one goal at once.
- The lottery draw itself: ticket allocation, draw cadence, winner
  selection, and how/when a `LotteryPot` gets "drawn" and reset.
- Regulatory/lottery-licence and fund-safeguarding requirements (per
  the original README's disclaimer) — this code doesn't attempt to
  address those; it's application logic only.
- Reconciling this with `apps/api/src/lottery.ts` (see the note at the
  top of this file).
