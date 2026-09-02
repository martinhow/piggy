import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {
  dailyTargetForDay,
  evaluateGoalDay,
  localDateString,
  MISS_STREAK_FORFEIT_THRESHOLD,
  nextDateString,
  penceToPounds,
  pendingEvaluationDates,
  poundsToPence,
} from "./budgeting.ts";
import type { SavingsGoalState } from "./budgeting.ts";

// ---------------------------------------------------------------------------
// Money helpers
// ---------------------------------------------------------------------------

describe("poundsToPence / penceToPounds", () => {
  test("round-trips cleanly", () => {
    assert.equal(poundsToPence(10000), 1_000_000);
    assert.equal(poundsToPence(33.33), 3333);
    assert.equal(penceToPounds(1_000_000), 10000);
    assert.equal(penceToPounds(3333), 33.33);
  });

  test("rejects non-finite amounts", () => {
    assert.throws(() => poundsToPence(NaN));
    assert.throws(() => poundsToPence(Infinity));
  });
});

// ---------------------------------------------------------------------------
// dailyTargetForDay — the "no penny drift" guarantee
// ---------------------------------------------------------------------------

describe("dailyTargetForDay", () => {
  test("the README example (£10,000 / 300 days) sums to exactly the target", () => {
    const totalPence = poundsToPence(10000);
    const durationDays = 300;
    let sum = 0;
    for (let i = 0; i < durationDays; i++) {
      sum += dailyTargetForDay(totalPence, durationDays, i);
    }
    assert.equal(sum, totalPence, "daily targets must sum exactly to the goal, no rounding drift");
  });

  test("distributes the remainder across the first N days, one extra penny each", () => {
    // 1000 pence over 300 days -> base 3p/day, remainder 100p.
    // First 100 days get 4p, remaining 200 days get 3p.
    const totalPence = 1000;
    const durationDays = 300;
    assert.equal(dailyTargetForDay(totalPence, durationDays, 0), 4);
    assert.equal(dailyTargetForDay(totalPence, durationDays, 99), 4);
    assert.equal(dailyTargetForDay(totalPence, durationDays, 100), 3);
    assert.equal(dailyTargetForDay(totalPence, durationDays, 299), 3);

    let sum = 0;
    for (let i = 0; i < durationDays; i++) sum += dailyTargetForDay(totalPence, durationDays, i);
    assert.equal(sum, totalPence);
  });

  test("exact division has no remainder day", () => {
    // 900 pence over 300 days -> exactly 3p every day.
    assert.equal(dailyTargetForDay(900, 300, 0), 3);
    assert.equal(dailyTargetForDay(900, 300, 150), 3);
    assert.equal(dailyTargetForDay(900, 300, 299), 3);
  });

  test("clamps a day index beyond the schedule to the final day's rate", () => {
    const totalPence = poundsToPence(10000);
    const durationDays = 300;
    const lastDayTarget = dailyTargetForDay(totalPence, durationDays, 299);
    assert.equal(dailyTargetForDay(totalPence, durationDays, 500), lastDayTarget);
  });

  test("rejects a non-positive duration", () => {
    assert.throws(() => dailyTargetForDay(1000, 0, 0));
    assert.throws(() => dailyTargetForDay(1000, -5, 0));
  });
});

// ---------------------------------------------------------------------------
// evaluateGoalDay — the core state machine
// ---------------------------------------------------------------------------

function freshGoal(overrides: Partial<SavingsGoalState> = {}): SavingsGoalState {
  return {
    target_amount_pence: poundsToPence(10000),
    duration_days: 300,
    status: "active",
    piggy_bank_balance_pence: poundsToPence(300),
    savings_pot_balance_pence: 0,
    current_streak_misses: 0,
    days_evaluated_count: 0,
    last_evaluated_date: null,
    ...overrides,
  };
}

describe("evaluateGoalDay — hits", () => {
  test("a funded piggy bank moves exactly the day's target into the savings pot", () => {
    const goal = freshGoal();
    const dayTarget = dailyTargetForDay(goal.target_amount_pence, goal.duration_days, 0);

    const { result, nextState } = evaluateGoalDay(goal, "2026-09-02");

    assert.equal(result.outcome, "hit");
    assert.equal(result.amount_moved_pence, dayTarget);
    assert.equal(result.forfeited_amount_pence, 0);
    assert.equal(result.streak_misses_after, 0);
    assert.equal(nextState.piggy_bank_balance_pence, goal.piggy_bank_balance_pence - dayTarget);
    assert.equal(nextState.savings_pot_balance_pence, dayTarget);
    assert.equal(nextState.current_streak_misses, 0);
    assert.equal(nextState.days_evaluated_count, 1);
    assert.equal(nextState.last_evaluated_date, "2026-09-02");
    assert.equal(nextState.status, "active");
  });

  test("a hit resets an in-progress miss streak", () => {
    const goal = freshGoal({ current_streak_misses: 2 });
    const { result, nextState } = evaluateGoalDay(goal, "2026-09-02");
    assert.equal(result.outcome, "hit");
    assert.equal(nextState.current_streak_misses, 0);
  });

  test("the day the savings pot reaches the target, the goal completes", () => {
    const target = 300; // pence — a tiny goal so the test is easy to eyeball
    const duration = 3;
    // Day 2 (0-indexed) target = 100p; pot already has 200p from days 0-1.
    const goal = freshGoal({
      target_amount_pence: target,
      duration_days: duration,
      piggy_bank_balance_pence: 100,
      savings_pot_balance_pence: 200,
      days_evaluated_count: 2,
    });

    const { result, nextState } = evaluateGoalDay(goal, "2026-09-04");

    assert.equal(result.outcome, "completed");
    assert.equal(nextState.savings_pot_balance_pence, target);
    assert.equal(nextState.status, "completed");
  });
});

