import { db } from "@/db/client";

import {
  createDocumentArchiveService,
  DocumentArchiveServiceError,
} from "./document-archive-service";

const defaultDocumentArchiveService = createDocumentArchiveService({
  database: db,
  gateway: {
    async closeArchivedRoom() {
      // Production room ownership lives in the sidecar process. The HTTP
      // process deliberately leaves the transactional outbox job pending for
      // that worker instead of pretending a no-op closed the room.
      throw new DocumentArchiveServiceError("unavailable");
    },
  },
});

export const archiveDocumentWithRoomClosure = defaultDocumentArchiveService.archive;
