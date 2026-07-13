# Production Readiness

Coredot Editor provides an implemented production-oriented baseline, not a complete hosted SaaS operating model. The application fails closed on missing production identity configuration, but each deployment still owns database, backup, provider, retention, observability, and document-fidelity decisions.

## Implemented Baseline

- Clerk App Router authentication with organization and personal Workspaces.
- Owner/admin/member authorization and repository-level Workspace predicates; cross-Workspace IDs return not found.
- Production build/startup rejection for `AUTH_MODE=test` or blank Clerk keys.
- Revision-aware document saves with explicit local/server conflict recovery.
- Atomic submitted-draft single/bulk Proposal application, durable Document Changes, and revision-checked server undo.
- Durable request budgets, streamed request limits, document depth/node/byte limits, and terminable DOCX conversion.
- Bounded AI execution with shared deadlines, abort propagation, idempotency fingerprints, attempt fencing, safe stale-run recovery, and body/secret-free telemetry.
- Public no-store health and bounded database/schema readiness routes.
- Build-time plugin hosts for all seven contribution types and one shared browser/server document schema Profile.
- Two-phase DOCX import/export with preserved/approximated/removed fidelity reports and loss acknowledgement.
- Database Conversations with bounded summaries, lazy detail, scoped opaque v2 cursors, version/idempotency controls, archive state, and non-destructive retention visibility.
- Server-owned Project Profiles selected once per deployment.

## Operator Decisions Before Real Users

- Provision real Clerk publishable/secret keys and configure organization behavior. Verification-only test-format values are never deployment credentials.
- Choose durable SQLite/libSQL hosting or migrate behind the repository seams; run migrations before traffic and verify `/api/ready`.
- Define backups, restore drills, migration windows, and database contention/capacity alerts.
- Store database/provider secrets in the deployment secret manager and configure a model-backed provider when users expect real AI.
- Schedule and monitor `pnpm ai:recover-stale-runs`; alert on failures and sustained recovery counts.
- Define logging/tracing without document bodies, prompts, credentials, or idempotency keys.
- Validate DOCX fidelity against the deployment's own corpus. The current report is explicit about loss but does not provide full Word parity.
- Define deletion only after audit, backup, legal-hold, pending-operation, and foreign-key behavior is settled. Retention expiry hides data but does not automatically delete it.
- Test the selected `PROJECT_PROFILE_ID` against a production database copy. An unknown ID fails closed on first Profile resolution, and there is no per-Workspace selector.
- Add platform monitoring for health, readiness, route failures, provider latency/timeouts, rate limits, and migration compatibility.

## Conversation Visibility Contract

Archive removes a Conversation from default lists; `includeArchived=true` includes it, and its direct detail route remains readable. Conversation retention expiry hides both list and detail. An expired individual message is omitted from an otherwise visible transcript. These are visibility rules only—no automatic destructive pruning runs.

Version-conflict responses do not include the current Conversation version. Clients must reload the detail route before retrying a mutation.

## Release Gate

`pnpm build`, `pnpm check`, and `pnpm release:check` create a production build and intentionally fail without production-style Clerk configuration. For local or CI verification only, export the fixed non-secret test-format values:

```bash
export AUTH_MODE=clerk
export CLERK_SECRET_KEY=sk_test_ci_build
export NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY=pk_test_Y2xlcmsuZXhhbXBsZS5jb20k
```

These values satisfy configuration validation only and do not authenticate users. Real deployments must use real Clerk keys from their secret manager.

Run the complete release sequence:

```bash
pnpm release:check
pnpm e2e:production
.venv-docs/bin/python -m mkdocs build --strict
git diff --check
```

`release:check` runs lint, typecheck, Vitest, development Playwright E2E, production-auth startup verification, the production build, and the dependency audit at the configured moderate-or-higher threshold. `e2e:production` builds and starts the artifact against an isolated migrated database and checks health, readiness, redirects, and protected-route behavior with bounded cleanup. The final two commands verify public documentation and patch hygiene.

Review generated artifacts without committing `.env` files, local databases, Playwright traces, or generated `site/` output.
