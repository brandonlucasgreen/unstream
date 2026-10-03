// A small in-memory stand-in for the Supabase client, for the tips tests. Covers the query shapes
// those endpoints use: select/eq/in/not/order/limit/maybeSingle/single, insert (with unique
// columns raising 23505), update and delete with filters, count heads, and rpc via handlers.
// Embedded selects (`artists(...)`) are not modelled; tests that need them stub rpc or the row.

type Row = Record<string, unknown>;

export interface FakeDb {
  tables: Record<string, Row[]>;
  /** Columns that must be unique per table, e.g. { tip_payments: ['stripe_payment_intent_id'] }. */
  unique: Record<string, string[][]>;
  /** Column defaults applied on insert, as Postgres would, e.g. { artist_goals: { status: 'open' } }. */
  defaults: Record<string, Row>;
  rpc: Record<string, (args: Record<string, unknown>) => unknown>;
  client: unknown;
}

/** `artists.slug` reads an embedded object the test put on the row itself. */
function get(row: Row, path: string): unknown {
  return path.split('.').reduce<unknown>((v, k) => (v && typeof v === 'object' ? (v as Row)[k] : undefined), row);
}

export function createFakeDb(): FakeDb {
  const db: FakeDb = { tables: {}, unique: {}, defaults: {}, rpc: {}, client: null };

  const from = (table: string) => {
    const rows = () => (db.tables[table] ??= []);
    const filters: Array<(r: Row) => boolean> = [];
    let op: { kind: 'select' | 'insert' | 'update' | 'delete'; payload?: Row | Row[] } = { kind: 'select' };
    let wantSingle: 'single' | 'maybe' | null = null;
    let head = false;
    let limit: number | null = null;
    let returning = false;

    const run = () => {
      const matching = rows().filter(r => filters.every(f => f(r)));
      if (op.kind === 'insert') {
        const list = Array.isArray(op.payload) ? op.payload : [op.payload!];
        const inserted: Row[] = [];
        for (const raw of list) {
          const row: Row = { id: `id-${Math.random().toString(36).slice(2, 10)}`, ...db.defaults[table], ...raw };
          for (const cols of db.unique[table] ?? []) {
            if (rows().some(r => cols.every(c => r[c] === row[c]))) {
              return { data: null, error: { code: '23505', message: `duplicate key on ${cols.join(',')}` }, count: null };
            }
          }
          rows().push(row);
          inserted.push(row);
        }
        const data = returning ? (wantSingle ? inserted[0] : inserted) : null;
        return { data, error: null, count: null };
      }
      if (op.kind === 'update') {
        for (const r of matching) Object.assign(r, op.payload);
        return { data: returning ? matching : null, error: null, count: matching.length };
      }
      if (op.kind === 'delete') {
        db.tables[table] = rows().filter(r => !matching.includes(r));
        return { data: null, error: null, count: matching.length };
      }
      const limited = limit === null ? matching : matching.slice(0, limit);
      if (head) return { data: null, error: null, count: matching.length };
      if (wantSingle === 'maybe') return { data: limited[0] ?? null, error: null, count: null };
      if (wantSingle === 'single') {
        return limited[0]
          ? { data: limited[0], error: null, count: null }
          : { data: null, error: { code: 'PGRST116', message: 'no rows' }, count: null };
      }
      return { data: limited, error: null, count: limited.length };
    };

    const builder: Record<string, unknown> = {
      select(_cols?: string, opts?: { head?: boolean }) {
        if (op.kind === 'select') op = { kind: 'select' };
        else returning = true;
        if (opts?.head) head = true;
        return builder;
      },
      insert(payload: Row | Row[]) { op = { kind: 'insert', payload }; return builder; },
      update(payload: Row) { op = { kind: 'update', payload }; return builder; },
      delete() { op = { kind: 'delete' }; return builder; },
      upsert(payload: Row) { op = { kind: 'insert', payload }; return builder; },
      eq(c: string, v: unknown) { filters.push(r => get(r, c) === v); return builder; },
      in(c: string, vs: unknown[]) { filters.push(r => vs.includes(get(r, c))); return builder; },
      not(c: string, _op: string, v: unknown) { filters.push(r => (v === null ? get(r, c) != null : get(r, c) !== v)); return builder; },
      order() { return builder; },
      limit(n: number) { limit = n; return builder; },
      maybeSingle() { wantSingle = 'maybe'; return Promise.resolve(run()); },
      single() { wantSingle = 'single'; return Promise.resolve(run()); },
      then(res: (v: unknown) => unknown, rej?: (e: unknown) => unknown) { return Promise.resolve(run()).then(res, rej); },
    };
    return builder;
  };

  db.client = {
    from,
    rpc: (name: string, args: Record<string, unknown>) => {
      const handler = db.rpc[name];
      if (!handler) return Promise.resolve({ data: null, error: { message: `no rpc ${name}` } });
      return Promise.resolve({ data: handler(args), error: null });
    },
  };
  return db;
}
