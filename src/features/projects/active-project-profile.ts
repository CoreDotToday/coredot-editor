import "server-only";

import { getProjectProfile } from "./default-project-profiles";

type ProjectProfileEnvironment = {
  PROJECT_PROFILE_ID?: string;
};

export function resolveActiveProjectProfile(
  environment: ProjectProfileEnvironment = { PROJECT_PROFILE_ID: process.env.PROJECT_PROFILE_ID },
) {
  return getProjectProfile(environment.PROJECT_PROFILE_ID?.trim() || "default");
}
