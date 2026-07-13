ALTER TABLE `documents` ADD `creation_key` text;
--> statement-breakpoint
CREATE UNIQUE INDEX `documents_workspace_creation_key_unique`
ON `documents` (`workspace_id`, `creation_key`);
