PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_ai_proposals` (
	`id` text PRIMARY KEY NOT NULL,
	`ai_run_id` text NOT NULL,
	`document_id` text NOT NULL,
	`target_text` text NOT NULL,
	`replacement_text` text NOT NULL,
	`explanation` text NOT NULL,
	`source` text DEFAULT 'review' NOT NULL,
	`command` text,
	`default_apply_mode` text DEFAULT 'replace' NOT NULL,
	`applied_mode` text,
	`status` text DEFAULT 'pending' NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`ai_run_id`) REFERENCES `ai_runs`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`document_id`) REFERENCES `documents`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "ai_proposals_source_check" CHECK("__new_ai_proposals"."source" in ('selection', 'review')),
	CONSTRAINT "ai_proposals_default_apply_mode_check" CHECK("__new_ai_proposals"."default_apply_mode" in ('replace', 'insert_below')),
	CONSTRAINT "ai_proposals_applied_mode_check" CHECK("__new_ai_proposals"."applied_mode" is null or "__new_ai_proposals"."applied_mode" in ('replace', 'insert_below')),
	CONSTRAINT "ai_proposals_status_check" CHECK("__new_ai_proposals"."status" in ('pending', 'accepted', 'rejected'))
);
--> statement-breakpoint
INSERT INTO `__new_ai_proposals`("id", "ai_run_id", "document_id", "target_text", "replacement_text", "explanation", "source", "command", "default_apply_mode", "applied_mode", "status", "created_at", "updated_at") SELECT "id", "ai_run_id", "document_id", "target_text", "replacement_text", "explanation", 'review', null, 'replace', null, "status", "created_at", "updated_at" FROM `ai_proposals`;--> statement-breakpoint
DROP TABLE `ai_proposals`;--> statement-breakpoint
ALTER TABLE `__new_ai_proposals` RENAME TO `ai_proposals`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
CREATE INDEX `ai_proposals_ai_run_id_idx` ON `ai_proposals` (`ai_run_id`);--> statement-breakpoint
CREATE INDEX `ai_proposals_document_id_idx` ON `ai_proposals` (`document_id`);
