ALTER TABLE `ai_runs` ADD `idempotency_key` text;
--> statement-breakpoint
ALTER TABLE `ai_runs` ADD `operation_fingerprint` text;
--> statement-breakpoint
ALTER TABLE `ai_runs` ADD `retry_not_before_at` integer;
--> statement-breakpoint
CREATE UNIQUE INDEX `ai_runs_workspace_idempotency_key_unique`
ON `ai_runs` (`workspace_id`, `idempotency_key`);
--> statement-breakpoint
ALTER TABLE `ai_proposals` ADD `result_ordinal` integer;
--> statement-breakpoint
CREATE UNIQUE INDEX `ai_proposals_workspace_run_result_ordinal_unique`
ON `ai_proposals` (`workspace_id`, `ai_run_id`, `result_ordinal`);
