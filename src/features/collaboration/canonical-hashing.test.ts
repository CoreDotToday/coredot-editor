import { createHash } from "node:crypto";

import { describe, expect, it } from "vitest";

import { canonicalJson, hashCanonicalJson } from "./canonical-hashing";

describe("canonical hashing", () => {
  it("orders object keys by code units independently of runtime locale", () => {
    expect(canonicalJson({ a: 2, B: 1 })).toBe('{"B":1,"a":2}');
    expect(canonicalJson({ b: 1, a: { d: 4, c: 3 } })).toBe('{"a":{"c":3,"d":4},"b":1}');
  });

  it("matches plain JSON for primitives and arrays", () => {
    expect(canonicalJson(null)).toBe("null");
    expect(canonicalJson(true)).toBe("true");
    expect(canonicalJson("text")).toBe('"text"');
    expect(canonicalJson([1, "two", null])).toBe('[1,"two",null]');
  });

  it("drops undefined object values the way JSON serialization does", () => {
    expect(canonicalJson({ kept: 1, skipped: undefined })).toBe('{"kept":1}');
  });

  it("rejects non-finite numbers and unsupported values", () => {
    expect(() => canonicalJson(Number.POSITIVE_INFINITY)).toThrow(TypeError);
    expect(() => canonicalJson({ value: Number.NaN })).toThrow(TypeError);
    expect(() => canonicalJson(() => undefined)).toThrow(TypeError);
    expect(() => canonicalJson(undefined)).toThrow(TypeError);
  });

  it("hashes the canonical form with SHA-256", () => {
    const expected = createHash("sha256").update('{"B":1,"a":2}', "utf8").digest("hex");
    expect(hashCanonicalJson({ a: 2, B: 1 })).toBe(expected);
  });
});
