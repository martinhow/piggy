import cors from 'cors';
import express from 'express';
import { LotteryError, LotteryService } from './lottery.js';

export function createApp(lottery = new LotteryService(Number(process.env.PRIZE_POOL_STARTING_PENCE ?? 0))) {
  const app = express();

  app.use(cors({ origin: process.env.WEB_ORIGIN ?? 'http://localhost:5173' }));
  app.use(express.json());

  app.get('/api/health', (_request, response) => {
    response.json({ status: 'ok' });
  });

  app.get('/api/lottery', (_request, response) => {
    response.json(lottery.getState());
  });

  app.post('/api/lottery/plans', (request, response, next) => {
    try {
      response.status(201).json(lottery.createPlan(request.body));
    } catch (error) {
      next(error);
    }
  });

  app.post('/api/lottery/plans/:planId/daily-contributions', (request, response, next) => {
    try {
      const { amountPence, date } = request.body;
      response.json(lottery.recordDailyContribution(request.params.planId, amountPence, date));
    } catch (error) {
      next(error);
    }
  });

  app.post('/api/lottery/draws/monthly', (request, response, next) => {
    try {
      const draw = lottery.runMonthlyDraw(request.body.drawnAt);
      response.status(draw ? 201 : 204).json(draw);
    } catch (error) {
      next(error);
    }
  });

  app.use((error: Error, _request: express.Request, response: express.Response, _next: express.NextFunction) => {
    void _request;
    void _next;
    const status = error instanceof LotteryError ? 400 : 500;
    response.status(status).json({ error: error.message });
  });

  return app;
}

export default createApp();
