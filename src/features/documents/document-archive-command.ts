import { db } from "@/db/client";

import { createDocumentArchiveService } from "./document-archive-service";

const defaultDocumentArchiveService = createDocumentArchiveService({
  database: db,
});

export const archiveDocumentWithRoomClosure = defaultDocumentArchiveService.archive;
