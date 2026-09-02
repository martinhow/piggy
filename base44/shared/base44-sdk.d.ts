// Local-only ambient type stub for "npm:@base44/sdk" and this project's
// own entities, used purely so the entry.ts files in this repo can be
// type-checked (typos, wrong property, wrong argument) without a live
// Base44 project to generate real types from. It is NOT deployed code.
//
// Once this is pushed into a real Base44 project, run `base44 types`
// there and prefer those generated types over this file — this stub
// exists only to make local development/checking safer in the
// meantime, and its entity shapes are kept in sync with the schemas in
// base44/entities/*.jsonc by hand.

declare module "npm:@base44/sdk" {
  export interface Base44User {
    id: string;
    full_name?: string;
    email?: string;
    [key: string]: unknown;
  }

  interface BaseRecord {
    id: string;
    created_date?: string;
    updated_date?: string;
  }

  export interface WalletRecord extends BaseRecord {
    user_id: string;
    main_balance_pence: number;
  }

  export interface SavingsGoalRecord extends BaseRecord {
    user_id: string;
    target_amount_pence: number;
    duration_days: number;
    start_date: string;
    timezone: string;
    status: "active" | "completed" | "failed";
    piggy_bank_balance_pence: number;
    savings_pot_balance_pence: number;
    current_streak_misses: number;
    days_evaluated_count: number;
    last_evaluated_date?: string | null;
  }

  export interface TransactionRecord extends BaseRecord {
    user_id: string;
    goal_id?: string;
    type:
      | "main_deposit"
      | "piggy_bank_funding"
      | "daily_contribution"
      | "daily_miss"
      | "forfeiture"
      | "goal_completed";
    amount_pence: number;
    from_pot?: "external" | "main" | "piggy_bank" | "savings_pot" | "none";
    to_pot?: "main" | "piggy_bank" | "savings_pot" | "lottery_pot" | "none";
    occurred_on: string;
    note?: string;
  }

  export interface LotteryPotRecord extends BaseRecord {
    period_label?: string;
    total_balance_pence: number;
    status: "open" | "drawn";
  }

  export interface EntityHandle<T extends BaseRecord> {
    get(id: string): Promise<T>;
    list(sort?: string, limit?: number, skip?: number, fields?: (keyof T)[]): Promise<T[]>;
    filter(
      query: Partial<Record<keyof T, unknown>>,
      sort?: string,
      limit?: number,
      skip?: number,
      fields?: (keyof T)[],
    ): Promise<T[]>;
    create(data: Partial<T>): Promise<T>;
    bulkCreate(data: Partial<T>[]): Promise<T[]>;
    update(id: string, data: Partial<T>): Promise<T>;
    updateMany(query: Partial<Record<keyof T, unknown>>, data: Record<string, unknown>): Promise<unknown>;
    bulkUpdate(data: (Partial<T> & { id: string })[]): Promise<T[]>;
    delete(id: string): Promise<{ success: boolean }>;
    deleteMany(query: Partial<Record<keyof T, unknown>>): Promise<{ success: boolean; deleted: number }>;
    subscribe(callback: (event: unknown) => void): () => void;
  }

  export interface Base44Entities {
    Wallet: EntityHandle<WalletRecord>;
    SavingsGoal: EntityHandle<SavingsGoalRecord>;
    Transaction: EntityHandle<TransactionRecord>;
    LotteryPot: EntityHandle<LotteryPotRecord>;
  }

  export interface Base44Client {
    auth: {
      me(): Promise<Base44User | null>;
    };
    entities: Base44Entities;
    asServiceRole: Base44Client;
  }

  export function createClientFromRequest(req: Request): Base44Client;
}
