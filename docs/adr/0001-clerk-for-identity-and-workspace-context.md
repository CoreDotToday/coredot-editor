---
status: accepted
---

# Use Clerk for identity and workspace context

Coredot Editor will use Clerk for authentication and organization membership, while an internal request-context interface keeps Clerk types out of repositories and domain modules. A Clerk organization becomes a shared Workspace and a Clerk user without an active organization receives a personal Workspace; a deterministic test adapter supplies the same context in automated tests. This chooses faster, first-class Next.js App Router integration over self-hosting identity, while preserving a seam that keeps authorization and ownership rules inside Coredot Editor.

## Considered Options

- Better Auth offered self-hosted identity and an organization plugin but would make the starter responsible for more identity operations and migrations.
- A provider-neutral interface without a production adapter avoided lock-in but would leave the public starter unsafe to deploy.

## Consequences

- Production startup fails closed when Clerk configuration is absent.
- Repositories accept Workspace context rather than naked record IDs.
- Clerk remains an adapter; document, AI, and proposal modules do not import Clerk types.
- Existing unscoped data is assigned to the local Workspace and can be moved only through an explicit claim script.
