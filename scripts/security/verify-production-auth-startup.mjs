import { spawn } from "node:child_process";
import { createServer } from "node:net";

const pnpmCommand = process.platform === "win32" ? "pnpm.cmd" : "pnpm";
const clerkConfigurationError = "Clerk authentication is not configured";
const startupTimeoutMilliseconds = 20_000;

function run(command, args, options) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, options);

    child.once("error", reject);
    child.once("exit", (code, signal) => resolve({ code, signal }));
  });
}

async function buildProductionApplication() {
  const result = await run(pnpmCommand, ["exec", "next", "build"], {
    env: {
      ...process.env,
      AUTH_MODE: "clerk",
      CLERK_SECRET_KEY: "sk_test_startup_verification",
      NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY:
        "pk_test_Y2xlcmsuZXhhbXBsZS5jb20k",
      NODE_ENV: "production",
    },
    stdio: "inherit",
  });

  if (result.code !== 0) {
    throw new Error(
      `Production build failed with code ${String(result.code)} and signal ${String(result.signal)}`,
    );
  }
}

function reserveAvailablePort() {
  return new Promise((resolve, reject) => {
    const server = createServer();

    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();

      if (!address || typeof address === "string") {
        server.close();
        reject(new Error("Could not reserve a verification port"));
        return;
      }

      server.close((error) => {
        if (error) {
          reject(error);
          return;
        }

        resolve(address.port);
      });
    });
  });
}

async function verifyInvalidProductionStartupFails() {
  const port = await reserveAvailablePort();
  const invalidEnvironment = {
    ...process.env,
    AUTH_MODE: "clerk",
    CLERK_SECRET_KEY: "",
    NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY: "",
    NODE_ENV: "production",
    HOSTNAME: "127.0.0.1",
    PORT: String(port),
  };

  await new Promise((resolve, reject) => {
    const child = spawn(pnpmCommand, ["start"], {
      env: invalidEnvironment,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let output = "";
    let reportedReady = false;
    let timedOut = false;

    const collectOutput = (chunk) => {
      const text = chunk.toString();
      output += text;
      process.stdout.write(text);

      if (/\bReady in\b/i.test(output)) {
        reportedReady = true;
        child.kill("SIGTERM");
      }
    };

    child.stdout.on("data", collectOutput);
    child.stderr.on("data", collectOutput);

    const timeout = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
    }, startupTimeoutMilliseconds);

    child.once("error", (error) => {
      clearTimeout(timeout);
      reject(error);
    });

    child.once("exit", (code, signal) => {
      clearTimeout(timeout);

      if (timedOut) {
        reject(new Error("Invalid production server did not exit before timeout"));
        return;
      }

      if (reportedReady) {
        reject(new Error("Invalid production server reported readiness"));
        return;
      }

      if (code === 0) {
        reject(new Error("Invalid production server exited successfully"));
        return;
      }

      if (!output.includes(clerkConfigurationError)) {
        reject(
          new Error(
            `Production server failed without the expected auth error (code ${String(code)}, signal ${String(signal)})`,
          ),
        );
        return;
      }

      resolve();
    });
  });
}

await buildProductionApplication();
await verifyInvalidProductionStartupFails();

console.log(
  "Verified invalid production auth exits nonzero before server readiness.",
);
