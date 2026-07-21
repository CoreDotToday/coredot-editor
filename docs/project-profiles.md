# Project Profiles

A Project Profile turns the starter's general document workflow into one deployment's domain workflow. It is server-owned product configuration, not a browser preference or a per-Workspace setting.

Three Profiles ship with the repository: `default`, `legal-review`, and `research-writing`. The fourth profile below is a downstream pattern for teams that need their own metadata and review lifecycle.

## What a Profile controls

The active Profile provides:

- Typed metadata fields: boolean, date, number, select, tags, and text.
- English and Korean labels for fields, Profile names, and readiness states.
- Filterable fields for the document list.
- Allowed transitions among the four stored readiness IDs: `draft`, `needs_review`, `ready`, and `approved`.
- Stable references to built-in prompt templates.

The same definition drives create/update validation, Proposal application, metadata controls, list filters, readiness choices, and default-template selection. See the [Profile contract and validation source](https://github.com/CoreDotToday/coredoteditor/blob/main/src/features/projects/project-profile.ts).

`PROJECT_PROFILE_ID` is resolved on the server for the whole deployment. An unknown ID throws when the active Profile is first resolved; it does not silently fall back. See [active Profile resolution](https://github.com/CoreDotToday/coredoteditor/blob/main/src/features/projects/active-project-profile.ts).

A Profile does not replace authentication, Workspace authorization, provider credentials, editor plugins, or the shared document schema. Use the corresponding extension seam for each concern.

## Choose a starting point

| Starting point | Status | Use it when | Main domain additions |
| --- | --- | --- | --- |
| General document workflow (`default`) | Built in | Documents can move through a flexible general review process. | Owner, due date, category, tags, and Strategy Review template reference. |
| Legal review (`legal-review`) | Built in | Agreements need a progressive legal review path. | Counterparty, agreement type, legal-specific Korean readiness labels, and Contract Review template reference. |
| Research writing (`research-writing`) | Built in | Drafts need an evidence-oriented publication path. | Research question, evidence status, research-specific Korean readiness labels, and Market Research template reference. |
| Custom domain workflow | Downstream pattern | Your fields or lifecycle cannot be expressed by a built-in Profile. | A new stable Profile ID, code-owned definition, tests, and rollout plan. |

The [built-in Profile registry](https://github.com/CoreDotToday/coredoteditor/blob/main/src/features/projects/default-project-profiles.ts) is the source of truth for the first three rows.

## Adoption profiles

### General document workflow (`default`)

This built-in Profile is the smallest starting point. Its readiness states can move to any other readiness state, so it fits teams that do not need a strict approval sequence.

#### Keep

- The common `owner`, `dueDate`, `category`, and `tags` fields.
- Flexible readiness transitions while the real workflow is still being discovered.
- Revision-aware saves, Proposal application, Document Changes, and server undo.
- Stub AI until the product workflow works without external model credentials.

#### Replace

- General labels and categories with the vocabulary your users already use.
- The Strategy Review prompt content and variables with domain-specific instructions.
- Provider configuration only after local workflows and evaluations are repeatable.

#### First 3 tasks

1. Set `PROJECT_PROFILE_ID=default` and run the local flow with `AUTH_MODE=test` and `AI_PROVIDER=stub`.
2. Replace the seeded Strategy Review template, then cover its variables and Proposal output contract.
3. Exercise create, metadata edit, filtering, readiness changes, Proposal apply, history, and undo with representative documents.

#### Security

Keep the [identity and Workspace boundary](ARCHITECTURE.md#identity-and-workspace-boundary) even for a small internal tool. Test identity is local-only and production startup rejects it.

Review the repository [security policy](https://github.com/CoreDotToday/coredoteditor/blob/main/SECURITY.md) and the [operator decisions](production-readiness.md#operator-decisions-before-real-users) before storing real documents.

### Legal review (`legal-review`)

This built-in Profile adds `counterparty` and `agreementType`. It uses progressive readiness transitions and points to the built-in Contract Review template.

Its stored IDs and English labels remain Draft, Needs review, Ready, and Approved. The built-in Korean labels specialize the middle states as legal review and signature readiness.

#### Keep

- Progressive movement through `draft`, `needs_review`, `ready`, and `approved`.
- Legal-specific Korean readiness labels for review and signature readiness.
- Proposal review and one atomic document change for accepted single or batch edits.
- Explicit DOCX fidelity reports before import confirmation or lossy export.
- Workspace-scoped lookups for documents, Proposals, AI Runs, and change history.

#### Replace

- Agreement taxonomy, readiness labels, and playbook variables with your legal team's standards.
- Contract prompt language, risk categories, and fallback clauses with reviewed internal guidance.
- DOCX assumptions only after testing the formats, clauses, and tables in your own corpus.

#### First 3 tasks

1. Set `PROJECT_PROFILE_ID=legal-review` and map each allowed readiness transition to a real owner and decision.
2. Adapt the Contract Review template while preserving exact `targetText` and drop-in `replacementText` outputs.
3. Build a representative contract and DOCX corpus that covers Proposal conflicts, undo, approximated features, and removed features.

#### Security

A Profile is not a legal access-control policy. Preserve [Clerk roles and repository Workspace predicates](ARCHITECTURE.md#identity-and-workspace-boundary), then test cross-Workspace identifiers as not found.

Treat fidelity as an explicit report, not Word parity. Read [DOCX resource safety](ARCHITECTURE.md#docx-interchange-and-resource-safety), [production readiness](production-readiness.md), and the [security policy](https://github.com/CoreDotToday/coredoteditor/blob/main/SECURITY.md).

### Research writing (`research-writing`)

This built-in Profile adds `researchQuestion` and an `evidenceStatus` select with `missing`, `partial`, and `verified`. Its readiness transitions are progressive.

Its stored IDs and English labels remain Draft, Needs review, Ready, and Approved. The built-in Korean labels specialize the middle states as evidence review and publication readiness.

#### Keep

- The explicit research question and bounded evidence-status vocabulary.
- Progressive readiness transitions through the four stored IDs.
- Research-specific Korean readiness labels for evidence review and publication readiness.
- The Market Research template reference as a starting contract.
- Durable AI Runs and Proposals so generated suggestions stay reviewable.

#### Replace

- Evidence states only when the replacement remains a bounded, tested vocabulary.
- Research prompt variables, source expectations, and evaluation cases with your methodology.
- Provider and retrieval choices with systems whose data handling fits the deployment.

#### First 3 tasks

1. Set `PROJECT_PROFILE_ID=research-writing` and define who may mark evidence partial, verified, ready, and approved.
2. Adapt the Market Research prompt, then test missing evidence, conflicting evidence, unsupported claims, and prompt injection.
3. Cover metadata filtering, readiness transitions, Proposal review, provider timeout, and recovery with representative research drafts.

#### Security

Do not treat `evidenceStatus=verified` as automated source verification; it is Profile metadata whose meaning the deployment defines and enforces through its workflow.

Use the [prompt evaluation cases](PROMPTING.md#evaluation-cases), [provider operating decisions](production-readiness.md#operator-decisions-before-real-users), and [security policy](https://github.com/CoreDotToday/coredoteditor/blob/main/SECURITY.md) when handling external content.

### Custom domain workflow

This is a downstream pattern, not a fourth built-in Profile. Start from `default`, choose a stable ID, and register the definition in source control.

#### Keep

- `defineProjectProfile()` validation and the existing registry.
- Server-only selection through `PROJECT_PROFILE_ID`.
- The four stored readiness IDs, with domain labels and explicit allowed transitions.
- Workspace-scoped repositories and the document-change service.

#### Replace

- Metadata fields, localized labels, transition rules, and default-template references.
- The copied Profile ID with a stable domain ID that will not be repurposed later.
- Built-in prompt content or keys only through the template registry and seed path.

#### First 3 tasks

1. Add a new `defineProjectProfile()` entry beside the built-ins and cover duplicate IDs, fields, options, transitions, and template references.
2. Validate representative existing rows with the new Profile, then set its ID in a non-production deployment.
3. Test every consuming surface before rollout: create/update, Proposal apply, metadata controls, list filters, readiness, and default templates.

#### Security

Never accept a Profile ID from the browser. A Profile describes product workflow; it does not grant roles, remove repository scope, or make test authentication safe for production.

Review [Project Profile architecture](ARCHITECTURE.md#project-profile), [authentication configuration](configuration.md#authentication-and-workspaces), and the [security policy](https://github.com/CoreDotToday/coredoteditor/blob/main/SECURITY.md).

## Create a custom Profile

Add the new entry in `src/features/projects/default-project-profiles.ts`. This example keeps a known built-in template reference and uses the four readiness IDs already stored by the database:

```ts
defineProjectProfile({
  defaultTemplateIds: [BUILTIN_TEMPLATE_KEYS.strategyReview],
  id: "policy-review",
  labels: {
    en: { name: "Policy review" },
    ko: { name: "정책 검토" },
  },
  metadataFields: [
    ...commonMetadataFields,
    {
      filterable: true,
      id: "policyOwner",
      labels: { en: "Policy owner", ko: "정책 담당자" },
      required: true,
      type: "text",
    },
  ],
  readiness: [
    {
      id: "draft",
      labels: { en: "Draft", ko: "초안" },
      transitions: ["needs_review"],
    },
    {
      id: "needs_review",
      labels: { en: "Policy review", ko: "정책 검토" },
      transitions: ["draft", "ready"],
    },
    {
      id: "ready",
      labels: { en: "Ready to publish", ko: "게시 준비" },
      transitions: ["needs_review", "approved"],
    },
    {
      id: "approved",
      labels: { en: "Published", ko: "게시됨" },
      transitions: ["ready"],
    },
  ],
})
```

Add the entry to `defaultProjectProfiles`, then set `PROJECT_PROFILE_ID=policy-review`. If it references a new built-in template, add a stable key to the [template key registry](https://github.com/CoreDotToday/coredoteditor/blob/main/src/features/templates/builtin-template-keys.ts) and seed it in the [database seed](https://github.com/CoreDotToday/coredoteditor/blob/main/src/db/seed.ts).

Required fields are enforced when a document moves beyond draft. Existing unknown metadata survives only while its value is unchanged; a new or modified unknown key is rejected. Validate a data copy before tightening the definition.

## Rollout checklist

- [ ] Choose a stable Profile ID and keep the same `PROJECT_PROFILE_ID` on every app instance in the deployment.
- [ ] Confirm every default template ID exists in the built-in template registry.
- [ ] Validate representative existing metadata and readiness states against the new definition.
- [ ] Decide whether legacy unknown metadata should be migrated before users edit it.
- [ ] Cover allowed and rejected readiness transitions.
- [ ] Cover create, update, single apply, bulk apply, conflict, and undo with the active Profile.
- [ ] Cover metadata controls, list filters, localized labels, and default-template selection.
- [ ] Test against a non-production copy of deployment data and keep a rollback plan.
- [ ] Run focused Profile, repository, route, and component tests, then the full release gate.

Focused checks for a Profile change include:

```bash
pnpm vitest run src/features/projects/project-profile.test.ts
pnpm vitest run src/features/documents/document-repository.test.ts
pnpm vitest run src/features/documents/document-change-service.test.ts
pnpm vitest run src/app/protected-pages.test.tsx
pnpm typecheck
```

Finish with the [release gate](production-readiness.md#release-gate). Profile tests prove the code contract; they do not replace migration rehearsal, authorization checks, backups, or domain review.

## Related guides

- [Adopting the starter](ADOPTION.md) — the broader fork and customization sequence.
- [Configuration](configuration.md#project-profiles) — environment selection and deployment scope.
- [System architecture](ARCHITECTURE.md#project-profile) — where Profiles sit in the application boundary.
- [Prompting](PROMPTING.md) — template output contracts and evaluation cases.
- [Extension points](PLUGINS.md) — editor behavior and shared schema changes that do not belong in a Profile.
- [Production readiness](production-readiness.md) — deployment-owned security and operating decisions.
