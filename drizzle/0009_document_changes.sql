CREATE UNIQUE INDEX `ai_proposals_workspace_id_id_document_id_unique`
ON `ai_proposals` (`workspace_id`, `id`, `document_id`);
--> statement-breakpoint
CREATE TABLE `document_changes` (
	`id` text PRIMARY KEY NOT NULL,
	`workspace_id` text NOT NULL,
	`document_id` text NOT NULL,
	`principal_id` text NOT NULL,
	`request_id` text NOT NULL,
	`kind` text NOT NULL,
	`batch_id` text,
	`before_snapshot_json` text NOT NULL,
	`after_revision` integer NOT NULL,
	`created_at` integer NOT NULL,
	`undone_at` integer,
	CONSTRAINT `document_changes_workspace_document_fk`
		FOREIGN KEY (`workspace_id`, `document_id`)
		REFERENCES `documents` (`workspace_id`, `id`) ON DELETE cascade,
	CONSTRAINT `document_changes_kind_check` CHECK (`kind` in ('single', 'batch')),
	CONSTRAINT `document_changes_after_revision_check` CHECK (`after_revision` > 0),
	CONSTRAINT `document_changes_batch_id_check`
		CHECK ((`kind` = 'single' and `batch_id` is null) or (`kind` = 'batch' and `batch_id` is not null))
);
--> statement-breakpoint
CREATE INDEX `document_changes_workspace_document_created_idx`
ON `document_changes` (`workspace_id`, `document_id`, `created_at`);
--> statement-breakpoint
CREATE UNIQUE INDEX `document_changes_workspace_id_document_unique`
ON `document_changes` (`workspace_id`, `id`, `document_id`);
--> statement-breakpoint
CREATE TABLE `document_change_proposals` (
	`workspace_id` text NOT NULL,
	`change_id` text NOT NULL,
	`document_id` text NOT NULL,
	`proposal_id` text NOT NULL,
	`applied_mode` text NOT NULL,
	`ordinal` integer NOT NULL,
	CONSTRAINT `document_change_proposals_pk` PRIMARY KEY (`workspace_id`, `change_id`, `proposal_id`),
	CONSTRAINT `document_change_proposals_change_fk`
		FOREIGN KEY (`workspace_id`, `change_id`, `document_id`)
		REFERENCES `document_changes` (`workspace_id`, `id`, `document_id`) ON DELETE cascade,
	CONSTRAINT `document_change_proposals_proposal_fk`
		FOREIGN KEY (`workspace_id`, `proposal_id`, `document_id`)
		REFERENCES `ai_proposals` (`workspace_id`, `id`, `document_id`) ON DELETE cascade,
	CONSTRAINT `document_change_proposals_mode_check` CHECK (`applied_mode` in ('replace', 'insert_below')),
	CONSTRAINT `document_change_proposals_ordinal_check` CHECK (`ordinal` >= 0)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `document_change_proposals_workspace_change_ordinal_unique`
ON `document_change_proposals` (`workspace_id`, `change_id`, `ordinal`);
--> statement-breakpoint
CREATE INDEX `document_change_proposals_workspace_proposal_idx`
ON `document_change_proposals` (`workspace_id`, `proposal_id`);
