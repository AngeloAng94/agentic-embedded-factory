import { getFunctionName } from "convex/server";

/**
 * Minimal in-memory Convex harness.
 *
 * It executes the REAL exported handlers (through their `_handler`) against a
 * fake database and a fake identity, so authorization, patch application and
 * the agent loop can be tested without a deployment.
 */

export interface FakeDoc {
  _id: string;
  _creationTime: number;
  [key: string]: unknown;
}

type Condition = [string, unknown];

class FakeQuery {
  private conditions: Condition[] = [];
  private direction: "asc" | "desc" = "asc";

  private readonly db: FakeDb;
  private readonly table: string;

  constructor(db: FakeDb, table: string) {
    this.db = db;
    this.table = table;
  }

  withIndex(_name: string, build: (builder: FakeIndexBuilder) => unknown): this {
    const builder = new FakeIndexBuilder();
    build(builder);
    this.conditions = builder.conditions;
    return this;
  }

  order(direction: "asc" | "desc"): this {
    this.direction = direction;
    return this;
  }

  async collect(): Promise<FakeDoc[]> {
    return this.run();
  }

  async take(count: number): Promise<FakeDoc[]> {
    return this.run().slice(0, count);
  }

  async first(): Promise<FakeDoc | null> {
    return this.run()[0] ?? null;
  }

  private run(): FakeDoc[] {
    const rows = this.db.raw(this.table).filter((doc) =>
      this.conditions.every(([field, value]) => doc[field] === value),
    );
    const sorted = [...rows].sort((a, b) =>
      this.direction === "asc"
        ? a._creationTime - b._creationTime
        : b._creationTime - a._creationTime,
    );
    return sorted.map((doc) => ({ ...doc }));
  }
}

class FakeIndexBuilder {
  conditions: Condition[] = [];

  eq(field: string, value: unknown): this {
    this.conditions.push([field, value]);
    return this;
  }
}

export class FakeDb {
  private tables = new Map<string, FakeDoc[]>();
  private counter = 0;

  raw(table: string): FakeDoc[] {
    if (!this.tables.has(table)) this.tables.set(table, []);
    return this.tables.get(table)!;
  }

  seed(table: string, docs: Record<string, unknown>[]): FakeDoc[] {
    const inserted = docs.map((doc) => ({
      _id: `${table}:${++this.counter}`,
      _creationTime: Date.now() + this.counter,
      ...doc,
    })) as FakeDoc[];
    this.raw(table).push(...inserted);
    return inserted;
  }

  async get(id: string): Promise<FakeDoc | null> {
    for (const rows of this.tables.values()) {
      const found = rows.find((doc) => doc._id === id);
      if (found) return { ...found };
    }
    return null;
  }

  async insert(table: string, doc: Record<string, unknown>): Promise<string> {
    const id = `${table}:${++this.counter}`;
    this.raw(table).push({ _id: id, _creationTime: Date.now() + this.counter, ...doc });
    return id;
  }

  async patch(id: string, fields: Record<string, unknown>): Promise<void> {
    for (const rows of this.tables.values()) {
      const index = rows.findIndex((doc) => doc._id === id);
      if (index >= 0) {
        rows[index] = { ...rows[index]!, ...fields };
        return;
      }
    }
    throw new Error(`patch: document ${id} not found`);
  }

  async delete(id: string): Promise<void> {
    for (const rows of this.tables.values()) {
      const index = rows.findIndex((doc) => doc._id === id);
      if (index >= 0) {
        rows.splice(index, 1);
        return;
      }
    }
  }

  query(table: string): FakeQuery {
    return new FakeQuery(this, table);
  }

  all(table: string): FakeDoc[] {
    return this.raw(table).map((doc) => ({ ...doc }));
  }
}

export type Handler = (ctx: any, args: any) => Promise<any>;

export function handlerOf(fn: unknown): Handler {
  const handler = (fn as { _handler?: Handler })._handler;
  if (!handler) throw new Error("the exported function has no _handler: not a Convex function?");
  return handler;
}

export function exportedArgs(fn: unknown): Record<string, unknown> {
  const exportArgs = (fn as { exportArgs?: () => string }).exportArgs;
  if (!exportArgs) throw new Error("the exported function has no exportArgs()");
  return JSON.parse(exportArgs()) as Record<string, unknown>;
}

export interface FakeCtx {
  db: FakeDb;
  auth: { getUserIdentity: () => Promise<{ subject: string } | null> };
  runQuery: (ref: unknown, args: unknown) => Promise<unknown>;
  runMutation: (ref: unknown, args: unknown) => Promise<unknown>;
  storage: undefined;
  meta: undefined;
}

export function makeCtx(
  db: FakeDb,
  userId: string | null,
  registry: Record<string, unknown> = {},
): FakeCtx {
  const ctx: FakeCtx = {
    db,
    auth: {
      getUserIdentity: async () =>
        userId === null ? null : { subject: `${userId}|test-session` },
    },
    runQuery: async (ref, args) => {
      const name = getFunctionName(ref as never);
      const target = registry[name];
      if (!target) throw new Error(`no handler registered for ${name}`);
      return await handlerOf(target)(ctx as never, args);
    },
    runMutation: async (ref, args) => {
      const name = getFunctionName(ref as never);
      const target = registry[name];
      if (!target) throw new Error(`no handler registered for ${name}`);
      return await handlerOf(target)(ctx as never, args);
    },
    storage: undefined,
    meta: undefined,
  };
  return ctx;
}

export function ownerDoc(id: string, ownerId: string, extra: Record<string, unknown> = {}) {
  return {
    _id: id,
    userId: ownerId,
    name: `project-${id}`,
    rtos: "zephyr" as const,
    status: "unverified" as const,
    ...extra,
  };
}

export function fileDoc(projectId: string, path: string, content: string) {
  return {
    projectId,
    path,
    content,
    type: "c" as const,
    version: 1,
    status: "current" as const,
  };
}
