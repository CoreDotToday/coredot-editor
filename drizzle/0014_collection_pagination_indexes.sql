CREATE INDEX `documents_workspace_status_updated_id_idx`
ON `documents` (`workspace_id`, `status`, `updated_at`, `id`);
--> statement-breakpoint
CREATE INDEX `ai_runs_workspace_document_created_id_idx`
ON `ai_runs` (`workspace_id`, `document_id`, `created_at`, `id`);
--> statement-breakpoint
CREATE INDEX `ai_proposals_workspace_document_created_id_idx`
ON `ai_proposals` (`workspace_id`, `document_id`, `created_at`, `id`);
--> statement-breakpoint
DROP INDEX `documents_workspace_status_updated_idx`;
--> statement-breakpoint
DROP INDEX `ai_runs_workspace_document_created_idx`;
--> statement-breakpoint
DROP INDEX `ai_proposals_workspace_document_created_idx`;
