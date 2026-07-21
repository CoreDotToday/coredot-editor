import "server-only";

import { db } from "@/db/client";
import { createCollaborationDocumentCodec } from "@/features/collaboration/document-codec";
import { createCollaborationPersistence } from "@/features/collaboration/persistence";
import { resolveActiveProjectProfile } from "@/features/projects/active-project-profile";

const projectProfile = resolveActiveProjectProfile();
export const aiCollaborationCodec = createCollaborationDocumentCodec(projectProfile);
const persistence = createCollaborationPersistence(db, { codec: aiCollaborationCodec, projectProfile });

export const loadAiCollaborationSnapshot = persistence.load;
