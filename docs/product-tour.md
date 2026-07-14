# Product Showcase

Coredot Editor is a working application starter for AI-assisted document products. This tour follows one draft from writing to review, revision-safe change, recovery, and DOCX interchange.

The captures use deterministic test identity and the local stub provider. They show shipped UI behavior without implying a live model response or hosted service.

<nav class="docs-tour-index" aria-label="Product tour sections">
  <a href="#work-in-one-document-workspace"><span>01</span> Workspace</a>
  <a href="#review-ai-output-before-it-becomes-document-content"><span>02</span> Proposal review</a>
  <a href="#follow-a-change-from-draft-to-recovery"><span>03</span> Change safety</a>
  <a href="#inspect-docx-loss-before-committing"><span>04</span> DOCX fidelity</a>
  <a href="#keep-trust-boundaries-explicit"><span>05</span> System boundary</a>
</nav>

## Work in one document Workspace

The three-pane surface keeps document context on the left, the Tiptap editor in the center, and review work on the right. The current outline, Project Profile metadata, template, command, and draft remain visible together.

<figure class="docs-figure docs-figure--product">
  <a href="../assets/screenshots/workspace.webp">
    <img src="../assets/screenshots/workspace.webp" alt="Three-pane Coredot Editor Workspace with document outline and metadata, a central strategy brief, and AI review controls" width="1440" height="1000" loading="eager" decoding="async">
  </a>
  <figcaption><span class="docs-figure__evidence"><strong>Evidence.</strong> The captured local app shows the complete Workspace before a review: editable draft, Profile fields, template context, and review action.</span><span class="docs-figure__action">Open the image for the full 1440 × 1000 capture.</span></figcaption>
</figure>

Document saves carry an integer revision. If another tab saves first, the stale writer receives a conflict and keeps its local draft for reload, copy, or save-as-new recovery.

[Review the exact save and recovery contract](ARCHITECTURE.md#revision-and-document-change-lifecycle).

## Review AI output before it becomes document content

Review and rewrite commands create AI Runs and zero or more Proposals. A Proposal is review state, not a direct edit: it can remain pending, be rejected, be inserted below, or be accepted through the document-change service.

<figure class="docs-figure docs-figure--product">
  <a href="../assets/screenshots/proposal-review.webp">
    <img src="../assets/screenshots/proposal-review.webp" alt="Coredot Editor showing highlighted source text and one pending review Proposal with replace, insert, and reject controls" width="1440" height="1000" loading="lazy" decoding="async">
  </a>
  <figcaption><span class="docs-figure__evidence"><strong>Evidence.</strong> A deterministic stub review produced one pending Proposal. Source highlights and the redline preview stay visible while the document remains unchanged.</span><span class="docs-figure__action">Open the image for the full capture.</span></figcaption>
</figure>

The stub proves the application path, not model quality. Evaluate product prompts with representative documents and a real provider before enabling model-backed workflows for users.

Read [Prompting](PROMPTING.md#evaluation-cases) for evaluation cases and [Configuration](configuration.md#ai-providers) for supported provider modes.

## Follow a change from draft to recovery

Single and bulk acceptance submit the current draft plus `expectedRevision`. The server validates every selected Proposal before one transaction updates the document, Proposal statuses, and durable Document Change.

If the revision is stale, no part of the batch applies and Proposals remain pending. Server undo has its own revision precondition; it restores the before-snapshot only while that precondition still holds.

<figure class="docs-figure docs-figure--diagram">
  <a href="../assets/diagrams/product-flow.svg">
    <img src="../assets/diagrams/product-flow.svg" alt="Branching flow from a draft and AI Run through pending, rejected, accepted, conflicted, and undo outcomes" width="1440" height="940" loading="lazy" decoding="async">
  </a>
  <figcaption><span class="docs-figure__evidence"><strong>Decision map.</strong> Pending and rejected paths do not change the document. Acceptance and undo cross a revision check before any mutation.</span><span class="docs-figure__action">Open the SVG for full-size text.</span></figcaption>
</figure>

All-pending actions appear only after Proposal pagination reaches its terminal page. This prevents a bulk request from silently excluding records the client has not loaded.

[Inspect the route contracts](api-reference.md#proposals-and-document-changes) or [read the implementation boundary](ARCHITECTURE.md#revision-and-document-change-lifecycle).

## Inspect DOCX loss before committing

DOCX import converts a file into an unsaved preview first. The user sees warnings and a structured fidelity report before confirmation creates a document. Export also previews fidelity and requires acknowledgement for lossy output.

<figure class="docs-figure docs-figure--product docs-figure--contained">
  <a href="../assets/screenshots/docx-fidelity.webp">
    <img src="../assets/screenshots/docx-fidelity.webp" alt="DOCX import result listing preserved paragraphs, headings, tables, lists, links and marks, approximated formatting, and a removed image" width="1440" height="1000" loading="lazy" decoding="async">
  </a>
  <figcaption><span class="docs-figure__evidence"><strong>Evidence.</strong> The fixture reports common structure as preserved, other DOCX formatting as approximated, and an image as removed before the import is opened.</span><span class="docs-figure__action">Open the full capture.</span></figcaption>
</figure>

The report does not promise Word parity. Comments, tracked changes, headers, footers, pagination, embedded media, and exact layout still need product-specific work and corpus tests.

DOCX input is capped at 10 MiB. Conversion runs under the shared 30-second deadline in a terminable worker so timed-out CPU work cannot persist late results.

[Review resource limits](configuration.md#resource-policies) and [the current DOCX roadmap](ROADMAP.md#full-word-fidelity).

## Keep trust boundaries explicit

Browser input becomes trusted only after server authentication and validation. Clerk or deterministic local identity resolves a Request Context, and repositories include its Workspace ID in reads and writes.

AI provider calls cross an external network boundary from a server adapter. DOCX conversion crosses a separate worker-isolation boundary. SQLite or libSQL remains deployment-owned persistence.

<figure class="docs-figure docs-figure--diagram">
  <a href="../assets/diagrams/system-boundaries.svg">
    <img src="../assets/diagrams/system-boundaries.svg" alt="System diagram showing browser, identity resolution, Request Context, protected Next.js routes, services, Workspace repositories, external providers, DOCX worker, and SQLite or libSQL" width="1440" height="960" loading="lazy" decoding="async">
  </a>
  <figcaption><span class="docs-figure__evidence"><strong>Trust map.</strong> Identity establishes the server-owned Workspace context; repositories enforce scope while provider and conversion adapters isolate risky work.</span><span class="docs-figure__action">Open the SVG for full-size text.</span></figcaption>
</figure>

Test identity is only for local development, isolated demos, and automated tests. Production build and startup reject it and require real Clerk configuration.

[Study the system architecture](ARCHITECTURE.md) or work through [Production Readiness](production-readiness.md).

## Continue from the layer you own

<div class="docs-next-actions" markdown>

- **Product engineer:** choose a built-in or custom [Project Profile](project-profiles.md).
- **AI engineer:** replace templates with the [Prompting contract](PROMPTING.md) intact.
- **Editor engineer:** add build-time behavior through [Plugins](PLUGINS.md).
- **Platform engineer:** review [Configuration](configuration.md), [Deployment](DEPLOYMENT.md), and the [release gate](production-readiness.md#release-gate).

</div>

The shortest evaluation path is [Getting Started](getting-started.md): it runs this workflow locally with no external credentials.
