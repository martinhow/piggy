// base44/functions/createGoal/entry.ts
//
// User-invoked. Called via the SDK from the logged-in frontend
// (base44.functions.createGoal(...) or an HTTP POST), so the request
// carries the caller's own auth — no asServiceRole needed here.
//
// Body:
//   target_amount               number  pounds, e.g. 10000     (required)
//   duration_days                integer days, e.g. 300         (required)
//   start_date                  string  "YYYY-MM-DD"            (optional, defaults to today)
//   timezone                    string  IANA tz name            (optional, defaults to "Europe/London")
//   initial_piggy_bank_funding  number  pounds, e.g. 300        (optional, defaults to 0)

import { createClientFromRequest } from "npm:@base44/sdk";
import { dailyTargetForDay, penceToPounds, poundsToPence } from "../../shared/budgeting.ts";

interface CreateGoalBody {
  target_amount: number;
  duration_days: number;
  start_date?: string;
  timezone?: string;
  initial_piggy_bank_funding?: number;
}

export default async function (req: Request): Promise<Response> {
  try {
    const base44 = createClientFromRequest(req);
    const user = await base44.auth.me();
    if (!user) {
      return Response.json({ error: "Authentication required." }, { status: 401 });
    }

    const body = (await req.json()) as CreateGoalBody;

    if (!Number.isFinite(body.target_amount) || body.target_amount <= 0) {
      return Response.json({ error: "target_amount must be a positive number." }, { status: 400 });
    }
    if (!Number.isInteger(body.duration_days) || body.duration_days <= 0) {
      return Response.json({ error: "duration_days must be a positive integer." }, { status: 400 });
    }

    const timezone = body.timezone ?? "Europe/London";
    try {
      // Throws if the IANA name is not recognised.
      new Intl.DateTimeFormat("en-GB", { timeZone: timezone });
    } catch {
      return Response.json({ error: `Unrecognised timezone: ${timezone}` }, { status: 400 });
    }

    const startDate = body.start_date ?? new Date().toISOString().slice(0, 10);

    const initialFundingPounds = body.initial_piggy_bank_funding ?? 0;
    if (!Number.isFinite(initialFundingPounds) || initialFundingPounds < 0) {
      return Response.json({ error: "initial_piggy_bank_funding must be >= 0." }, { status: 400 });
    }

    // MVP rule: at most one active goal per user at a time. A user whose
    // goal completed or failed is free to start a new one.
    const existingActive = await base44.entities.SavingsGoal.filter({
      user_id: user.id,
      status: "active",
    });
    if (existingActive.length > 0) {
      return Response.json(
        {
          error:
            "You already have an active savings goal. It must complete or fail before you can start another.",
        },
        { status: 409 },
      );
    }

    const targetAmountPence = poundsToPence(body.target_amount);
    const initialFundingPence = poundsToPence(initialFundingPounds);

    const goal = await base44.entities.SavingsGoal.create({
      user_id: user.id,
      target_amount_pence: targetAmountPence,
      duration_days: body.duration_days,
      start_date: startDate,
      timezone,
      status: "active",
      piggy_bank_balance_pence: initialFundingPence,
      savings_pot_balance_pence: 0,
      current_streak_misses: 0,
      days_evaluated_count: 0,
    });

    if (initialFundingPence > 0) {
      await base44.entities.Transaction.create({
        user_id: user.id,
        goal_id: goal.id,
        type: "piggy_bank_funding",
        amount_pence: initialFundingPence,
        from_pot: "external",
        to_pot: "piggy_bank",
        occurred_on: startDate,
        note: "Initial piggy bank funding provided at goal creation.",
      });
    }

    const firstDayTargetPence = dailyTargetForDay(targetAmountPence, body.duration_days, 0);

    return Response.json(
      {
        goal: {
          id: goal.id,
          target_amount: penceToPounds(targetAmountPence),
          duration_days: body.duration_days,
          start_date: startDate,
          timezone,
          status: goal.status,
          piggy_bank_balance: penceToPounds(initialFundingPence),
          savings_pot_balance: 0,
          first_day_target: penceToPounds(firstDayTargetPence),
        },
      },
      { status: 201 },
    );
  } catch (err) {
    console.error("createGoal failed", err);
    return Response.json({ error: "Failed to create goal." }, { status: 500 });
  }
}
