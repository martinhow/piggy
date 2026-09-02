import assert from 'node:assert/strict';
import test from 'node:test';
import { LotteryService } from './lottery.js';

test('forfeits the savings balance after three consecutive missed days', () => {
  const lottery = new LotteryService(1_000);
  const plan = lottery.createPlan({
    userId: 'player-c',
    targetPence: 100_000,
    requiredContributionPence: 500,
    createdAt: '2026-09-01'
  });

  lottery.recordDailyContribution(plan.id, 500, '2026-09-01');
  lottery.recordDailyContribution(plan.id, 0, '2026-09-02');
  lottery.recordDailyContribution(plan.id, 200, '2026-09-03');
  const forfeited = lottery.recordDailyContribution(plan.id, 0, '2026-09-04');

  assert.equal(forfeited.status, 'forfeited');
  assert.equal(forfeited.savingsBalancePence, 0);
  assert.equal(lottery.getState().prizePoolPence, 1_700);
});

test('selects the winner proportionally to whole-pound tickets', () => {
  const lottery = new LotteryService(500, () => 0.95);
  const playerA = lottery.createPlan({ userId: 'a', targetPence: 10_000, requiredContributionPence: 100, createdAt: '2026-09-01' });
  const playerB = lottery.createPlan({ userId: 'b', targetPence: 10_000, requiredContributionPence: 100, createdAt: '2026-09-01' });
  lottery.recordDailyContribution(playerA.id, 300, '2026-09-01');
  lottery.recordDailyContribution(playerB.id, 3_000, '2026-09-01');

  const draw = lottery.runMonthlyDraw('2026-09-30');
  assert.deepEqual(draw, {
    id: 'draw_1',
    drawnAt: '2026-09-30',
    prizePence: 500,
    winnerPlanId: playerB.id,
    winnerUserId: 'b',
    ticketsInDraw: 33
  });
  assert.equal(lottery.getState().prizePoolPence, 0);
});

test('skips a draw when the prize pool is empty', () => {
  const lottery = new LotteryService();
  assert.equal(lottery.runMonthlyDraw('2026-09-30'), null);
});
