CREATE TABLE `collaboration_noop_receipts` (
	`workspace_id` text NOT NULL,
	`document_id` text NOT NULL,
	`idempotency_key` text NOT NULL,
	`generation` integer NOT NULL,
	`head_seq` integer NOT NULL,
	`checksum` text NOT NULL,
	`origin_kind` text NOT NULL,
	`principal_id` text NOT NULL,
	`request_id` text,
	`session_id` text,
	`semantic_action_id` text,
	`created_at` integer NOT NULL,
	PRIMARY KEY(`workspace_id`, `document_id`, `idempotency_key`),
	FOREIGN KEY (`workspace_id`,`document_id`,`generation`) REFERENCES `collaboration_documents`(`workspace_id`,`document_id`,`generation`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`workspace_id`,`semantic_action_id`,`document_id`,`generation`) REFERENCES `collaboration_actions`(`workspace_id`,`id`,`document_id`,`generation`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "collaboration_noop_receipts_sequence_check" CHECK(typeof("generation") = 'integer' and "generation" between 1 and 9007199254740991
        and typeof("head_seq") = 'integer' and "head_seq" between 0 and 9007199254740991),
	CONSTRAINT "collaboration_noop_receipts_checksum_check" CHECK(typeof("checksum") = 'text'
        and length("checksum") = 64
        and "checksum" not glob '*[^0-9a-f]*'),
	CONSTRAINT "collaboration_noop_receipts_origin_check" CHECK("origin_kind" in ('client', 'proposal_command', 'undo_command', 'migration', 'repair')),
	CONSTRAINT "collaboration_noop_receipts_idempotency_key_check" CHECK(typeof("idempotency_key") = 'text'
        and "idempotency_key" = trim("idempotency_key", char(9) || char(10) || char(11) || char(12) || char(13) || char(160) || ' ')
        and length(cast("idempotency_key" as blob)) between 1 and 256),
	CONSTRAINT "collaboration_noop_receipts_audit_identity_check" CHECK(("principal_id" is null or (
          typeof("principal_id") = 'text'
          and "principal_id" = trim("principal_id", char(9) || char(10) || char(11) || char(12) || char(13) || char(160) || ' ')
          and length(cast("principal_id" as blob)) between 1 and 256
        )) and ("request_id" is null or (
          typeof("request_id") = 'text'
          and "request_id" = trim("request_id", char(9) || char(10) || char(11) || char(12) || char(13) || char(160) || ' ')
          and length(cast("request_id" as blob)) between 1 and 256
        )) and ("session_id" is null or (
          typeof("session_id") = 'text'
          and "session_id" = trim("session_id", char(9) || char(10) || char(11) || char(12) || char(13) || char(160) || ' ')
          and length(cast("session_id" as blob)) between 1 and 256
        )) and ("semantic_action_id" is null or (
          typeof("semantic_action_id") = 'text'
          and "semantic_action_id" = trim("semantic_action_id", char(9) || char(10) || char(11) || char(12) || char(13) || char(160) || ' ')
          and length(cast("semantic_action_id" as blob)) between 1 and 256
        )))
);
