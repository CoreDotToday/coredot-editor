CREATE TABLE `request_budget_buckets` (
	`workspace_id` text NOT NULL,
	`principal_id` text NOT NULL,
	`policy_id` text NOT NULL,
	`window_start` integer NOT NULL,
	`request_count` integer NOT NULL,
	`expires_at` integer NOT NULL,
	CONSTRAINT `request_budget_buckets_pk` PRIMARY KEY(`workspace_id`,`principal_id`,`policy_id`,`window_start`),
	CONSTRAINT `request_budget_buckets_request_count_check` CHECK(`request_count` > 0)
);
--> statement-breakpoint
CREATE INDEX `request_budget_buckets_expires_at_idx` ON `request_budget_buckets` (`expires_at`);
