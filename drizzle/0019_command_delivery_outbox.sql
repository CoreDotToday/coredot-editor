PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_collaboration_actions` (
	`id` text PRIMARY KEY NOT NULL,
	`workspace_id` text NOT NULL,
	`document_id` text NOT NULL,
	`generation` integer NOT NULL,
	`command_id` text NOT NULL,
	`command_fingerprint` text NOT NULL,
	`action_type` text NOT NULL,
	`principal_id` text NOT NULL,
	`request_id` text NOT NULL,
	`base_head_seq` integer NOT NULL,
	`applied_head_seq` integer,
	`proposal_id` text,
	`document_change_id` text,
	`status` text NOT NULL,
	`failure_category` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`workspace_id`,`document_id`,`generation`) REFERENCES `collaboration_documents`(`workspace_id`,`document_id`,`generation`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`workspace_id`,`proposal_id`,`document_id`) REFERENCES `ai_proposals`(`workspace_id`,`id`,`document_id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`workspace_id`,`document_change_id`,`document_id`) REFERENCES `document_changes`(`workspace_id`,`id`,`document_id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "collaboration_actions_generation_check" CHECK(typeof("generation") = 'integer' and "generation" between 1 and 9007199254740991),
	CONSTRAINT "collaboration_actions_type_check" CHECK("action_type" in ('proposal_apply', 'proposal_batch_apply', 'selective_undo', 'repair')),
	CONSTRAINT "collaboration_actions_status_check" CHECK("status" in ('pending', 'applied', 'failed')),
	CONSTRAINT "collaboration_actions_sequence_check" CHECK(typeof("base_head_seq") = 'integer' and "base_head_seq" between 0 and 9007199254740991
        and ("applied_head_seq" is null or (
          typeof("applied_head_seq") = 'integer'
          and "applied_head_seq" between 0 and 9007199254740991
          and "applied_head_seq" >= "base_head_seq"
        ))),
	CONSTRAINT "collaboration_actions_state_check" CHECK(("status" = 'pending' and "applied_head_seq" is null and "failure_category" is null)
        or ("status" = 'applied' and "applied_head_seq" is not null and "failure_category" is null)
        or ("status" = 'failed' and "applied_head_seq" is null and "failure_category" is not null)),
	CONSTRAINT "collaboration_actions_command_id_check" CHECK(typeof("command_id") = 'text'
        and "command_id" = trim("command_id", char(9) || char(10) || char(11) || char(12) || char(13) || char(160) || ' ')
        and length(cast("command_id" as blob)) between 1 and 256),
	CONSTRAINT "collaboration_actions_command_fingerprint_check" CHECK(typeof("command_fingerprint") = 'text'
        and length("command_fingerprint") = 64
        and "command_fingerprint" not glob '*[^0-9a-f]*'),
	CONSTRAINT "collaboration_actions_failure_category_check" CHECK("failure_category" is null or (
        typeof("failure_category") = 'text'
        and "failure_category" = trim("failure_category", char(9) || char(10) || char(13) || ' ')
        and length(cast("failure_category" as blob)) between 1 and 128
      ))
);--> statement-breakpoint
INSERT INTO `__new_collaboration_actions`(
  "id", "workspace_id", "document_id", "generation", "command_id", "command_fingerprint",
  "action_type", "principal_id", "request_id", "base_head_seq", "applied_head_seq", "proposal_id",
  "document_change_id", "status", "failure_category", "created_at", "updated_at"
) SELECT
  "id", "workspace_id", "document_id", "generation", "command_id", lower(hex(randomblob(32))),
  "action_type", "principal_id", "request_id", "base_head_seq", "applied_head_seq", "proposal_id",
  "document_change_id", "status", "failure_category", "created_at", "updated_at"
FROM `collaboration_actions`;--> statement-breakpoint
DROP TABLE `collaboration_actions`;--> statement-breakpoint
ALTER TABLE `__new_collaboration_actions` RENAME TO `collaboration_actions`;--> statement-breakpoint
CREATE UNIQUE INDEX `collaboration_actions_workspace_id_document_generation_unique` ON `collaboration_actions` (`workspace_id`,`id`,`document_id`,`generation`);--> statement-breakpoint
CREATE UNIQUE INDEX `collaboration_actions_workspace_command_unique` ON `collaboration_actions` (`workspace_id`,`command_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `collaboration_actions_delivery_identity_unique` ON `collaboration_actions` (`workspace_id`,`id`,`document_id`,`generation`,`command_id`,`command_fingerprint`);--> statement-breakpoint
CREATE INDEX `collaboration_actions_workspace_document_generation_created_id_idx` ON `collaboration_actions` (`workspace_id`,`document_id`,`generation`,`created_at`,`id`);--> statement-breakpoint
CREATE UNIQUE INDEX `collaboration_updates_exact_checksum_unique` ON `collaboration_updates` (`workspace_id`,`document_id`,`generation`,`seq`,`checksum`);--> statement-breakpoint
CREATE TABLE `collaboration_command_delivery_jobs` (
	`workspace_id` text NOT NULL,
	`action_id` text NOT NULL,
	`command_id` text NOT NULL,
	`command_fingerprint` text NOT NULL,
	`document_id` text NOT NULL,
	`generation` integer NOT NULL,
	`seq` integer NOT NULL,
	`checksum` text NOT NULL,
	`status` text DEFAULT 'pending' NOT NULL,
	`attempts` integer DEFAULT 0 NOT NULL,
	`next_attempt_at` integer,
	`failure_category` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	PRIMARY KEY(`workspace_id`, `action_id`),
	FOREIGN KEY (`workspace_id`,`action_id`,`document_id`,`generation`,`command_id`,`command_fingerprint`) REFERENCES `collaboration_actions`(`workspace_id`,`id`,`document_id`,`generation`,`command_id`,`command_fingerprint`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`workspace_id`,`document_id`,`generation`,`seq`,`checksum`) REFERENCES `collaboration_updates`(`workspace_id`,`document_id`,`generation`,`seq`,`checksum`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "collaboration_command_delivery_jobs_sequence_check" CHECK(typeof("generation") = 'integer'
        and "generation" between 1 and 9007199254740991
        and typeof("seq") = 'integer'
        and "seq" between 1 and 9007199254740991),
	CONSTRAINT "collaboration_command_delivery_jobs_checksum_check" CHECK(typeof("checksum") = 'text'
        and length("checksum") = 64
        and "checksum" not glob '*[^0-9a-f]*'),
	CONSTRAINT "collaboration_command_delivery_jobs_command_fingerprint_check" CHECK(typeof("command_fingerprint") = 'text'
        and length("command_fingerprint") = 64
        and "command_fingerprint" not glob '*[^0-9a-f]*'),
	CONSTRAINT "collaboration_command_delivery_jobs_retry_state_check" CHECK((
          "status" = 'pending'
          and typeof("attempts") = 'integer'
          and "attempts" between 0 and 4
          and typeof("next_attempt_at") = 'integer'
          and "next_attempt_at" >= "created_at"
          and (("attempts" = 0 and "failure_category" is null)
            or ("attempts" > 0 and "failure_category" = 'delivery_failed'))
        ) or (
          "status" = 'exhausted'
          and "attempts" = 5
          and "next_attempt_at" is null
          and "failure_category" = 'delivery_failed'
        )),
	CONSTRAINT "collaboration_command_delivery_jobs_timestamps_check" CHECK(typeof("created_at") = 'integer'
        and typeof("updated_at") = 'integer'
        and "updated_at" >= "created_at")
);--> statement-breakpoint
CREATE UNIQUE INDEX `collaboration_command_delivery_jobs_update_unique` ON `collaboration_command_delivery_jobs` (`workspace_id`,`document_id`,`generation`,`seq`);--> statement-breakpoint
CREATE INDEX `collaboration_command_delivery_jobs_due_idx` ON `collaboration_command_delivery_jobs` (`status`,`next_attempt_at`,`created_at`,`workspace_id`,`document_id`,`generation`,`seq`);--> statement-breakpoint
PRAGMA foreign_keys=ON;
