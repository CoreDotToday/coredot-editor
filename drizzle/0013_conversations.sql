CREATE TABLE `ai_workspace_conversations` (
	`id` text PRIMARY KEY NOT NULL,
	`workspace_id` text NOT NULL,
	`document_id` text NOT NULL,
	`created_by_principal_id` text NOT NULL,
	`creation_key` text NOT NULL,
	`creation_fingerprint` text NOT NULL,
	`title` text NOT NULL,
	`command` text NOT NULL,
	`status` text DEFAULT 'idle' NOT NULL,
	`version` integer DEFAULT 1 NOT NULL,
	`message_count` integer DEFAULT 1 NOT NULL,
	`latest_ai_run_id` text,
	`latest_proposal_id` text,
	`archived_at` integer,
	`retention_expires_at` integer,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	CONSTRAINT `ai_workspace_conversations_workspace_document_fk`
		FOREIGN KEY (`workspace_id`, `document_id`)
		REFERENCES `documents` (`workspace_id`, `id`) ON DELETE cascade,
	CONSTRAINT `ai_workspace_conversations_latest_run_fk`
		FOREIGN KEY (`workspace_id`, `latest_ai_run_id`, `document_id`)
		REFERENCES `ai_runs` (`workspace_id`, `id`, `document_id`),
	CONSTRAINT `ai_workspace_conversations_latest_proposal_fk`
		FOREIGN KEY (`workspace_id`, `latest_proposal_id`, `document_id`)
		REFERENCES `ai_proposals` (`workspace_id`, `id`, `document_id`),
	CONSTRAINT `ai_workspace_conversations_status_check`
		CHECK (`status` in ('idle', 'failed')),
	CONSTRAINT `ai_workspace_conversations_version_check` CHECK (`version` >= 1),
	CONSTRAINT `ai_workspace_conversations_message_count_check` CHECK (`message_count` >= 1),
	CONSTRAINT `ai_workspace_conversations_retention_check`
		CHECK (`retention_expires_at` is null or `retention_expires_at` > `created_at`)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `ai_workspace_conversations_workspace_id_document_unique`
ON `ai_workspace_conversations` (`workspace_id`, `id`, `document_id`);
--> statement-breakpoint
CREATE UNIQUE INDEX `ai_workspace_conversations_workspace_creation_key_unique`
ON `ai_workspace_conversations` (`workspace_id`, `creation_key`);
--> statement-breakpoint
CREATE INDEX `ai_workspace_conversations_workspace_document_updated_idx`
ON `ai_workspace_conversations` (`workspace_id`, `document_id`, `archived_at`, `updated_at`, `id`);
--> statement-breakpoint
CREATE INDEX `ai_workspace_conversations_retention_expires_idx`
ON `ai_workspace_conversations` (`retention_expires_at`);
--> statement-breakpoint
CREATE TABLE `ai_workspace_messages` (
	`id` text PRIMARY KEY NOT NULL,
	`workspace_id` text NOT NULL,
	`conversation_id` text NOT NULL,
	`document_id` text NOT NULL,
	`mutation_key` text NOT NULL,
	`mutation_fingerprint` text NOT NULL,
	`ordinal` integer NOT NULL,
	`role` text NOT NULL,
	`content` text NOT NULL,
	`command` text,
	`scope_label` text,
	`ai_run_id` text,
	`proposal_id` text,
	`retention_expires_at` integer,
	`created_at` integer NOT NULL,
	CONSTRAINT `ai_workspace_messages_conversation_fk`
		FOREIGN KEY (`workspace_id`, `conversation_id`, `document_id`)
		REFERENCES `ai_workspace_conversations` (`workspace_id`, `id`, `document_id`) ON DELETE cascade,
	CONSTRAINT `ai_workspace_messages_run_fk`
		FOREIGN KEY (`workspace_id`, `ai_run_id`, `document_id`)
		REFERENCES `ai_runs` (`workspace_id`, `id`, `document_id`),
	CONSTRAINT `ai_workspace_messages_proposal_fk`
		FOREIGN KEY (`workspace_id`, `proposal_id`, `document_id`)
		REFERENCES `ai_proposals` (`workspace_id`, `id`, `document_id`),
	CONSTRAINT `ai_workspace_messages_ordinal_check` CHECK (`ordinal` >= 0),
	CONSTRAINT `ai_workspace_messages_role_check` CHECK (`role` in ('assistant', 'user'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `ai_workspace_messages_conversation_ordinal_unique`
ON `ai_workspace_messages` (`workspace_id`, `conversation_id`, `ordinal`);
--> statement-breakpoint
CREATE UNIQUE INDEX `ai_workspace_messages_conversation_mutation_key_unique`
ON `ai_workspace_messages` (`workspace_id`, `conversation_id`, `mutation_key`);
--> statement-breakpoint
CREATE INDEX `ai_workspace_messages_workspace_run_idx`
ON `ai_workspace_messages` (`workspace_id`, `ai_run_id`);
--> statement-breakpoint
CREATE INDEX `ai_workspace_messages_workspace_proposal_idx`
ON `ai_workspace_messages` (`workspace_id`, `proposal_id`);
--> statement-breakpoint
CREATE INDEX `ai_workspace_messages_retention_expires_idx`
ON `ai_workspace_messages` (`retention_expires_at`);
