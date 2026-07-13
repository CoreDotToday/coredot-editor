ALTER TABLE `documents`
ADD COLUMN `revision` integer DEFAULT 0 NOT NULL
CONSTRAINT `documents_revision_check` CHECK (`revision` >= 0);
