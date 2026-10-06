import type { Database } from "better-sqlite3";

/**
 * Append-only list of migrations. Each entry runs once, inside a transaction,
 * tracked in schema_migrations. Never edit a shipped migration — add a new one.
 * disableForeignKeys is for table rebuilds (SQLite cannot alter constraints).
 */
const MIGRATIONS: ReadonlyArray<{
  version: number;
  name: string;
  sql: string;
  disableForeignKeys?: boolean;
}> = [
  {
    version: 1,
    name: "initial",
    sql: `
      CREATE TABLE routes (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        source_kind TEXT NOT NULL CHECK (source_kind IN ('github', 'gmail')),
        match_json TEXT NOT NULL,
        target_json TEXT NOT NULL,
        prompt_template TEXT,
        sandbox_policy TEXT NOT NULL DEFAULT 'read-only'
          CHECK (sandbox_policy IN ('read-only', 'workspace-write')),
        enabled INTEGER NOT NULL DEFAULT 1,
        created_at TEXT NOT NULL
      );

      CREATE TABLE deliveries (
        id TEXT PRIMARY KEY,
        route_id TEXT NOT NULL REFERENCES routes(id),
        source_delivery_id TEXT NOT NULL,
        received_at TEXT NOT NULL,
        status TEXT NOT NULL CHECK (status IN (
          'received', 'queued', 'delivering', 'delivered',
          'failed', 'skipped-duplicate', 'held', 'coalesced'
        )),
        attempt_count INTEGER NOT NULL DEFAULT 0,
        next_attempt_at TEXT,
        event_json TEXT NOT NULL,
        rendered_prompt TEXT,
        thread_id TEXT,
        turn_id TEXT,
        error TEXT,
        coalesced_into TEXT REFERENCES deliveries(id),
        is_replay INTEGER NOT NULL DEFAULT 0,
        updated_at TEXT NOT NULL
      );

      -- Dedup: one live delivery per (route, source delivery id). Rows that only
      -- record a skipped duplicate or a replay are excluded from the constraint.
      CREATE UNIQUE INDEX deliveries_dedup
        ON deliveries (route_id, source_delivery_id)
        WHERE status NOT IN ('skipped-duplicate') AND is_replay = 0;

      CREATE INDEX deliveries_status ON deliveries (status, next_attempt_at);
      CREATE INDEX deliveries_route ON deliveries (route_id, received_at);

      CREATE TABLE sources (
        id TEXT PRIMARY KEY,
        kind TEXT NOT NULL CHECK (kind IN ('github', 'gmail')),
        config_json TEXT NOT NULL,
        enabled INTEGER NOT NULL DEFAULT 1
      );

      CREATE TABLE settings (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );
    `,
  },
  {
    version: 2,
    name: "route-rate-limit",
    sql: `
      ALTER TABLE routes ADD COLUMN rate_limit_per_minute INTEGER;
    `,
  },
  {
    // Source kinds are an extensible enum (slack joined github/gmail) and are
    // validated by zod at the boundaries; baking them into CHECK constraints
    // was a mistake. Rebuild routes and sources without the kind CHECKs.
    version: 3,
    name: "drop-source-kind-checks",
    disableForeignKeys: true,
    sql: `
      CREATE TABLE routes_new (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        source_kind TEXT NOT NULL,
        match_json TEXT NOT NULL,
        target_json TEXT NOT NULL,
        prompt_template TEXT,
        sandbox_policy TEXT NOT NULL DEFAULT 'read-only'
          CHECK (sandbox_policy IN ('read-only', 'workspace-write')),
        rate_limit_per_minute INTEGER,
        enabled INTEGER NOT NULL DEFAULT 1,
        created_at TEXT NOT NULL
      );
      INSERT INTO routes_new (id, name, source_kind, match_json, target_json, prompt_template, sandbox_policy, rate_limit_per_minute, enabled, created_at)
        SELECT id, name, source_kind, match_json, target_json, prompt_template, sandbox_policy, rate_limit_per_minute, enabled, created_at FROM routes;
      DROP TABLE routes;
      ALTER TABLE routes_new RENAME TO routes;

      CREATE TABLE sources_new (
        id TEXT PRIMARY KEY,
        kind TEXT NOT NULL,
        config_json TEXT NOT NULL,
        enabled INTEGER NOT NULL DEFAULT 1
      );
      INSERT INTO sources_new (id, kind, config_json, enabled)
        SELECT id, kind, config_json, enabled FROM sources;
      DROP TABLE sources;
      ALTER TABLE sources_new RENAME TO sources;
    `,
  },
  {
    // Capture mode for generic webhook sources: the first few raw payloads are
    // stored so the model can inspect a real event and author the field mapping.
    version: 4,
    name: "webhook-captures",
    sql: `
      CREATE TABLE captures (
        id TEXT PRIMARY KEY,
        source_id TEXT NOT NULL,
        received_at TEXT NOT NULL,
        body TEXT NOT NULL
      );
      CREATE INDEX captures_source ON captures (source_id, received_at);
    `,
  },
  {
    version: 5,
    name: "deploy-journal",
    sql: `
      CREATE TABLE deploy_intents (
        id TEXT PRIMARY KEY,
        delivery_id TEXT NOT NULL UNIQUE,
        repository_id TEXT NOT NULL,
        merge_sha TEXT NOT NULL,
        tree_hash TEXT NOT NULL,
        phase TEXT NOT NULL,
        manifest_hash TEXT,
        created_at TEXT NOT NULL
      );
      CREATE TABLE deploy_phases (
        intent_id TEXT NOT NULL,
        phase TEXT NOT NULL,
        at TEXT NOT NULL
      );
      CREATE TABLE deploy_pauses (
        repository_id TEXT PRIMARY KEY,
        repair_id TEXT NOT NULL,
        notice TEXT NOT NULL
      );
      CREATE TABLE deploy_outbox (
        id TEXT PRIMARY KEY,
        intent_id TEXT,
        kind TEXT NOT NULL,
        acknowledged INTEGER NOT NULL DEFAULT 0
      );
      CREATE TABLE deploy_fence (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        token INTEGER NOT NULL,
        held INTEGER NOT NULL,
        fenced INTEGER NOT NULL,
        reason TEXT
      );
      INSERT INTO deploy_fence (id, token, held, fenced, reason) VALUES (1, 0, 0, 0, NULL);
      CREATE TABLE deploy_owners (
        repository_id TEXT PRIMARY KEY,
        owner TEXT NOT NULL,
        phase TEXT NOT NULL,
        generation INTEGER NOT NULL,
        deployment_activation_enabled INTEGER NOT NULL,
        active_jobs INTEGER NOT NULL DEFAULT 0,
        active_deploys INTEGER NOT NULL DEFAULT 0,
        signature TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE deploy_raw_receipts (
        delivery_id TEXT PRIMARY KEY,
        repository_id TEXT NOT NULL,
        kind TEXT NOT NULL,
        event_id TEXT NOT NULL
      );
      CREATE TABLE deploy_merges (
        repository_id TEXT NOT NULL,
        event_id TEXT NOT NULL,
        sequence INTEGER NOT NULL,
        merge_sha TEXT NOT NULL,
        PRIMARY KEY (repository_id, event_id)
      );
      CREATE TABLE deploy_dispositions (
        repository_id TEXT NOT NULL,
        event_id TEXT NOT NULL,
        disposition TEXT NOT NULL,
        PRIMARY KEY (repository_id, event_id)
      );
      CREATE TABLE deploy_cursors (
        repository_id TEXT PRIMARY KEY,
        sequence INTEGER NOT NULL
      );
      CREATE TABLE deploy_genesis (
        repository_id TEXT PRIMARY KEY,
        merge_event_id TEXT NOT NULL,
        target_generation INTEGER NOT NULL
      );
    `,
  },
  {
    version: 6,
    name: "deploy-fencing",
    sql: `
      ALTER TABLE deploy_intents ADD COLUMN previous_manifest TEXT;
      ALTER TABLE deploy_intents ADD COLUMN target_manifest TEXT;
      ALTER TABLE deploy_intents ADD COLUMN repair_id TEXT;
      ALTER TABLE deploy_fence ADD COLUMN repository_id TEXT;
      ALTER TABLE deploy_fence ADD COLUMN intent_id TEXT;
      ALTER TABLE deploy_owners ADD COLUMN pinned_key_id TEXT;
      ALTER TABLE deploy_genesis ADD COLUMN adapter_digest TEXT;
      ALTER TABLE deploy_genesis ADD COLUMN adapter_version TEXT;
      ALTER TABLE deploy_outbox ADD COLUMN delivered INTEGER NOT NULL DEFAULT 0;
      CREATE TABLE deploy_leases (
        id TEXT PRIMARY KEY,
        repository_id TEXT NOT NULL,
        generation INTEGER NOT NULL,
        kind TEXT NOT NULL,
        released INTEGER NOT NULL DEFAULT 0
      );
    `,
  },
  {
    version: 7,
    name: "deploy-trust",
    sql: `
      CREATE TABLE deploy_trust_keys (
        key_id TEXT PRIMARY KEY,
        public_pem TEXT NOT NULL
      );
      CREATE TABLE deploy_adapters (
        digest TEXT PRIMARY KEY,
        version TEXT NOT NULL,
        repository_id TEXT NOT NULL,
        body TEXT NOT NULL
      );
      CREATE TABLE deploy_previous_files (
        intent_id TEXT NOT NULL,
        path TEXT NOT NULL,
        bytes BLOB NOT NULL,
        PRIMARY KEY (intent_id, path)
      );
      CREATE TABLE deploy_wakes (
        request_id TEXT PRIMARY KEY,
        repository_id TEXT NOT NULL,
        lane_id TEXT NOT NULL,
        role TEXT NOT NULL,
        pr INTEGER NOT NULL,
        head_sha TEXT NOT NULL,
        base_sha TEXT NOT NULL,
        tree_hash TEXT NOT NULL
      );
    `,
  },
  {
    version: 8,
    name: "deploy-reconciliation",
    sql: `
      ALTER TABLE deploy_intents ADD COLUMN head_sha TEXT;
      ALTER TABLE deploy_intents ADD COLUMN base_sha TEXT;
      ALTER TABLE deploy_intents ADD COLUMN pr INTEGER;
      ALTER TABLE deploy_outbox ADD COLUMN repository_id TEXT;
      ALTER TABLE deploy_outbox ADD COLUMN merge_sha TEXT;
      ALTER TABLE deploy_outbox ADD COLUMN tree_hash TEXT;
      ALTER TABLE deploy_outbox ADD COLUMN manifest_hash TEXT;
      ALTER TABLE deploy_wakes ADD COLUMN delivered INTEGER NOT NULL DEFAULT 0;
      ALTER TABLE deploy_wakes ADD COLUMN holder TEXT;
      CREATE TABLE deploy_tokens (
        repository_id TEXT PRIMARY KEY,
        token INTEGER NOT NULL
      );
      CREATE TABLE deploy_previous_manifests (
        intent_id TEXT PRIMARY KEY,
        paths_json TEXT NOT NULL
      );
    `,
  },
];

/** targetVersion is for tests that need to exercise upgrade paths from older schemas. */
export function migrate(db: Database, targetVersion = Number.POSITIVE_INFINITY): void {
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  db.exec(
    "CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at TEXT NOT NULL)",
  );
  const applied = new Set(
    (db.prepare("SELECT version FROM schema_migrations").all() as Array<{ version: number }>).map(
      (r) => r.version,
    ),
  );
  for (const migration of MIGRATIONS) {
    if (migration.version > targetVersion) break;
    if (applied.has(migration.version)) continue;
    if (migration.disableForeignKeys) db.pragma("foreign_keys = OFF");
    try {
      const run = db.transaction(() => {
        db.exec(migration.sql);
        db.prepare(
          "INSERT INTO schema_migrations (version, name, applied_at) VALUES (?, ?, ?)",
        ).run(migration.version, migration.name, new Date().toISOString());
      });
      run();
    } finally {
      if (migration.disableForeignKeys) db.pragma("foreign_keys = ON");
    }
    if (migration.disableForeignKeys) {
      const violations = db.pragma("foreign_key_check") as unknown[];
      if (violations.length > 0) {
        throw new Error(`migration ${migration.version} left foreign key violations`);
      }
    }
  }
}
