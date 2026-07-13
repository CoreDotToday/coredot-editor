import "server-only";

import { createHash } from "node:crypto";

export class InvalidCollectionCursorError extends Error {
  override readonly name = "InvalidCollectionCursorError";

  constructor() {
    super("Invalid collection cursor");
  }
}

export type CollectionCursor = { id: string; timestamp: Date };
export type CollectionCursorScope = Readonly<Record<
  string,
  boolean | null | number | string | undefined
>> & { collection: string; workspaceId: string };

export function encodeCollectionCursor(cursor: CollectionCursor, scope: CollectionCursorScope) {
  return Buffer.from(JSON.stringify({
    i: cursor.id,
    s: fingerprintScope(scope),
    t: cursor.timestamp.valueOf(),
    v: 2,
  }))
    .toString("base64url");
}

export function decodeCollectionCursor(value: string, scope: CollectionCursorScope): CollectionCursor {
  try {
    if (!value || value.length > 512 || !/^[A-Za-z0-9_-]+$/u.test(value)) throw new Error();
    const decoded = JSON.parse(Buffer.from(value, "base64url").toString("utf8")) as Record<string, unknown>;
    if (
      decoded.v !== 2 ||
      typeof decoded.i !== "string" ||
      !decoded.i ||
      decoded.i.length > 256 ||
      typeof decoded.s !== "string" ||
      decoded.s !== fingerprintScope(scope) ||
      typeof decoded.t !== "number" ||
      !Number.isSafeInteger(decoded.t)
    ) throw new Error();
    const timestamp = new Date(decoded.t);
    if (Number.isNaN(timestamp.valueOf())) throw new Error();
    return { id: decoded.i, timestamp };
  } catch {
    throw new InvalidCollectionCursorError();
  }
}

function fingerprintScope(scope: CollectionCursorScope) {
  const canonical = Object.entries(scope)
    .filter((entry): entry is [string, boolean | null | number | string] => entry[1] !== undefined)
    .sort(([left], [right]) => left.localeCompare(right));
  return createHash("sha256").update(JSON.stringify(canonical)).digest("base64url");
}
