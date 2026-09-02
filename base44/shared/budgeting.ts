// base44/shared/budgeting.ts
//
// Pure, side-effect-free budgeting logic for the Savings Lottery app.
// Nothing in this file talks to Base44, Deno, or a database — it only
// transforms plain data. That means it can be unit tested with an
// ordinary TypeScript test runner (see /tests/budgeting.test.ts) even
// though the functions that *call* it (base44/functions/**/entry.ts)
// only run inside Base44's Deno runtime.
//
// Money is always handled in integer pence (GBP minor units), never as
// a float, to avoid the classic 33.33 * 300 !== 10000 rounding drift.

export type GoalStatus = "active" | "completed" | "failed";

export interface SavingsGoalState {
  target_amount_pence: number;
  duration_days: number;
  status: GoalStatus;
  piggy_bank_balance_pence: number;
  savings_pot_balance_pence: number;
  current_streak_misses: number;
  days_evaluated_count: number;
  last_evaluated_date: string | null; // YYYY-MM-DD, in the goal's timezone
}

export type DayOutcome = "hit" | "miss" | "forfeited" | "completed";

export interface DayEvaluationResult {
  outcome: DayOutcome;
  date: string;
  /** Piggy bank -> savings pot, on a "hit" or "completed" day. */
  amount_moved_pence: number;
  /** Savings pot -> lottery pot, on a "forfeited" day. */
  forfeited_amount_pence: number;
  streak_misses_after: number;
  goal_status_after: GoalStatus;
}

/** Three consecutive missed days forfeits the whole savings pot. */
export const MISS_STREAK_FORFEIT_THRESHOLD = 3;

// ---------------------------------------------------------------------------
// Money helpers
// ---------------------------------------------------------------------------

export function poundsToPence(pounds: number): number {
  if (!Number.isFinite(pounds)) {
    throw new Error(`Amount must be a finite number, got: ${pounds}`);
  }
  return Math.round(pounds * 100);
}

export function penceToPounds(pence: number): number {
  return Math.round(pence) / 100;
}

/**
 * Splits `totalPence` into `durationDays` daily amounts that sum EXACTLY
 * to `totalPence` — no floating-point drift, ever. Plain division
 * (e.g. £10,000 / 300 days = £33.333...) can't be stored or moved as
 * money, so the remainder (in pence) is distributed one penny at a time
 * across the first `remainder` days.
 *
 * Example: 1,000,000p over 300 days -> base 3333p/day, remainder 100p,
 * so days 0-99 target 3334p and days 100-299 target 3333p. Sum = exactly
 * 1,000,000p.
 *
 * If `dayIndex` is beyond the schedule (the goal has run past its
 * planned duration without completing or being forfeited), it's clamped
 * to the final day's rate rather than throwing.
 */
export function dailyTargetForDay(
  totalPence: number,
  durationDays: number,
  dayIndex: number,
): number {
  if (durationDays <= 0) {
    throw new Error("durationDays must be > 0");
  }
  const clampedIndex = Math.min(Math.max(dayIndex, 0), durationDays - 1);
  const base = Math.floor(totalPence / durationDays);
  const remainder = totalPence % durationDays;
  return clampedIndex < remainder ? base + 1 : base;
}

// ---------------------------------------------------------------------------
// Date helpers (per-goal timezone day boundaries)
// ---------------------------------------------------------------------------

/** Returns YYYY-MM-DD for the given instant, in the given IANA timezone. */
export function localDateString(instant: Date, timeZone: string): string {
  // en-CA happens to format as YYYY-MM-DD, which is what we want and is
  // also lexicographically sortable/comparable as a plain string.
  const formatter = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  });
  return formatter.format(instant);
}

/** Returns the calendar date string one day after `dateStr`. */
export function nextDateString(dateStr: string): string {
  const [y, m, d] = dateStr.split("-").map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  dt.setUTCDate(dt.getUTCDate() + 1);
  return dt.toISOString().slice(0, 10);
}

