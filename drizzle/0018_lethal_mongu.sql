CREATE TABLE `collaboration_workflow_notification_jobs` (
	`workspace_id` text NOT NULL,
	`document_id` text NOT NULL,
	`generation` integer NOT NULL,
	`workflow_revision` integer NOT NULL,
	`status` text DEFAULT 'pending' NOT NULL,
	`attempts` integer DEFAULT 0 NOT NULL,
	`next_attempt_at` integer,
	`failure_category` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	PRIMARY KEY(`workspace_id`, `document_id`),
	FOREIGN KEY (`workspace_id`,`document_id`,`generation`) REFERENCES `collaboration_documents`(`workspace_id`,`document_id`,`generation`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "collaboration_workflow_notification_jobs_version_check" CHECK(typeof("collaboration_workflow_notification_jobs"."generation") = 'integer'
        and "collaboration_workflow_notification_jobs"."generation" between 1 and 9007199254740991
        and typeof("collaboration_workflow_notification_jobs"."workflow_revision") = 'integer'
        and "collaboration_workflow_notification_jobs"."workflow_revision" between 1 and 9007199254740991),
	CONSTRAINT "collaboration_workflow_notification_jobs_retry_state_check" CHECK((
          "collaboration_workflow_notification_jobs"."status" = 'pending'
          and typeof("collaboration_workflow_notification_jobs"."attempts") = 'integer'
          and "collaboration_workflow_notification_jobs"."attempts" between 0 and 4
          and typeof("collaboration_workflow_notification_jobs"."next_attempt_at") = 'integer'
          and "collaboration_workflow_notification_jobs"."next_attempt_at" >= "collaboration_workflow_notification_jobs"."created_at"
          and (
            ("collaboration_workflow_notification_jobs"."attempts" = 0 and "collaboration_workflow_notification_jobs"."failure_category" is null)
            or ("collaboration_workflow_notification_jobs"."attempts" > 0 and "collaboration_workflow_notification_jobs"."failure_category" = 'delivery_failed')
          )
        ) or (
          "collaboration_workflow_notification_jobs"."status" = 'exhausted'
          and "collaboration_workflow_notification_jobs"."attempts" = 5
          and "collaboration_workflow_notification_jobs"."next_attempt_at" is null
          and "collaboration_workflow_notification_jobs"."failure_category" = 'delivery_failed'
        )),
	CONSTRAINT "collaboration_workflow_notification_jobs_timestamps_check" CHECK(typeof("collaboration_workflow_notification_jobs"."created_at") = 'integer'
        and typeof("collaboration_workflow_notification_jobs"."updated_at") = 'integer'
        and "collaboration_workflow_notification_jobs"."updated_at" >= "collaboration_workflow_notification_jobs"."created_at")
);
--> statement-breakpoint
CREATE INDEX `collaboration_workflow_notification_jobs_due_idx` ON `collaboration_workflow_notification_jobs` (`status`,`next_attempt_at`,`created_at`,`workspace_id`,`document_id`,`generation`);