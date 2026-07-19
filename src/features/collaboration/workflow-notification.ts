export const COLLABORATION_WORKFLOW_CHANGED_PAYLOAD = '{"type":"workflow_changed","v":1}';

const MAX_WORKFLOW_NOTIFICATION_BYTES = 64;

export function isCollaborationWorkflowChangedPayload(payload: unknown): payload is string {
  return typeof payload === "string"
    && payload.length <= MAX_WORKFLOW_NOTIFICATION_BYTES
    && payload === COLLABORATION_WORKFLOW_CHANGED_PAYLOAD;
}
