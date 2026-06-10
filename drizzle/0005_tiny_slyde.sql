PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_documents` (
	`id` text PRIMARY KEY NOT NULL,
	`title` text NOT NULL,
	`content_json` text NOT NULL,
	`plain_text` text DEFAULT '' NOT NULL,
	`status` text DEFAULT 'draft' NOT NULL,
	`readiness` text DEFAULT 'draft' NOT NULL,
	`metadata_json` text DEFAULT '{}' NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	CONSTRAINT "documents_status_check" CHECK("status" in ('draft', 'archived')),
	CONSTRAINT "documents_readiness_check" CHECK("readiness" in ('draft', 'needs_review', 'ready', 'approved'))
);
--> statement-breakpoint
INSERT INTO `__new_documents`("id", "title", "content_json", "plain_text", "status", "readiness", "metadata_json", "created_at", "updated_at") SELECT "id", "title", "content_json", "plain_text", "status", 'draft', '{}', "created_at", "updated_at" FROM `documents`;--> statement-breakpoint
DROP TABLE `documents`;--> statement-breakpoint
ALTER TABLE `__new_documents` RENAME TO `documents`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
CREATE INDEX `documents_readiness_idx` ON `documents` (`readiness`);
