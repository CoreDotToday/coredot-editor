# Documentation Experience

This guide defines how Coredot Editor presents itself as an open-source project. It keeps the README concise while giving the documentation enough depth to show both the product and its engineering.

## Audience And Outcome

The primary audience is a development team evaluating foundations for an AI document product.

A new visitor should see the product value and boundary on the first screen, follow one minimal local-run path, and find the right extension seam without reading the whole repository.

The public experience is English-first. Copy should be useful to global contributors and product engineers without assuming prior knowledge of Coredot Editor.

## Editorial Position

Coredot Editor is a working full-stack application starter, not an npm editor component and not a hosted SaaS product. The documentation must state that boundary early and consistently.

Lead with outcomes, then name the mechanism that supports them. Prefer “revision checks reject stale writes” over broad claims such as “enterprise-ready collaboration.”

Use proof instead of promotional adjectives. Production claims should point to a concrete boundary, invariant, test, or release gate.

Keep one idea per paragraph and keep paragraphs short. Place important limitations beside the capability they qualify instead of hiding them in a final disclaimer.

## README Responsibility

The README is a short evaluation path. It should contain these sections in this order:

1. A precise value proposition, primary documentation links, CI, Docs, and MIT badges, and one real product image.
2. Three reasons to adopt the starter: a working product, safe AI-assisted changes, and explicit extension seams.
3. A workflow at a glance from writing through Proposal review, durable change history, and recovery.
4. A minimal local start that works with stub AI and deterministic test authentication.
5. A compact extension map for providers, prompts, Project Profiles, plugins, identity, and persistence.
6. Engineering trust signals for revision safety, bounded execution, Workspace scope, fidelity reporting, and release verification.
7. Task-based routes into the documentation: explore, build, extend, and operate.
8. Contribution, security, roadmap, and MIT license links.

The README should not repeat the full feature catalog, environment reference, deployment runbook, or project tree. Those details belong in the documentation.

## Documentation Responsibility

The documentation is both a product showcase and a technical handbook. Every public page has one canonical location:

| Reader path | Pages |
| --- | --- |
| **Home** | [Overview](index.md) |
| **Explore** | [Product Showcase](product-tour.md) |
| **Build** | [Getting Started](getting-started.md), [Development](development.md), [Configuration](configuration.md), [API Reference](api-reference.md) |
| **Extend** | [Adopting The Starter](ADOPTION.md), Project Profiles (`project-profiles.md`), [Extension Points](PLUGINS.md), [Prompting](PROMPTING.md) |
| **Operate** | [System Architecture](ARCHITECTURE.md), [Architecture Hardening](architecture-hardening.md), [Clerk ADR](adr/0001-clerk-for-identity-and-workspace-context.md), [Production Readiness](production-readiness.md), [Deployment](DEPLOYMENT.md), [RAG Docker Stack](RAG_DOCKER.md) |
| **Project** | [Roadmap](ROADMAP.md), [Community](community.md), [Maintainers](MAINTAINERS.md), this documentation guide |

Project Profiles need one focused canonical page. The overview and Product Showcase may summarize current capabilities, but they should link to the canonical guide instead of duplicating its contract.

The home page should introduce the product visually, explain what is already implemented, and route readers to those five paths. It should not begin with source-file boundaries.

The product tour should tell a coherent workflow story. Deep architecture and reference pages should keep exact contracts, constraints, and limitations.

## Visual Evidence

Use real application captures rather than illustrations or stock imagery. The showcase uses three purposeful images:

1. The complete three-pane document Workspace.
2. Proposal review with a visible safe-change or recovery state.
3. DOCX interchange with a preserved, approximated, or removed fidelity report.

The product-flow diagram must show branches rather than an unconditional pipeline:

1. A draft snapshot and AI command create an AI Run.
2. The run produces zero or more Proposals.
3. Pending Proposals may remain pending or be rejected without changing the document.
4. Single or bulk acceptance checks `expectedRevision` before creating one atomic Document Change and new revision.
5. A revision conflict leaves Proposals pending. Server undo is available only while its revision precondition still holds.

The system diagram must show trust and isolation boundaries.

Include Clerk or test identity, Request Context, protected Next.js pages and routes, service seams, Workspace-scoped repositories, SQLite or libSQL, external AI providers, and the terminable DOCX worker.

Use static SVG assets with a `<title>` and `<desc>` instead of Mermaid. The SVG is both the published asset and its editable source, so the current MkDocs configuration needs no client-side diagram runtime.

Every image needs concise alt text and a caption that explains what evidence the reader should notice. Images must remain legible on narrow screens and must not expose private document content or credentials.

`pnpm docs:capture` owns reproducible screenshots. It uses an isolated migrated SQLite database, `AUTH_MODE=test`, `AI_PROVIDER=stub`, fixed non-private fixtures, and a 1440 × 1000 viewport at device scale factor 1.

The capture sets `coredot-editor-language=en` before loading the document route. The DOCX fixture must contain a deterministic mix of preserved, approximated, and removed features rather than only a preserved paragraph.

Publish optimized WebP files under `docs/assets/screenshots/`, keep each image within 350 KiB, and link each responsive preview to its full-size asset. Use a focused crop when the full three-pane view is not readable on a narrow screen.

## Visual Style

Use the existing Material theme with neutral black and white surfaces, restrained indigo accents, generous spacing, and thin diagram lines. Avoid decorative AI gradients, stock illustrations, and dense feature-card walls.

The docs home may use a small custom stylesheet for its hero, proof strip, path grid, figures, and responsive behavior. Content must remain readable if styling is unavailable.

## Maintenance And Verification

Keep `README.md`, `docs/index.md`, `docs/product-tour.md`, the canonical Project Profiles guide, and `mkdocs.yml` aligned with this information hierarchy.

Keep `CONTRIBUTING.md` aligned with the real release gate. Production-building commands must explain the fixed verification-only Clerk environment and distinguish it from real deployment credentials.

Review copy through two lenses: open-source onboarding and technical accuracy. Reject unsupported claims, stale paths, duplicated guidance, private data, and links that require an unpublished branch.

`pnpm docs:verify-quick-start` must exercise the documented install, environment, database, and startup path against a temporary database. It verifies the path, not a wall-clock promise.

`pnpm docs:check-links` must validate internal files and anchors. Its bounded external mode must check the hosted docs, repository, CI, Docs badge, license, contribution, security, and code-of-conduct URLs.

Build the documentation in strict mode and inspect the rendered home, README, screenshots, diagrams, navigation, full-size image links, and narrow-screen behavior.

Keep internal plans, local browser state, and generated visual-companion files out of public source. `.gitignore` must exclude `.superpowers/` in addition to generated docs output and private environment files.

Run the repository release gate after focused checks. Finish with the production artifact smoke, documentation strict build, and `git diff --check`.
