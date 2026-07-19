CREATE TABLE `collaboration_room_closure_jobs` (
	`workspace_id` text NOT NULL,
	`document_id` text NOT NULL,
	`generation` integer NOT NULL,
	`reason` text NOT NULL,
	`status` text DEFAULT 'pending' NOT NULL,
	`attempts` integer DEFAULT 0 NOT NULL,
	`next_attempt_at` integer,
	`failure_category` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	PRIMARY KEY(`workspace_id`, `document_id`, `generation`, `reason`),
	FOREIGN KEY (`workspace_id`,`document_id`,`generation`) REFERENCES `collaboration_documents`(`workspace_id`,`document_id`,`generation`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "collaboration_room_closure_jobs_generation_check" CHECK(typeof("collaboration_room_closure_jobs"."generation") = 'integer' and "collaboration_room_closure_jobs"."generation" between 1 and 9007199254740991),
	CONSTRAINT "collaboration_room_closure_jobs_reason_check" CHECK("collaboration_room_closure_jobs"."reason" = 'archived'),
	CONSTRAINT "collaboration_room_closure_jobs_retry_state_check" CHECK((
          "collaboration_room_closure_jobs"."status" = 'pending'
          and typeof("collaboration_room_closure_jobs"."attempts") = 'integer'
          and "collaboration_room_closure_jobs"."attempts" between 0 and 4
          and typeof("collaboration_room_closure_jobs"."next_attempt_at") = 'integer'
          and "collaboration_room_closure_jobs"."next_attempt_at" >= "collaboration_room_closure_jobs"."created_at"
          and (
            ("collaboration_room_closure_jobs"."attempts" = 0 and "collaboration_room_closure_jobs"."failure_category" is null)
            or ("collaboration_room_closure_jobs"."attempts" > 0 and "collaboration_room_closure_jobs"."failure_category" = 'delivery_failed')
          )
        ) or (
          "collaboration_room_closure_jobs"."status" = 'exhausted'
          and "collaboration_room_closure_jobs"."attempts" = 5
          and "collaboration_room_closure_jobs"."next_attempt_at" is null
          and "collaboration_room_closure_jobs"."failure_category" = 'delivery_failed'
        )),
	CONSTRAINT "collaboration_room_closure_jobs_timestamps_check" CHECK(typeof("collaboration_room_closure_jobs"."created_at") = 'integer'
        and typeof("collaboration_room_closure_jobs"."updated_at") = 'integer'
        and "collaboration_room_closure_jobs"."updated_at" >= "collaboration_room_closure_jobs"."created_at")
);
--> statement-breakpoint
CREATE INDEX `collaboration_room_closure_jobs_due_idx` ON `collaboration_room_closure_jobs` (`status`,`next_attempt_at`,`created_at`,`workspace_id`,`document_id`,`generation`);--> statement-breakpoint
PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_document_approvals` (
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
	`revoked_at` integer,
	`revoked_principal_id` text,
	`revoked_request_id` text,
	FOREIGN KEY (`workspace_id`,`document_id`,`generation`) REFERENCES `collaboration_documents`(`workspace_id`,`document_id`,`generation`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "document_approvals_sequence_check" CHECK(typeof("generation") = 'integer' and "generation" between 1 and 9007199254740991
        and typeof("approved_head_seq") = 'integer'
        and "approved_head_seq" between 0 and 9007199254740991),
	CONSTRAINT "document_approvals_content_hash_check" CHECK(typeof("approved_content_hash") = 'text'
        and length("approved_content_hash") = 64
        and "approved_content_hash" not glob '*[^0-9a-f]*'),
	CONSTRAINT "document_approvals_state_vector_check" CHECK(typeof("approved_state_vector") = 'blob'
        and length("approved_state_vector") between 1 and 1048576),
	CONSTRAINT "document_approvals_invalidation_check" CHECK(("invalidated_seq" is null and "invalidated_principal_id" is null and "invalidated_at" is null)
        or ("invalidated_seq" is not null and "invalidated_principal_id" is not null
          and "invalidated_at" is not null
          and typeof("invalidated_seq") = 'integer'
          and "invalidated_seq" between 1 and 9007199254740991
          and "invalidated_seq" > "approved_head_seq")),
	CONSTRAINT "document_approvals_revocation_check" CHECK((
          "revoked_at" is null
          and "revoked_principal_id" is null
          and "revoked_request_id" is null
        ) or (
          "revoked_at" is not null
          and typeof("revoked_at") = 'integer'
          and "revoked_at" >= "approved_at"
          and typeof("revoked_principal_id") = 'text'
          and "revoked_principal_id" = trim(
            "revoked_principal_id",
            char(9) || char(10) || char(11) || char(12) || char(13) || char(160) || ' '
          )
          and length(cast("revoked_principal_id" as blob)) between 1
            and 256
          and typeof("revoked_request_id") = 'text'
          and "revoked_request_id" = trim(
            "revoked_request_id",
            char(9) || char(10) || char(11) || char(12) || char(13) || char(160) || ' '
          )
          and length(cast("revoked_request_id" as blob)) between 1
            and 256
          and "invalidated_seq" is null
          and "invalidated_principal_id" is null
          and "invalidated_at" is null
        ))
);
--> statement-breakpoint
INSERT INTO `__new_document_approvals`("id", "workspace_id", "document_id", "generation", "approved_head_seq", "approved_state_vector", "approved_content_hash", "principal_id", "request_id", "approved_at", "invalidated_seq", "invalidated_principal_id", "invalidated_at", "revoked_at", "revoked_principal_id", "revoked_request_id") SELECT "id", "workspace_id", "document_id", "generation", "approved_head_seq", "approved_state_vector", "approved_content_hash", "principal_id", "request_id", "approved_at", "invalidated_seq", "invalidated_principal_id", "invalidated_at", NULL, NULL, NULL FROM `document_approvals`;--> statement-breakpoint
DROP TABLE `document_approvals`;--> statement-breakpoint
ALTER TABLE `__new_document_approvals` RENAME TO `document_approvals`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
CREATE UNIQUE INDEX `document_approvals_active_document_unique` ON `document_approvals` (`workspace_id`,`document_id`) WHERE `invalidated_at` is null and `revoked_at` is null;--> statement-breakpoint
CREATE INDEX `document_approvals_workspace_document_generation_approved_id_idx` ON `document_approvals` (`workspace_id`,`document_id`,`generation`,`approved_at`,`id`);
