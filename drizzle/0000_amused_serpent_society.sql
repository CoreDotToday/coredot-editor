CREATE TABLE `ai_proposals` (
	`id` text PRIMARY KEY NOT NULL,
	`ai_run_id` text NOT NULL,
	`document_id` text NOT NULL,
	`target_text` text NOT NULL,
	`replacement_text` text NOT NULL,
	`explanation` text NOT NULL,
	`status` text DEFAULT 'pending' NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`ai_run_id`) REFERENCES `ai_runs`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`document_id`) REFERENCES `documents`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "ai_proposals_status_check" CHECK("ai_proposals"."status" in ('pending', 'accepted', 'rejected'))
);
--> statement-breakpoint
CREATE INDEX `ai_proposals_ai_run_id_idx` ON `ai_proposals` (`ai_run_id`);--> statement-breakpoint
CREATE INDEX `ai_proposals_document_id_idx` ON `ai_proposals` (`document_id`);--> statement-breakpoint
CREATE TABLE `ai_runs` (
	`id` text PRIMARY KEY NOT NULL,
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
	CONSTRAINT "ai_runs_command_type_check" CHECK("ai_runs"."command_type" in ('selection_rewrite', 'document_review')),
	CONSTRAINT "ai_runs_status_check" CHECK("ai_runs"."status" in ('pending', 'streaming', 'completed', 'failed'))
);
--> statement-breakpoint
CREATE INDEX `ai_runs_document_id_idx` ON `ai_runs` (`document_id`);--> statement-breakpoint
CREATE INDEX `ai_runs_prompt_template_id_idx` ON `ai_runs` (`prompt_template_id`);--> statement-breakpoint
CREATE TABLE `documents` (
	`id` text PRIMARY KEY NOT NULL,
	`title` text NOT NULL,
	`content_json` text NOT NULL,
	`plain_text` text DEFAULT '' NOT NULL,
	`status` text DEFAULT 'draft' NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	CONSTRAINT "documents_status_check" CHECK("documents"."status" in ('draft', 'archived'))
);
--> statement-breakpoint
CREATE TABLE `prompt_templates` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`description` text NOT NULL,
	`category` text NOT NULL,
	`system_prompt` text NOT NULL,
	`variable_schema_json` text NOT NULL,
	`is_default` integer DEFAULT false NOT NULL,
	`is_active` integer DEFAULT true NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
