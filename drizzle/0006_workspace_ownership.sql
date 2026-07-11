PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_documents` (
	`id` text PRIMARY KEY NOT NULL,
	`workspace_id` text NOT NULL,
	`title` text NOT NULL,
	`content_json` text NOT NULL,
	`plain_text` text DEFAULT '' NOT NULL,
	`status` text DEFAULT 'draft' NOT NULL,
	`readiness` text DEFAULT 'draft' NOT NULL,
	`metadata_json` text DEFAULT '{}' NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	CONSTRAINT "documents_status_check" CHECK(`status` in ('draft', 'archived')),
	CONSTRAINT "documents_readiness_check" CHECK(`readiness` in ('draft', 'needs_review', 'ready', 'approved'))
);--> statement-breakpoint
CREATE TABLE `__new_prompt_templates` (
	`id` text PRIMARY KEY NOT NULL,
	`workspace_id` text NOT NULL,
	`name` text NOT NULL,
	`description` text NOT NULL,
	`category` text NOT NULL,
	`system_prompt` text NOT NULL,
	`variable_schema_json` text NOT NULL,
	`is_default` integer DEFAULT false NOT NULL,
	`is_active` integer DEFAULT true NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);--> statement-breakpoint
CREATE TABLE `__new_ai_runs` (
	`id` text PRIMARY KEY NOT NULL,
	`workspace_id` text NOT NULL,
	`document_id` text NOT NULL,
	`prompt_template_id` text,
	`command_type` text NOT NULL,
	`provider` text NOT NULL,
	`model` text NOT NULL,
	`input_summary_json` text NOT NULL,
	`output_text` text DEFAULT '' NOT NULL,
	`status` text NOT NULL,
	`was_applied` integer DEFAULT false NOT NULL,
	`error_message` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`document_id`) REFERENCES `documents`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`prompt_template_id`) REFERENCES `prompt_templates`(`id`) ON UPDATE no action ON DELETE set null,
	CONSTRAINT "ai_runs_command_type_check" CHECK(`command_type` in ('selection_rewrite', 'document_review')),
	CONSTRAINT "ai_runs_status_check" CHECK(`status` in ('pending', 'streaming', 'completed', 'failed'))
);--> statement-breakpoint
CREATE TABLE `__new_ai_proposals` (
	`id` text PRIMARY KEY NOT NULL,
	`workspace_id` text NOT NULL,
	`ai_run_id` text NOT NULL,
	`document_id` text NOT NULL,
	`target_text` text NOT NULL,
	`replacement_text` text NOT NULL,
	`explanation` text NOT NULL,
	`source` text DEFAULT 'review' NOT NULL,
	`command` text,
	`occurrence_index` integer,
	`target_from` integer,
	`target_to` integer,
	`default_apply_mode` text DEFAULT 'replace' NOT NULL,
	`applied_mode` text,
	`status` text DEFAULT 'pending' NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`ai_run_id`) REFERENCES `ai_runs`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`document_id`) REFERENCES `documents`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "ai_proposals_source_check" CHECK(`source` in ('selection', 'review')),
	CONSTRAINT "ai_proposals_default_apply_mode_check" CHECK(`default_apply_mode` in ('replace', 'insert_below')),
	CONSTRAINT "ai_proposals_applied_mode_check" CHECK(`applied_mode` is null or `applied_mode` in ('replace', 'insert_below')),
	CONSTRAINT "ai_proposals_status_check" CHECK(`status` in ('pending', 'accepted', 'rejected'))
);--> statement-breakpoint
CREATE TABLE `__new_app_settings` (
	`id` text PRIMARY KEY NOT NULL,
	`workspace_id` text NOT NULL,
	`ai_provider` text DEFAULT 'stub' NOT NULL,
	`ai_model` text DEFAULT 'stub-editor' NOT NULL,
	`ai_base_url` text,
	`ai_max_completion_tokens` integer,
	`ai_reasoning_effort` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	CONSTRAINT "app_settings_ai_provider_check" CHECK(`ai_provider` in ('stub', 'openai', 'coredot', 'anthropic', 'gemini')),
	CONSTRAINT "app_settings_ai_reasoning_effort_check" CHECK(`ai_reasoning_effort` is null or `ai_reasoning_effort` in ('none', 'minimal', 'low', 'medium', 'high', 'xhigh')),
	CONSTRAINT "app_settings_ai_max_completion_tokens_check" CHECK(`ai_max_completion_tokens` is null or `ai_max_completion_tokens` > 0)
);--> statement-breakpoint
INSERT INTO `__new_documents` (`id`, `workspace_id`, `title`, `content_json`, `plain_text`, `status`, `readiness`, `metadata_json`, `created_at`, `updated_at`)
SELECT `id`, 'local', `title`, `content_json`, `plain_text`, `status`, `readiness`, `metadata_json`, `created_at`, `updated_at` FROM `documents`;--> statement-breakpoint
INSERT INTO `__new_prompt_templates` (`id`, `workspace_id`, `name`, `description`, `category`, `system_prompt`, `variable_schema_json`, `is_default`, `is_active`, `created_at`, `updated_at`)
SELECT `id`, 'local', `name`, `description`, `category`, `system_prompt`, `variable_schema_json`, `is_default`, `is_active`, `created_at`, `updated_at` FROM `prompt_templates`;--> statement-breakpoint
INSERT INTO `__new_ai_runs` (`id`, `workspace_id`, `document_id`, `prompt_template_id`, `command_type`, `provider`, `model`, `input_summary_json`, `output_text`, `status`, `was_applied`, `error_message`, `created_at`, `updated_at`)
SELECT `id`, 'local', `document_id`, `prompt_template_id`, `command_type`, `provider`, `model`, `input_summary_json`, `output_text`, `status`, `was_applied`, `error_message`, `created_at`, `updated_at` FROM `ai_runs`;--> statement-breakpoint
INSERT INTO `__new_ai_proposals` (`id`, `workspace_id`, `ai_run_id`, `document_id`, `target_text`, `replacement_text`, `explanation`, `source`, `command`, `occurrence_index`, `target_from`, `target_to`, `default_apply_mode`, `applied_mode`, `status`, `created_at`, `updated_at`)
SELECT `id`, 'local', `ai_run_id`, `document_id`, `target_text`, `replacement_text`, `explanation`, `source`, `command`, `occurrence_index`, `target_from`, `target_to`, `default_apply_mode`, `applied_mode`, `status`, `created_at`, `updated_at` FROM `ai_proposals`;--> statement-breakpoint
INSERT INTO `__new_app_settings` (`id`, `workspace_id`, `ai_provider`, `ai_model`, `ai_base_url`, `ai_max_completion_tokens`, `ai_reasoning_effort`, `created_at`, `updated_at`)
SELECT `id`, 'local', `ai_provider`, `ai_model`, `ai_base_url`, `ai_max_completion_tokens`, `ai_reasoning_effort`, `created_at`, `updated_at` FROM `app_settings`;--> statement-breakpoint
DROP TABLE `ai_proposals`;--> statement-breakpoint
DROP TABLE `ai_runs`;--> statement-breakpoint
DROP TABLE `documents`;--> statement-breakpoint
DROP TABLE `prompt_templates`;--> statement-breakpoint
DROP TABLE `app_settings`;--> statement-breakpoint
ALTER TABLE `__new_documents` RENAME TO `documents`;--> statement-breakpoint
ALTER TABLE `__new_prompt_templates` RENAME TO `prompt_templates`;--> statement-breakpoint
ALTER TABLE `__new_ai_runs` RENAME TO `ai_runs`;--> statement-breakpoint
ALTER TABLE `__new_ai_proposals` RENAME TO `ai_proposals`;--> statement-breakpoint
ALTER TABLE `__new_app_settings` RENAME TO `app_settings`;--> statement-breakpoint
CREATE INDEX `documents_readiness_idx` ON `documents` (`readiness`);--> statement-breakpoint
CREATE INDEX `documents_workspace_status_updated_idx` ON `documents` (`workspace_id`, `status`, `updated_at`);--> statement-breakpoint
CREATE INDEX `prompt_templates_workspace_active_name_idx` ON `prompt_templates` (`workspace_id`, `is_active`, `name`);--> statement-breakpoint
CREATE INDEX `ai_runs_document_id_idx` ON `ai_runs` (`document_id`);--> statement-breakpoint
CREATE INDEX `ai_runs_prompt_template_id_idx` ON `ai_runs` (`prompt_template_id`);--> statement-breakpoint
CREATE INDEX `ai_runs_workspace_document_created_idx` ON `ai_runs` (`workspace_id`, `document_id`, `created_at`);--> statement-breakpoint
CREATE INDEX `ai_proposals_ai_run_id_idx` ON `ai_proposals` (`ai_run_id`);--> statement-breakpoint
CREATE INDEX `ai_proposals_document_id_idx` ON `ai_proposals` (`document_id`);--> statement-breakpoint
CREATE INDEX `ai_proposals_workspace_document_created_idx` ON `ai_proposals` (`workspace_id`, `document_id`, `created_at`);--> statement-breakpoint
CREATE UNIQUE INDEX `app_settings_workspace_id_unique` ON `app_settings` (`workspace_id`);--> statement-breakpoint
PRAGMA foreign_keys=ON;