/**
 * Returns every calendar date that still needs evaluating, in order:
 * everything after `lastEvaluatedDate` (or from `startDate` if nothing
 * has been evaluated yet) up to and including `todayLocal`. Never
 * returns a future date.
 */
export function pendingEvaluationDates(
  startDate: string,
  lastEvaluatedDate: string | null,
  todayLocal: string,
): string[] {
  const first = lastEvaluatedDate ? nextDateString(lastEvaluatedDate) : startDate;
  if (first > todayLocal) return [];

  const dates: string[] = [];
  let cursor = first;
  while (cursor <= todayLocal) {
    dates.push(cursor);
    cursor = nextDateString(cursor);
  }
  return dates;
}

// ---------------------------------------------------------------------------
// Core state machine
// ---------------------------------------------------------------------------

/**
 * Evaluates ONE calendar day for ONE goal, given its state going into
 * that day. Pure function: takes state, returns { result, nextState }.
 * The caller (a Base44 function) is responsible for persisting
 * `nextState` and for logging `result` as a Transaction.
 *
 * Rules encoded here (confirmed with the product owner):
 *  - If piggy_bank_balance_pence >= that day's target: move the target
 *    amount piggy bank -> savings pot. Streak resets to 0. If the
 *    savings pot now meets/exceeds target_amount_pence, the goal is
 *    "completed".
 *  - If piggy_bank_balance_pence < that day's target: it's a miss.
 *    The partial balance is left untouched (not swept, not credited).
 *    The streak increments. On the 3rd consecutive miss, the ENTIRE
 *    savings pot is forfeited (zeroed; the caller sweeps that amount to
 *    the shared LotteryPot) and the goal's status becomes "failed" —
 *    it does not reset and continue.
 */
export function evaluateGoalDay(
  goal: SavingsGoalState,
  date: string,
): { result: DayEvaluationResult; nextState: SavingsGoalState } {
  if (goal.status !== "active") {
    throw new Error(`Cannot evaluate a goal that is not active (status=${goal.status})`);
  }

  const dayIndex = goal.days_evaluated_count;
  const targetPence = dailyTargetForDay(goal.target_amount_pence, goal.duration_days, dayIndex);

  if (goal.piggy_bank_balance_pence >= targetPence) {
    // HIT.
    const newPiggyBank = goal.piggy_bank_balance_pence - targetPence;
    const newSavingsPot = goal.savings_pot_balance_pence + targetPence;
    const goalComplete = newSavingsPot >= goal.target_amount_pence;

    const nextState: SavingsGoalState = {
      ...goal,
      piggy_bank_balance_pence: newPiggyBank,
      savings_pot_balance_pence: newSavingsPot,
      current_streak_misses: 0,
      days_evaluated_count: goal.days_evaluated_count + 1,
      last_evaluated_date: date,
      status: goalComplete ? "completed" : "active",
    };

    return {
      result: {
        outcome: goalComplete ? "completed" : "hit",
        date,
        amount_moved_pence: targetPence,
        forfeited_amount_pence: 0,
        streak_misses_after: 0,
        goal_status_after: nextState.status,
      },
      nextState,
    };
  }

  // MISS: leave the partial piggy-bank balance untouched.
  const newStreak = goal.current_streak_misses + 1;
  const forfeit = newStreak >= MISS_STREAK_FORFEIT_THRESHOLD;
  const forfeitedAmount = forfeit ? goal.savings_pot_balance_pence : 0;

  const nextState: SavingsGoalState = {
    ...goal,
    current_streak_misses: newStreak,
    days_evaluated_count: goal.days_evaluated_count + 1,
    last_evaluated_date: date,
    savings_pot_balance_pence: forfeit ? 0 : goal.savings_pot_balance_pence,
    status: forfeit ? "failed" : "active",
  };

  return {
    result: {
      outcome: forfeit ? "forfeited" : "miss",
      date,
      amount_moved_pence: 0,
      forfeited_amount_pence: forfeitedAmount,
      streak_misses_after: newStreak,
      goal_status_after: nextState.status,
    },
    nextState,
  };
}
