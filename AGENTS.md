# Coding guide
Explore with `code_glob` / grep / read. Edit with `code_edit` (small diffs).

Hosted Postgres: `DATABASE_URL` is runtime DML only (no CREATE TABLE). Use `MIGRATION_DATABASE_URL` for schema, e.g. run `node migrate.js` (or equivalent) before the web process listens. DDL on boot with `DATABASE_URL` crash-loops the Fly machine.
