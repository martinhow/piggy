// base44/functions/depositToMain/entry.ts
//
// User-invoked. Adds funds to the caller's Wallet.main_balance_pence.
//
// This SIMULATES an external top-up (bank transfer / card payment) —
// there is no real payment provider wired up yet. Replace the body of
// this function with a payment-provider webhook handler (Stripe,
// TrueLayer/Open Banking, etc.) when that integration exists; keep the
// Wallet update + Transaction log the same.
//
// Body:
//   amount   number  pounds, e.g. 300   (required)

import { createClientFromRequest } from "npm:@base44/sdk";
import { penceToPounds, poundsToPence } from "../../shared/budgeting.ts";

interface DepositBody {
  amount: number;
}

export default async function (req: Request): Promise<Response> {
  try {
    const base44 = createClientFromRequest(req);
    const user = await base44.auth.me();
    if (!user) {
      return Response.json({ error: "Authentication required." }, { status: 401 });
    }

    const body = (await req.json()) as DepositBody;
    if (!Number.isFinite(body.amount) || body.amount <= 0) {
      return Response.json({ error: "amount must be a positive number." }, { status: 400 });
    }
    const amountPence = poundsToPence(body.amount);

    let [wallet] = await base44.entities.Wallet.filter({ user_id: user.id });
    if (!wallet) {
      wallet = await base44.entities.Wallet.create({ user_id: user.id, main_balance_pence: 0 });
    }

    const updated = await base44.entities.Wallet.update(wallet.id, {
      main_balance_pence: wallet.main_balance_pence + amountPence,
    });

    await base44.entities.Transaction.create({
      user_id: user.id,
      type: "main_deposit",
      amount_pence: amountPence,
      from_pot: "external",
      to_pot: "main",
      occurred_on: new Date().toISOString().slice(0, 10),
      note: "Simulated top-up — no real payment provider wired up yet.",
    });

    return Response.json({ main_balance: penceToPounds(updated.main_balance_pence) });
  } catch (err) {
    console.error("depositToMain failed", err);
    return Response.json({ error: "Failed to deposit funds." }, { status: 500 });
  }
}
