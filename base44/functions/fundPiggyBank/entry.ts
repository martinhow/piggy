// base44/functions/fundPiggyBank/entry.ts
//
// User-invoked. Moves money from the caller's Wallet.main_balance_pence
// into one of their own active goal's piggy_bank_balance_pence — this is
// how a user tops up to avoid (or recover from) a missed day.
//
// Body:
//   goal_id   string   the SavingsGoal to fund   (required)
//   amount    number   pounds, e.g. 50            (required)

import { createClientFromRequest } from "npm:@base44/sdk";
import { penceToPounds, poundsToPence } from "../../shared/budgeting.ts";

interface FundPiggyBankBody {
  goal_id: string;
  amount: number;
}

export default async function (req: Request): Promise<Response> {
  try {
    const base44 = createClientFromRequest(req);
    const user = await base44.auth.me();
    if (!user) {
      return Response.json({ error: "Authentication required." }, { status: 401 });
    }

    const body = (await req.json()) as FundPiggyBankBody;
    if (!body.goal_id) {
      return Response.json({ error: "goal_id is required." }, { status: 400 });
    }
    if (!Number.isFinite(body.amount) || body.amount <= 0) {
      return Response.json({ error: "amount must be a positive number." }, { status: 400 });
    }
    const amountPence = poundsToPence(body.amount);

    const goal = await base44.entities.SavingsGoal.get(body.goal_id);
    if (!goal || goal.user_id !== user.id) {
      return Response.json({ error: "Goal not found." }, { status: 404 });
    }
    if (goal.status !== "active") {
      return Response.json({ error: `Goal is ${goal.status}; it can no longer be funded.` }, { status: 409 });
    }

    const [wallet] = await base44.entities.Wallet.filter({ user_id: user.id });
    if (!wallet || wallet.main_balance_pence < amountPence) {
      return Response.json({ error: "Insufficient main balance." }, { status: 400 });
    }

    await base44.entities.Wallet.update(wallet.id, {
      main_balance_pence: wallet.main_balance_pence - amountPence,
    });

    const updatedGoal = await base44.entities.SavingsGoal.update(goal.id, {
      piggy_bank_balance_pence: goal.piggy_bank_balance_pence + amountPence,
    });

    await base44.entities.Transaction.create({
      user_id: user.id,
      goal_id: goal.id,
      type: "piggy_bank_funding",
      amount_pence: amountPence,
      from_pot: "main",
      to_pot: "piggy_bank",
      occurred_on: new Date().toISOString().slice(0, 10),
    });

    return Response.json({ piggy_bank_balance: penceToPounds(updatedGoal.piggy_bank_balance_pence) });
  } catch (err) {
    console.error("fundPiggyBank failed", err);
    return Response.json({ error: "Failed to fund piggy bank." }, { status: 500 });
  }
}
