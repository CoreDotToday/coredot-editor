# API Reference

These routes are app-internal JSON contracts for the starter. They are documented so downstream forks can keep UI, tests, and integrations aligned while evolving the product.

Routes resolve an authenticated request context and scope persistence to its workspace. Administrative settings mutations and provider connection tests require the workspace `owner` or `admin` role.

## Documents

| Route | Method | Purpose |
| --- | --- | --- |
| `/api/documents` | `GET` | List active documents. |
| `/api/documents` | `POST` | Create a document. |
| `/api/documents/:id` | `GET` | Load one document. |
| `/api/documents/:id` | `PUT` | Save document title, content JSON, plain text, readiness, and metadata. |
| `/api/documents/:id` | `DELETE` | Archive a document. |
| `/api/documents/import` | `POST` | Import a `.docx` file and create a document. |
| `/api/documents/:id/export` | `POST` | Export the current draft as `.docx`. |

## Templates

| Route | Method | Purpose |
| --- | --- | --- |
| `/api/templates` | `GET` | List prompt templates. |
| `/api/templates` | `POST` | Create a prompt template. |
| `/api/templates/:id` | `PUT` | Update a prompt template. |
| `/api/templates/:id` | `DELETE` | Archive a prompt template. |

Template payloads are validated against `src/features/templates/template-validation.ts`. Variable schemas drive UI input rendering and server-side validation.

## AI Settings

| Route | Method | Purpose |
| --- | --- | --- |
| `/api/settings/ai` | `GET` | Read non-secret AI runtime settings plus secret presence booleans. |
| `/api/settings/ai` | `PUT` | Save non-secret provider, model, Base URL, token, and reasoning settings. |
| `/api/settings/ai/test` | `POST` | Test the current server-side provider configuration as an owner/admin. Limited to 5 attempts per minute per workspace principal and aborted after 30 seconds. |

API keys are not accepted or returned through these routes.

## AI Commands

| Route | Method | Purpose |
| --- | --- | --- |
| `/api/ai/review` | `POST` | Run a structured review and persist proposals. |
| `/api/ai/rewrite` | `POST` | Run a selected-text, current-block, or document-level rewrite and persist a proposal. |

Both routes share preflight through `src/features/ai/ai-command-service.ts` for document lookup, template validation, provider settings, and server-side reference hydration.

## Proposals

| Route | Method | Purpose |
| --- | --- | --- |
| `/api/proposals/:id/apply` | `POST` | Apply a proposal to the saved server document and mark it accepted in one transaction. |
| `/api/proposals/:id` | `PATCH` | Reject or reset proposal status with an expected-status precondition. |

The generic proposal `PATCH` route rejects `accepted` status changes. Acceptance must go through `/api/proposals/:id/apply` so document content and proposal status cannot split.

## Error Shape

Most invalid requests return:

```json
{ "error": "Invalid request body" }
```

Conflict responses include enough context for the client to refresh local state, such as the current proposal or an explanation that the saved document changed.
