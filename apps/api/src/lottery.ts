export type PlanStatus = 'active' | 'forfeited';

export interface SavingsPlan {
  id: string;
  userId: string;
  targetPence: number;
  requiredContributionPence: number;
  cadence: 'daily';
  savingsBalancePence: number;
  missedPeriods: number;
  status: PlanStatus;
  createdAt: string;
  forfeitedAt?: string;
}

export interface LotteryDraw {
  id: string;
  drawnAt: string;
  prizePence: number;
  winnerPlanId: string;
  winnerUserId: string;
  ticketsInDraw: number;
}

export interface LotteryState {
  prizePoolPence: number;
  plans: SavingsPlan[];
  draws: LotteryDraw[];
}

export class LotteryError extends Error {}

/**
 * In-memory implementation of the savings-lottery rules.
 *
 * All monetary values are integer pence. Replace this store with a database
 * transaction before using it with real accounts or money movement.
 */
export class LotteryService {
  private readonly plans = new Map<string, SavingsPlan>();
  private readonly draws: LotteryDraw[] = [];
  private nextPlanId = 1;
  private nextDrawId = 1;
  private prizePoolPence: number;

  constructor(
    startingPrizePoolPence = 0,
    private readonly random: () => number = Math.random
  ) {
    this.assertNonNegativeInteger(startingPrizePoolPence, 'startingPrizePoolPence');
    this.prizePoolPence = startingPrizePoolPence;
  }

  createPlan(input: {
    userId: string;
    targetPence: number;
    requiredContributionPence: number;
    createdAt: string;
  }): SavingsPlan {
    if (!input.userId.trim()) throw new LotteryError('userId is required');
    this.assertPositiveInteger(input.targetPence, 'targetPence');
    this.assertPositiveInteger(input.requiredContributionPence, 'requiredContributionPence');
    this.assertDate(input.createdAt);

    const plan: SavingsPlan = {
      id: `plan_${this.nextPlanId++}`,
      userId: input.userId,
      targetPence: input.targetPence,
      requiredContributionPence: input.requiredContributionPence,
      cadence: 'daily',
      savingsBalancePence: 0,
      missedPeriods: 0,
      status: 'active',
      createdAt: input.createdAt
    };
    this.plans.set(plan.id, plan);
    return { ...plan };
  }

  /** Records one daily savings period and returns the updated plan. */
  recordDailyContribution(planId: string, amountPence: number, date: string): SavingsPlan {
    this.assertNonNegativeInteger(amountPence, 'amountPence');
    this.assertDate(date);
    const plan = this.getMutablePlan(planId);
    if (plan.status !== 'active') {
      throw new LotteryError('Cannot record a contribution for a forfeited plan');
    }

    plan.savingsBalancePence += amountPence;
    if (amountPence >= plan.requiredContributionPence) {
      plan.missedPeriods = 0;
      return { ...plan };
    }

    plan.missedPeriods += 1;
    if (plan.missedPeriods === 3) {
      this.prizePoolPence += plan.savingsBalancePence;
      plan.savingsBalancePence = 0;
      plan.status = 'forfeited';
      plan.forfeitedAt = date;
    }
    return { ...plan };
  }

  /**
   * Runs one winner-takes-all draw. Active plans receive one ticket per whole
   * pound currently saved. A draw is skipped when the pool or ticket count is 0.
   */
  runMonthlyDraw(drawnAt: string): LotteryDraw | null {
    this.assertDate(drawnAt);
    if (this.prizePoolPence === 0) return null;

    const entries = [...this.plans.values()]
      .filter((plan) => plan.status === 'active')
      .map((plan) => ({ plan, tickets: Math.floor(plan.savingsBalancePence / 100) }))
      .filter((entry) => entry.tickets > 0);
    const ticketsInDraw = entries.reduce((sum, entry) => sum + entry.tickets, 0);
    if (ticketsInDraw === 0) return null;

    const roll = this.random();
    if (roll < 0 || roll >= 1) throw new LotteryError('Random number must be in [0, 1)');
    let selectedTicket = Math.floor(roll * ticketsInDraw);
    let winner = entries[0].plan;
    for (const entry of entries) {
      if (selectedTicket < entry.tickets) {
        winner = entry.plan;
        break;
      }
      selectedTicket -= entry.tickets;
    }

    const draw: LotteryDraw = {
      id: `draw_${this.nextDrawId++}`,
      drawnAt,
      prizePence: this.prizePoolPence,
      winnerPlanId: winner.id,
      winnerUserId: winner.userId,
      ticketsInDraw
    };
    this.prizePoolPence = 0;
    this.draws.push(draw);
    return { ...draw };
  }

  getState(): LotteryState {
    return {
      prizePoolPence: this.prizePoolPence,
      plans: [...this.plans.values()].map((plan) => ({ ...plan })),
      draws: this.draws.map((draw) => ({ ...draw }))
    };
  }

  private getMutablePlan(planId: string): SavingsPlan {
    const plan = this.plans.get(planId);
    if (!plan) throw new LotteryError(`Savings plan ${planId} was not found`);
    return plan;
  }

  private assertPositiveInteger(value: number, name: string): void {
    if (!Number.isSafeInteger(value) || value <= 0) {
      throw new LotteryError(`${name} must be a positive integer in pence`);
    }
  }

  private assertNonNegativeInteger(value: number, name: string): void {
    if (!Number.isSafeInteger(value) || value < 0) {
      throw new LotteryError(`${name} must be a non-negative integer in pence`);
    }
  }

  private assertDate(value: string): void {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(value) || Number.isNaN(Date.parse(`${value}T00:00:00Z`))) {
      throw new LotteryError('date must use YYYY-MM-DD format');
    }
  }
}
