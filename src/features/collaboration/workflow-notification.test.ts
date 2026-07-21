import { describe, expect, it } from "vitest";

import {
  COLLABORATION_WORKFLOW_CHANGED_PAYLOAD,
  isCollaborationWorkflowChangedPayload,
} from "./workflow-notification";

describe("collaboration workflow notification", () => {
  it("accepts only the exact bounded server-owned payload", () => {
    expect(isCollaborationWorkflowChangedPayload(COLLABORATION_WORKFLOW_CHANGED_PAYLOAD)).toBe(true);
    expect(Buffer.byteLength(COLLABORATION_WORKFLOW_CHANGED_PAYLOAD, "utf8")).toBeLessThanOrEqual(64);
    expect(isCollaborationWorkflowChangedPayload('{"v":1,"type":"workflow_changed","readiness":"approved"}')).toBe(false);
    expect(isCollaborationWorkflowChangedPayload('{"type":"workflow_changed","v":1,"extra":true}')).toBe(false);
    expect(isCollaborationWorkflowChangedPayload("x".repeat(65))).toBe(false);
  });
});