describe("evaluateGoalDay — misses", () => {
  test("an empty piggy bank is a miss: nothing moves, streak increments by 1", () => {
    const goal = freshGoal({ piggy_bank_balance_pence: 0, savings_pot_balance_pence: 500 });
    const { result, nextState } = evaluateGoalDay(goal, "2026-09-02");

    assert.equal(result.outcome, "miss");
    assert.equal(result.amount_moved_pence, 0);
    assert.equal(result.forfeited_amount_pence, 0);
    assert.equal(nextState.piggy_bank_balance_pence, 0, "piggy bank is left untouched, not credited");
    assert.equal(nextState.savings_pot_balance_pence, 500, "savings pot is untouched on a plain miss");
    assert.equal(nextState.current_streak_misses, 1);
    assert.equal(nextState.status, "active");
  });

  test("a partial piggy bank balance below the target is also a miss, and is left untouched", () => {
    const dayTarget = dailyTargetForDay(poundsToPence(10000), 300, 0); // 3334p
    const goal = freshGoal({ piggy_bank_balance_pence: dayTarget - 1 });

    const { result, nextState } = evaluateGoalDay(goal, "2026-09-02");

    assert.equal(result.outcome, "miss");
    assert.equal(nextState.piggy_bank_balance_pence, dayTarget - 1, "partial balance is not swept away");
    assert.equal(nextState.current_streak_misses, 1);
  });

  test("exactly enough (balance === target) is a hit, not a miss", () => {
    const dayTarget = dailyTargetForDay(poundsToPence(10000), 300, 0);
    const goal = freshGoal({ piggy_bank_balance_pence: dayTarget });
    const { result } = evaluateGoalDay(goal, "2026-09-02");
    assert.equal(result.outcome, "hit");
  });
});

describe("evaluateGoalDay — forfeiture", () => {
  test(`the ${MISS_STREAK_FORFEIT_THRESHOLD}rd consecutive miss forfeits the entire savings pot and fails the goal`, () => {
    let goal = freshGoal({
      piggy_bank_balance_pence: 0,
      savings_pot_balance_pence: poundsToPence(1200),
      current_streak_misses: 0,
    });

    // Day 1: miss (streak -> 1)
    let step = evaluateGoalDay(goal, "2026-09-01");
    assert.equal(step.result.outcome, "miss");
    assert.equal(step.result.streak_misses_after, 1);
    assert.equal(step.nextState.status, "active");
    goal = step.nextState;

    // Day 2: miss (streak -> 2)
    step = evaluateGoalDay(goal, "2026-09-02");
    assert.equal(step.result.outcome, "miss");
    assert.equal(step.result.streak_misses_after, 2);
    assert.equal(step.nextState.status, "active");
    goal = step.nextState;

    // Day 3: miss (streak -> 3) -> forfeiture
    step = evaluateGoalDay(goal, "2026-09-03");
    assert.equal(step.result.outcome, "forfeited");
    assert.equal(step.result.streak_misses_after, 3);
    assert.equal(step.result.forfeited_amount_pence, poundsToPence(1200), "the whole savings pot is forfeited");
    assert.equal(step.nextState.savings_pot_balance_pence, 0, "savings pot is wiped to zero");
    assert.equal(step.nextState.status, "failed", "goal ends as failed, it does not reset and continue");
  });

  test("a hit anywhere in the streak prevents forfeiture (streak fully resets, not just decrements)", () => {
    let goal = freshGoal({
      piggy_bank_balance_pence: 0,
      savings_pot_balance_pence: poundsToPence(500),
    });

    goal = evaluateGoalDay(goal, "2026-09-01").nextState; // miss, streak 1
    goal = evaluateGoalDay(goal, "2026-09-02").nextState; // miss, streak 2
    assert.equal(goal.current_streak_misses, 2);

    // Top up the piggy bank before day 3's check.
    const dayTarget = dailyTargetForDay(goal.target_amount_pence, goal.duration_days, goal.days_evaluated_count);
    goal = { ...goal, piggy_bank_balance_pence: dayTarget };

    const step = evaluateGoalDay(goal, "2026-09-03");
    assert.equal(step.result.outcome, "hit");
    assert.equal(step.nextState.current_streak_misses, 0);
    assert.equal(step.nextState.status, "active");
    assert.ok(step.nextState.savings_pot_balance_pence > 0, "savings survive because forfeiture never triggered");
  });

  test("evaluating a non-active goal throws rather than silently doing nothing", () => {
    const goal = freshGoal({ status: "failed" });
    assert.throws(() => evaluateGoalDay(goal, "2026-09-02"));
  });
});

