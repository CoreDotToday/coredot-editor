export type CollaborationRoomIdentity = {
  documentId: string;
  generation: number;
  workspaceId: string;
};

const ROOM_PREFIX = "collab:v1";
const ROOM_ERROR = "Invalid collaboration room name";
const MAX_IDENTIFIER_CODE_UNITS = 256;
const MAX_ENCODED_IDENTIFIER_LENGTH = 3_072;
const MAX_ROOM_NAME_LENGTH = 6_200;
const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f-\u009f]/;

export function createCollaborationRoomName(identity: CollaborationRoomIdentity): string {
  assertGeneration(identity.generation);
  const workspaceId = encodeIdentifier(identity.workspaceId);
  const documentId = encodeIdentifier(identity.documentId);
  return `${ROOM_PREFIX}:${workspaceId}:${documentId}:g${identity.generation}`;
}

export function parseCollaborationRoomName(roomName: string): CollaborationRoomIdentity {
  if (roomName.length > MAX_ROOM_NAME_LENGTH || CONTROL_CHARACTERS.test(roomName)) {
    throw new Error(ROOM_ERROR);
  }
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
  if (
    value.length === 0
    || value.length > MAX_IDENTIFIER_CODE_UNITS
    || value.trim().length === 0
    || CONTROL_CHARACTERS.test(value)
  ) {
    throw new Error(ROOM_ERROR);
  }
  const encoded = encodeURIComponent(value);
  if (encoded.length > MAX_ENCODED_IDENTIFIER_LENGTH) throw new Error(ROOM_ERROR);
  return encoded;
}

function decodeCanonicalIdentifier(value: string) {
  if (value.length > MAX_ENCODED_IDENTIFIER_LENGTH || CONTROL_CHARACTERS.test(value)) {
    throw new Error(ROOM_ERROR);
  }
  let decoded: string;
  try {
    decoded = decodeURIComponent(value);
  } catch {
    throw new Error(ROOM_ERROR);
  }
  if (
    decoded.length === 0
    || decoded.length > MAX_IDENTIFIER_CODE_UNITS
    || decoded.trim().length === 0
    || CONTROL_CHARACTERS.test(decoded)
    || encodeURIComponent(decoded) !== value
  ) {
    throw new Error(ROOM_ERROR);
  }
  return decoded;
}
