ALTER TABLE `ai_runs` ADD `execution_token` text;--> statement-breakpoint
CREATE INDEX `ai_runs_status_updated_idx` ON `ai_runs` (`status`,`updated_at`);