// ---------------------------------------------------------------------------
// Full end-to-end simulation: the README's own worked example
// ---------------------------------------------------------------------------

describe("full simulation — £10,000 over 300 days, funded every day", () => {
  test("completes on day 300 having moved exactly £10,000 in total, no drift", () => {
    let goal = freshGoal({
      piggy_bank_balance_pence: poundsToPence(10000), // pretend infinite top-ups available
      savings_pot_balance_pence: 0,
    });

    let totalMoved = 0;
    let date = "2026-01-01";
    let lastOutcome = "";

    for (let i = 0; i < 300 && goal.status === "active"; i++) {
      const { result, nextState } = evaluateGoalDay(goal, date);
      totalMoved += result.amount_moved_pence;
      lastOutcome = result.outcome;
      goal = nextState;
      date = nextDateString(date);
    }

    assert.equal(lastOutcome, "completed");
    assert.equal(goal.status, "completed");
    assert.equal(totalMoved, poundsToPence(10000), "no rounding drift across the full 300-day run");
    assert.equal(goal.savings_pot_balance_pence, poundsToPence(10000));
  });

  test("a user who funds daily but goes dark for 3 days forfeits mid-goal", () => {
    let goal = freshGoal({
      piggy_bank_balance_pence: dailyTargetForDay(poundsToPence(10000), 300, 0),
      savings_pot_balance_pence: 0,
    });
    let date = "2026-01-01";

    // Fund and hit for the first 10 days.
    for (let i = 0; i < 10; i++) {
      const { nextState } = evaluateGoalDay(goal, date);
      goal = nextState;
      date = nextDateString(date);
      // Top up exactly enough for the next day.
      if (goal.status === "active") {
        const nextTarget = dailyTargetForDay(goal.target_amount_pence, goal.duration_days, goal.days_evaluated_count);
        goal = { ...goal, piggy_bank_balance_pence: nextTarget };
      }
    }
    const savedBeforeForfeit = goal.savings_pot_balance_pence;
    assert.ok(savedBeforeForfeit > 0);

    // Now go dark: empty the piggy bank and miss 3 days in a row.
    goal = { ...goal, piggy_bank_balance_pence: 0 };
    let lastResult;
    for (let i = 0; i < 3; i++) {
      const step = evaluateGoalDay(goal, date);
      lastResult = step.result;
      goal = step.nextState;
      date = nextDateString(date);
    }

    assert.equal(lastResult?.outcome, "forfeited");
    assert.equal(lastResult?.forfeited_amount_pence, savedBeforeForfeit);
    assert.equal(goal.status, "failed");
    assert.equal(goal.savings_pot_balance_pence, 0);
  });
});

// ---------------------------------------------------------------------------
// Timezone-aware date helpers
// ---------------------------------------------------------------------------

describe("localDateString", () => {
  test("returns the calendar date in the given IANA timezone, not UTC", () => {
    // Noon UTC on 2026-09-02: still 2026-09-02 in London (BST, UTC+1) but
    // already 2026-09-03 in Auckland (NZST, UTC+12, ahead of DST that year).
    const instant = new Date("2026-09-02T12:00:00Z");
    assert.equal(localDateString(instant, "Europe/London"), "2026-09-02");
    assert.equal(localDateString(instant, "Pacific/Auckland"), "2026-09-03");
  });
});

describe("nextDateString", () => {
  test("rolls over months and years correctly", () => {
    assert.equal(nextDateString("2026-09-02"), "2026-09-03");
    assert.equal(nextDateString("2026-09-30"), "2026-10-01");
    assert.equal(nextDateString("2026-12-31"), "2027-01-01");
    // 2028 is a leap year.
    assert.equal(nextDateString("2028-02-28"), "2028-02-29");
  });
});

describe("pendingEvaluationDates", () => {
  test("returns [] when nothing is due yet (today is still the start date, already evaluated)", () => {
    assert.deepEqual(pendingEvaluationDates("2026-09-02", "2026-09-02", "2026-09-02"), []);
  });

  test("returns the start date on the very first run", () => {
    assert.deepEqual(pendingEvaluationDates("2026-09-02", null, "2026-09-02"), ["2026-09-02"]);
  });

  test("catches up multiple missed calendar days in order", () => {
    assert.deepEqual(
      pendingEvaluationDates("2026-09-01", "2026-09-02", "2026-09-05"),
      ["2026-09-03", "2026-09-04", "2026-09-05"],
    );
  });

  test("never returns a future date", () => {
    assert.deepEqual(pendingEvaluationDates("2026-09-02", "2026-09-05", "2026-09-05"), []);
  });
});
