const inheritedToolEnvironmentNames = [
  "CI",
  "COMSPEC",
  "GITHUB_ACTIONS",
  "HOME",
  "LANG",
  "LC_ALL",
  "PATH",
  "PATHEXT",
  "PNPM_HOME",
  "Path",
  "RUNNER_ARCH",
  "RUNNER_OS",
  "RUNNER_TEMP",
  "RUNNER_TOOL_CACHE",
  "SYSTEMROOT",
  "SystemRoot",
  "TEMP",
  "TMP",
  "TMPDIR",
  "USERPROFILE",
] as const;

const inheritedCleanupWorkerEnvironmentNames = [
  "COMSPEC",
  "SYSTEMROOT",
  "SystemRoot",
  "TEMP",
  "TMP",
  "TMPDIR",
] as const;

function pickEnvironment(
  baseEnvironment: NodeJS.ProcessEnv,
  names: readonly string[],
): NodeJS.ProcessEnv {
  const environment = {} as NodeJS.ProcessEnv;
  for (const name of names) {
    const value = baseEnvironment[name];
    if (value !== undefined) environment[name] = value;
  }
  return environment;
}

export function createToolEnvironment(
  baseEnvironment: NodeJS.ProcessEnv,
): NodeJS.ProcessEnv {
  return pickEnvironment(baseEnvironment, inheritedToolEnvironmentNames);
}

export function createCleanupWorkerEnvironment(
  baseEnvironment: NodeJS.ProcessEnv,
): NodeJS.ProcessEnv {
  return pickEnvironment(
    baseEnvironment,
    inheritedCleanupWorkerEnvironmentNames,
  );
}
