/**
 * 007_case_keyset — the access path for the P3 cases read endpoints
 * (API_CONTRACTS §2: `GET /v1/cases`, `GET /v1/cases/{id}`).
 *
 * Both endpoints paginate with a keyset predicate, never OFFSET:
 *   list     : WHERE (updated_at, id) < ($cursor, $id)
 *              ORDER BY updated_at DESC, id DESC
 *   timeline : WHERE (occurred_at, id) < (...) ORDER BY occurred_at DESC, id DESC
 *
 * `cases` had no index leading with (tenant_id, updated_at), so every page
 * would sort the tenant's whole case list. The composite index makes the
 * first page an index range scan and each next page a seek; ascending btree
 * order is fine because Postgres scans it backwards for DESC (no DESC columns
 * needed, and no functional index — `date_trunc` would be STABLE, not
 * immutable, and unusable as an index key).
 *
 * `case_events` is deliberately NOT re-indexed: it already has
 * case_events_tenant_case_occurred_idx (tenant_id, case_id, occurred_at),
 * which drives the same seek; adding `id` would duplicate that index for a
 * tie-break Postgres resolves within one page of rows.
 *
 * Written as CREATE INDEX IF NOT EXISTS in one small migration: the tables are
 * still pre-launch (no backfill concern), and CI replays every migration from
 * scratch on each run, so a plain build is atomic there.
 */

exports.up = (pgm) => {
  pgm.sql(
    `CREATE INDEX IF NOT EXISTS cases_tenant_updated_id_idx
       ON cases (tenant_id, updated_at, id);`,
  );
};

exports.down = (pgm) => {
  pgm.sql(`DROP INDEX IF EXISTS cases_tenant_updated_id_idx;`);
};
