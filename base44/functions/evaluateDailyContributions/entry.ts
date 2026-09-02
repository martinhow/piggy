// base44/functions/evaluateDailyContributions/entry.ts
//
// SCHEDULED function — see function.jsonc, which runs this every hour
// via a Base44 automation. Nobody is logged in when a cron trigger
// fires, so every entity operation here goes through
// base44.asServiceRole to bypass row-level access rules.
//
// Why hourly, when this is meant to be a "daily" check? Every goal
// carries its own IANA timezone, so a single global "run at midnight"
// cron can't correctly serve users in different timezones. Instead
// this runs frequently and, for each active goal, works out that
// goal's OWN current local calendar date and catches up on any
// calendar day(s) not yet evaluated (see pendingEvaluationDates in
// shared/budgeting.ts). Running hourly with an idempotent day-by-day
// catch-up loop means a goal is evaluated exactly once per local day
// no matter which hour it happens to roll over in, and the system
// self-heals if a run is ever missed (an outage, a slow run, etc.).
//
// All the actual hit/miss/forfeiture decision logic lives in the pure,
// unit-tested evaluateGoalDay() function — this file's only job is to
// fetch state, call that function once per pending day, and persist
// the result.

import { createClientFromRequest } from "npm:@base44/sdk";
import type { Base44Client } from "npm:@base44/sdk";
import { evaluateGoalDay, localDateString, pendingEvaluationDates } from "../../shared/budgeting.ts";
import type { SavingsGoalState } from "../../shared/budgeting.ts";

// Safety cap on how many missed days a single run will catch up in one
// goal, in case a goal is somehow left unevaluated for a very long
// time. Well above any realistic goal duration.
const MAX_CATCHUP_DAYS_PER_RUN = 370;

// base44.asServiceRole is typed as a full Base44Client (see
// base44/shared/base44-sdk.d.ts, a local stub kept in sync with
// base44/entities/*.jsonc by hand). Once this is pushed into a real
// Base44 project, run `base44 types` there and swap in the generated
// types if you want them instead of the hand-maintained stub.
type ServiceRoleClient = Base44Client;

export default async function (req: Request): Promise<Response> {
  const base44 = createClientFromRequest(req);
  const admin: ServiceRoleClient = base44.asServiceRole;

  const now = new Date();

  const activeGoals = await admin.entities.SavingsGoal.filter(
    { status: "active" },
    "-created_date",
    5000,
  );

  const summary = {
    goals_checked: activeGoals.length,
    days_evaluated: 0,
    forfeitures: 0,
    completions: 0,
    errors: [] as { goal_id: string; message: string }[],
  };

  for (const goal of activeGoals) {
    try {
      const timezone = goal.timezone ?? "Europe/London";
      const todayLocal = localDateString(now, timezone);

      const pending = pendingEvaluationDates(
        goal.start_date,
        goal.last_evaluated_date ?? null,
        todayLocal,
      ).slice(0, MAX_CATCHUP_DAYS_PER_RUN);

      if (pending.length === 0) continue;

      let state: SavingsGoalState = {
        target_amount_pence: goal.target_amount_pence,
        duration_days: goal.duration_days,
        status: goal.status,
        piggy_bank_balance_pence: goal.piggy_bank_balance_pence,
        savings_pot_balance_pence: goal.savings_pot_balance_pence,
        current_streak_misses: goal.current_streak_misses,
        days_evaluated_count: goal.days_evaluated_count,
        last_evaluated_date: goal.last_evaluated_date ?? null,
      };

      for (const date of pending) {
        if (state.status !== "active") break; // completed/failed mid-catch-up

        const { result, nextState } = evaluateGoalDay(state, date);
        state = nextState;
        summary.days_evaluated += 1;

        const transactionType =
          result.outcome === "forfeited"
            ? "forfeiture"
            : result.outcome === "completed"
            ? "goal_completed"
            : result.outcome === "hit"
            ? "daily_contribution"
            : "daily_miss";

        await admin.entities.Transaction.create({
          user_id: goal.user_id,
          goal_id: goal.id,
          type: transactionType,
          amount_pence:
            result.outcome === "forfeited" ? result.forfeited_amount_pence : result.amount_moved_pence,
          from_pot: result.outcome === "forfeited" ? "savings_pot" : "piggy_bank",
          to_pot:
            result.outcome === "forfeited"
              ? "lottery_pot"
              : result.outcome === "hit" || result.outcome === "completed"
              ? "savings_pot"
              : "none",
          occurred_on: date,
        });

        if (result.outcome === "forfeited") {
          summary.forfeitures += 1;
          await sweepToLotteryPot(admin, result.forfeited_amount_pence);
        }
        if (result.outcome === "completed") {
          summary.completions += 1;
        }
      }

      await admin.entities.SavingsGoal.update(goal.id, {
        status: state.status,
        piggy_bank_balance_pence: state.piggy_bank_balance_pence,
        savings_pot_balance_pence: state.savings_pot_balance_pence,
        current_streak_misses: state.current_streak_misses,
        days_evaluated_count: state.days_evaluated_count,
        last_evaluated_date: state.last_evaluated_date,
      });
    } catch (err) {
      console.error(`evaluateDailyContributions: failed for goal ${goal.id}`, err);
      summary.errors.push({ goal_id: goal.id, message: String(err) });
    }
  }

  return Response.json(summary);
}

async function sweepToLotteryPot(admin: ServiceRoleClient, amountPence: number): Promise<void> {
  if (amountPence <= 0) return;

  const [openPot] = await admin.entities.LotteryPot.filter({ status: "open" });
  if (openPot) {
    await admin.entities.LotteryPot.update(openPot.id, {
      total_balance_pence: openPot.total_balance_pence + amountPence,
    });
  } else {
    await admin.entities.LotteryPot.create({
      total_balance_pence: amountPence,
      status: "open",
    });
  }
}
