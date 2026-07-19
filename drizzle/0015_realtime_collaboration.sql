CREATE TABLE `collaboration_documents` (
	`workspace_id` text NOT NULL,
	`document_id` text NOT NULL,
	`generation` integer NOT NULL,
	`schema_version` integer NOT NULL,
	`schema_fingerprint` text NOT NULL,
	`checkpoint_blob` blob NOT NULL,
	`checkpoint_checksum` text NOT NULL,
	`head_seq` integer DEFAULT 0 NOT NULL,
	`checkpoint_seq` integer DEFAULT 0 NOT NULL,
	`projected_seq` integer DEFAULT 0 NOT NULL,
	`last_checkpoint_at` integer NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	CONSTRAINT `collaboration_documents_pk` PRIMARY KEY (`workspace_id`, `document_id`),
	CONSTRAINT `collaboration_documents_workspace_document_fk`
		FOREIGN KEY (`workspace_id`, `document_id`)
		REFERENCES `documents` (`workspace_id`, `id`) ON DELETE cascade,
	CONSTRAINT `collaboration_documents_generation_check`
		CHECK (typeof(`generation`) = 'integer' and `generation` between 1 and 9007199254740991),
	CONSTRAINT `collaboration_documents_schema_version_check`
		CHECK (typeof(`schema_version`) = 'integer' and `schema_version` between 1 and 9007199254740991),
	CONSTRAINT `collaboration_documents_sequence_check`
		CHECK (typeof(`head_seq`) = 'integer' and `head_seq` between 0 and 9007199254740991
			and typeof(`checkpoint_seq`) = 'integer' and `checkpoint_seq` between 0 and 9007199254740991
			and typeof(`projected_seq`) = 'integer' and `projected_seq` between 0 and 9007199254740991
			and `checkpoint_seq` <= `projected_seq`
			and `projected_seq` <= `head_seq`),
	CONSTRAINT `collaboration_documents_schema_fingerprint_check`
		CHECK (length(`schema_fingerprint`) = 64 and `schema_fingerprint` not glob '*[^0-9a-f]*'),
	CONSTRAINT `collaboration_documents_checkpoint_checksum_check`
		CHECK (length(`checkpoint_checksum`) = 64 and `checkpoint_checksum` not glob '*[^0-9a-f]*')
);
--> statement-breakpoint
CREATE UNIQUE INDEX `collaboration_documents_workspace_document_generation_unique`
ON `collaboration_documents` (`workspace_id`, `document_id`, `generation`);
--> statement-breakpoint
CREATE TABLE `collaboration_actions` (
	`id` text PRIMARY KEY NOT NULL,
	`workspace_id` text NOT NULL,
	`document_id` text NOT NULL,
	`generation` integer NOT NULL,
	`command_id` text NOT NULL,
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
	CONSTRAINT `collaboration_actions_document_generation_fk`
		FOREIGN KEY (`workspace_id`, `document_id`, `generation`)
		REFERENCES `collaboration_documents` (`workspace_id`, `document_id`, `generation`) ON DELETE cascade,
	CONSTRAINT `collaboration_actions_proposal_fk`
		FOREIGN KEY (`workspace_id`, `proposal_id`, `document_id`)
		REFERENCES `ai_proposals` (`workspace_id`, `id`, `document_id`),
	CONSTRAINT `collaboration_actions_document_change_fk`
		FOREIGN KEY (`workspace_id`, `document_change_id`, `document_id`)
		REFERENCES `document_changes` (`workspace_id`, `id`, `document_id`),
	CONSTRAINT `collaboration_actions_generation_check`
		CHECK (typeof(`generation`) = 'integer' and `generation` between 1 and 9007199254740991),
	CONSTRAINT `collaboration_actions_type_check`
		CHECK (`action_type` in ('proposal_apply', 'proposal_batch_apply', 'selective_undo', 'repair')),
	CONSTRAINT `collaboration_actions_status_check`
		CHECK (`status` in ('pending', 'applied', 'failed')),
	CONSTRAINT `collaboration_actions_sequence_check`
		CHECK (typeof(`base_head_seq`) = 'integer' and `base_head_seq` between 0 and 9007199254740991
			and (`applied_head_seq` is null or (
				typeof(`applied_head_seq`) = 'integer'
				and `applied_head_seq` between 0 and 9007199254740991
				and `applied_head_seq` >= `base_head_seq`
			))),
	CONSTRAINT `collaboration_actions_state_check`
		CHECK ((`status` = 'pending' and `applied_head_seq` is null and `failure_category` is null)
			or (`status` = 'applied' and `applied_head_seq` is not null and `failure_category` is null)
			or (`status` = 'failed' and `applied_head_seq` is null and `failure_category` is not null))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `collaboration_actions_workspace_id_document_generation_unique`
ON `collaboration_actions` (`workspace_id`, `id`, `document_id`, `generation`);
--> statement-breakpoint
CREATE UNIQUE INDEX `collaboration_actions_workspace_command_unique`
ON `collaboration_actions` (`workspace_id`, `command_id`);
--> statement-breakpoint
CREATE INDEX `collaboration_actions_workspace_document_generation_created_id_idx`
ON `collaboration_actions` (`workspace_id`, `document_id`, `generation`, `created_at`, `id`);
--> statement-breakpoint
CREATE TABLE `collaboration_updates` (
	`workspace_id` text NOT NULL,
	`document_id` text NOT NULL,
	`generation` integer NOT NULL,
	`seq` integer NOT NULL,
	`update_blob` blob NOT NULL,
	`checksum` text NOT NULL,
	`idempotency_key` text NOT NULL,
	`origin_kind` text NOT NULL,
	`principal_id` text,
	`request_id` text,
	`session_id` text,
	`semantic_action_id` text,
	`diagnostic_json` text,
	`created_at` integer NOT NULL,
	CONSTRAINT `collaboration_updates_pk`
		PRIMARY KEY (`workspace_id`, `document_id`, `generation`, `seq`),
	CONSTRAINT `collaboration_updates_document_generation_fk`
		FOREIGN KEY (`workspace_id`, `document_id`, `generation`)
		REFERENCES `collaboration_documents` (`workspace_id`, `document_id`, `generation`) ON DELETE cascade,
	CONSTRAINT `collaboration_updates_semantic_action_fk`
		FOREIGN KEY (`workspace_id`, `semantic_action_id`, `document_id`, `generation`)
		REFERENCES `collaboration_actions` (`workspace_id`, `id`, `document_id`, `generation`),
	CONSTRAINT `collaboration_updates_sequence_check`
		CHECK (typeof(`generation`) = 'integer' and `generation` between 1 and 9007199254740991
			and typeof(`seq`) = 'integer' and `seq` between 1 and 9007199254740991),
	CONSTRAINT `collaboration_updates_checksum_check`
		CHECK (length(`checksum`) = 64 and `checksum` not glob '*[^0-9a-f]*'),
	CONSTRAINT `collaboration_updates_origin_check`
		CHECK (`origin_kind` in ('client', 'proposal_command', 'undo_command', 'migration', 'repair'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `collaboration_updates_document_generation_idempotency_unique`
ON `collaboration_updates` (`workspace_id`, `document_id`, `generation`, `idempotency_key`);
--> statement-breakpoint
CREATE TABLE `collaboration_authorization_epochs` (
	`workspace_id` text NOT NULL,
	`principal_id` text NOT NULL,
	`epoch` integer NOT NULL,
	`updated_at` integer NOT NULL,
	CONSTRAINT `collaboration_authorization_epochs_pk` PRIMARY KEY (`workspace_id`, `principal_id`),
	CONSTRAINT `collaboration_authorization_epochs_epoch_check`
		CHECK (typeof(`epoch`) = 'integer' and `epoch` between 0 and 9007199254740991)
);
--> statement-breakpoint
CREATE TABLE `document_approvals` (
	`id` text PRIMARY KEY NOT NULL,
	`workspace_id` text NOT NULL,
	`document_id` text NOT NULL,
	`generation` integer NOT NULL,
	`approved_head_seq` integer NOT NULL,
	`approved_state_vector` blob NOT NULL,
	`approved_content_hash` text NOT NULL,
	`principal_id` text NOT NULL,
	`request_id` text NOT NULL,
	`approved_at` integer NOT NULL,
	`invalidated_seq` integer,
	`invalidated_principal_id` text,
	`invalidated_at` integer,
	CONSTRAINT `document_approvals_document_generation_fk`
		FOREIGN KEY (`workspace_id`, `document_id`, `generation`)
		REFERENCES `collaboration_documents` (`workspace_id`, `document_id`, `generation`) ON DELETE cascade,
	CONSTRAINT `document_approvals_sequence_check`
		CHECK (typeof(`generation`) = 'integer' and `generation` between 1 and 9007199254740991
			and typeof(`approved_head_seq`) = 'integer'
			and `approved_head_seq` between 0 and 9007199254740991),
	CONSTRAINT `document_approvals_content_hash_check`
		CHECK (length(`approved_content_hash`) = 64 and `approved_content_hash` not glob '*[^0-9a-f]*'),
	CONSTRAINT `document_approvals_invalidation_check`
		CHECK ((`invalidated_seq` is null and `invalidated_principal_id` is null and `invalidated_at` is null)
			or (`invalidated_seq` is not null and `invalidated_principal_id` is not null
				and `invalidated_at` is not null
				and typeof(`invalidated_seq`) = 'integer'
				and `invalidated_seq` between 1 and 9007199254740991
				and `invalidated_seq` > `approved_head_seq`))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `document_approvals_active_document_unique`
ON `document_approvals` (`workspace_id`, `document_id`) WHERE `invalidated_at` is null;
--> statement-breakpoint
CREATE INDEX `document_approvals_workspace_document_generation_approved_id_idx`
ON `document_approvals` (`workspace_id`, `document_id`, `generation`, `approved_at`, `id`);
--> statement-breakpoint
CREATE TABLE `collaboration_proposal_anchors` (
	`workspace_id` text NOT NULL,
	`proposal_id` text NOT NULL,
	`document_id` text NOT NULL,
	`generation` integer NOT NULL,
	`schema_fingerprint` text NOT NULL,
	`base_head_seq` integer NOT NULL,
	`base_state_vector` blob NOT NULL,
	`start_relative` blob NOT NULL,
	`start_assoc` integer NOT NULL,
	`end_relative` blob NOT NULL,
	`end_assoc` integer NOT NULL,
	`target_hash` text NOT NULL,
	`target_preview` text NOT NULL,
	`created_at` integer NOT NULL,
	CONSTRAINT `collaboration_proposal_anchors_pk` PRIMARY KEY (`workspace_id`, `proposal_id`),
	CONSTRAINT `collaboration_proposal_anchors_document_generation_fk`
		FOREIGN KEY (`workspace_id`, `document_id`, `generation`)
		REFERENCES `collaboration_documents` (`workspace_id`, `document_id`, `generation`) ON DELETE cascade,
	CONSTRAINT `collaboration_proposal_anchors_proposal_fk`
		FOREIGN KEY (`workspace_id`, `proposal_id`, `document_id`)
		REFERENCES `ai_proposals` (`workspace_id`, `id`, `document_id`) ON DELETE cascade,
	CONSTRAINT `collaboration_proposal_anchors_sequence_check`
		CHECK (typeof(`generation`) = 'integer' and `generation` between 1 and 9007199254740991
			and typeof(`base_head_seq`) = 'integer'
			and `base_head_seq` between 0 and 9007199254740991),
	CONSTRAINT `collaboration_proposal_anchors_schema_fingerprint_check`
		CHECK (length(`schema_fingerprint`) = 64 and `schema_fingerprint` not glob '*[^0-9a-f]*'),
	CONSTRAINT `collaboration_proposal_anchors_target_hash_check`
		CHECK (length(`target_hash`) = 64 and `target_hash` not glob '*[^0-9a-f]*'),
	CONSTRAINT `collaboration_proposal_anchors_association_check`
		CHECK (`start_assoc` = -1 and `end_assoc` = 1)
);
--> statement-breakpoint
CREATE TABLE `collaboration_document_changes` (
	`workspace_id` text NOT NULL,
	`change_id` text NOT NULL,
	`document_id` text NOT NULL,
	`generation` integer NOT NULL,
	`action_id` text NOT NULL,
	`forward_seq` integer NOT NULL,
	`inverse_update` blob NOT NULL,
	`affected_start_relative` blob NOT NULL,
	`affected_end_relative` blob NOT NULL,
	`postcondition_fingerprint` text NOT NULL,
	`base_head_seq` integer NOT NULL,
	`resulting_head_seq` integer NOT NULL,
	CONSTRAINT `collaboration_document_changes_pk` PRIMARY KEY (`workspace_id`, `change_id`),
	CONSTRAINT `collaboration_document_changes_document_generation_fk`
		FOREIGN KEY (`workspace_id`, `document_id`, `generation`)
		REFERENCES `collaboration_documents` (`workspace_id`, `document_id`, `generation`) ON DELETE cascade,
	CONSTRAINT `collaboration_document_changes_change_fk`
		FOREIGN KEY (`workspace_id`, `change_id`, `document_id`)
		REFERENCES `document_changes` (`workspace_id`, `id`, `document_id`) ON DELETE cascade,
	CONSTRAINT `collaboration_document_changes_action_fk`
		FOREIGN KEY (`workspace_id`, `action_id`, `document_id`, `generation`)
		REFERENCES `collaboration_actions` (`workspace_id`, `id`, `document_id`, `generation`),
	CONSTRAINT `collaboration_document_changes_sequence_check`
		CHECK (typeof(`generation`) = 'integer' and `generation` between 1 and 9007199254740991
			and typeof(`base_head_seq`) = 'integer' and `base_head_seq` between 0 and 9007199254740991
			and typeof(`forward_seq`) = 'integer' and `forward_seq` between 1 and 9007199254740991
			and typeof(`resulting_head_seq`) = 'integer'
			and `resulting_head_seq` between 1 and 9007199254740991
			and `forward_seq` > `base_head_seq`
			and `resulting_head_seq` >= `forward_seq`),
	CONSTRAINT `collaboration_document_changes_postcondition_check`
		CHECK (length(`postcondition_fingerprint`) = 64
			and `postcondition_fingerprint` not glob '*[^0-9a-f]*')
);
--> statement-breakpoint
CREATE UNIQUE INDEX `collaboration_document_changes_workspace_action_unique`
ON `collaboration_document_changes` (`workspace_id`, `action_id`);
--> statement-breakpoint
CREATE TABLE `collaboration_ai_run_snapshots` (
	`workspace_id` text NOT NULL,
	`ai_run_id` text NOT NULL,
	`document_id` text NOT NULL,
	`generation` integer NOT NULL,
	`head_seq` integer NOT NULL,
	`state_vector` blob NOT NULL,
	`schema_fingerprint` text NOT NULL,
	`content_hash` text NOT NULL,
	`created_at` integer NOT NULL,
	CONSTRAINT `collaboration_ai_run_snapshots_pk` PRIMARY KEY (`workspace_id`, `ai_run_id`),
	CONSTRAINT `collaboration_ai_run_snapshots_document_generation_fk`
		FOREIGN KEY (`workspace_id`, `document_id`, `generation`)
		REFERENCES `collaboration_documents` (`workspace_id`, `document_id`, `generation`) ON DELETE cascade,
	CONSTRAINT `collaboration_ai_run_snapshots_ai_run_fk`
		FOREIGN KEY (`workspace_id`, `ai_run_id`, `document_id`)
		REFERENCES `ai_runs` (`workspace_id`, `id`, `document_id`) ON DELETE cascade,
	CONSTRAINT `collaboration_ai_run_snapshots_sequence_check`
		CHECK (typeof(`generation`) = 'integer' and `generation` between 1 and 9007199254740991
			and typeof(`head_seq`) = 'integer' and `head_seq` between 0 and 9007199254740991),
	CONSTRAINT `collaboration_ai_run_snapshots_schema_fingerprint_check`
		CHECK (length(`schema_fingerprint`) = 64 and `schema_fingerprint` not glob '*[^0-9a-f]*'),
	CONSTRAINT `collaboration_ai_run_snapshots_content_hash_check`
		CHECK (length(`content_hash`) = 64 and `content_hash` not glob '*[^0-9a-f]*')
);
