export type CollaborationRoomIdentity = {
  documentId: string;
  generation: number;
  workspaceId: string;
};

const ROOM_PREFIX = "collab:v1";
const ROOM_ERROR = "Invalid collaboration room name";

export function createCollaborationRoomName(identity: CollaborationRoomIdentity): string {
  assertGeneration(identity.generation);
  const workspaceId = encodeIdentifier(identity.workspaceId);
  const documentId = encodeIdentifier(identity.documentId);
  return `${ROOM_PREFIX}:${workspaceId}:${documentId}:g${identity.generation}`;
}

export function parseCollaborationRoomName(roomName: string): CollaborationRoomIdentity {
  const parts = roomName.split(":");
  if (parts.length !== 5 || parts[0] !== "collab" || parts[1] !== "v1") {
    throw new Error(ROOM_ERROR);
  }

  const generationSegment = parts[4]!;
  if (!/^g[1-9]\d*$/.test(generationSegment)) throw new Error(ROOM_ERROR);
  const generation = Number(generationSegment.slice(1));
  if (!Number.isSafeInteger(generation)) throw new Error(ROOM_ERROR);

  return {
    documentId: decodeCanonicalIdentifier(parts[3]!),
    generation,
    workspaceId: decodeCanonicalIdentifier(parts[2]!),
  };
}

function assertGeneration(generation: number) {
  if (!Number.isSafeInteger(generation) || generation <= 0) {
    throw new Error("Invalid collaboration room generation");
  }
}

function encodeIdentifier(value: string) {
  if (value.length === 0 || value.trim().length === 0) throw new Error(ROOM_ERROR);
  return encodeURIComponent(value);
}

function decodeCanonicalIdentifier(value: string) {
  let decoded: string;
  try {
    decoded = decodeURIComponent(value);
  } catch {
    throw new Error(ROOM_ERROR);
  }
  if (decoded.length === 0 || decoded.trim().length === 0 || encodeURIComponent(decoded) !== value) {
    throw new Error(ROOM_ERROR);
  }
  return decoded;
}
