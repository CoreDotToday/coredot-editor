export class AiRunCollaborationFenceError extends Error {
  override readonly name = "AiRunCollaborationFenceError";

  constructor() {
    super("AI run collaboration state changed");
  }
}
