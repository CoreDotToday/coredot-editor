import { execFile } from "node:child_process";
import { EventEmitter } from "node:events";
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as linkCheckerModule from "./check-links";

const dnsMocks = vi.hoisted(() => ({
  lookup: vi.fn(),
}));
const transportMocks = vi.hoisted(() => ({
  httpRequest: vi.fn(),
  httpsRequest: vi.fn(),
}));

vi.mock("node:dns/promises", () => ({
  default: { lookup: dnsMocks.lookup },
  lookup: dnsMocks.lookup,
}));
vi.mock("node:http", () => ({
  default: { request: transportMocks.httpRequest },
  request: transportMocks.httpRequest,
}));
vi.mock("node:https", () => ({
  default: { request: transportMocks.httpsRequest },
  request: transportMocks.httpsRequest,
}));

import {
  checkExternalLinks,
  checkInternalLinks,
  extractMarkdownLinks,
  normalizeHeadingAnchor,
} from "./check-links";

type NativeRequestOptions = {
  headers?: Record<string, string>;
  lookup?: (
    hostname: string,
    options: { all?: boolean },
    callback: (error: Error | null, address: string | Array<{ address: string; family: number }>, family?: number) => void,
  ) => void;
  method?: string;
  servername?: string;
};

type NativeResponse = {
  location?: string;
  status: number;
};

function installNativeTransport(
  handler: (url: URL, options: NativeRequestOptions) => NativeResponse | undefined | Promise<NativeResponse | undefined>,
) {
  const responseBodyReads: Array<ReturnType<typeof vi.fn>> = [];
  const responseDestroys: Array<ReturnType<typeof vi.fn>> = [];
  const requestImplementation = (
    input: string | URL,
    options: NativeRequestOptions,
    onResponse: (response: EventEmitter & {
      destroy: () => void;
      headers: Record<string, string | undefined>;
      read: () => string;
      statusCode: number;
    }) => void,
  ) => {
    const request = new EventEmitter() as EventEmitter & {
      destroy: (error?: Error) => void;
      end: () => void;
    };
    request.destroy = vi.fn((error?: Error) => {
      if (error) {
        queueMicrotask(() => request.emit("error", error));
      }
    });
    request.end = vi.fn(() => {
      queueMicrotask(async () => {
        try {
          const result = await handler(new URL(String(input)), options);
          if (!result) {
            return;
          }
          const response = new EventEmitter() as EventEmitter & {
            destroy: () => void;
            headers: Record<string, string | undefined>;
            read: () => string;
            statusCode: number;
          };
          const destroy = vi.fn();
          const read = vi.fn(() => "private response body");
          response.destroy = destroy;
          response.headers = { location: result.location };
          response.read = read;
          response.statusCode = result.status;
          responseBodyReads.push(read);
          responseDestroys.push(destroy);
          onResponse(response);
        } catch (error) {
          request.emit("error", error);
        }
      });
    });
    return request;
  };
  transportMocks.httpRequest.mockImplementation(requestImplementation);
  transportMocks.httpsRequest.mockImplementation(requestImplementation);
  return { responseBodyReads, responseDestroys };
}

const execFileAsync = promisify(execFile);
const cliScript = resolve(import.meta.dirname, "check-links.ts");
const tsxCommand = resolve(import.meta.dirname, "../../node_modules/.bin/tsx");

async function runExecutableCli(root: string, argv: string[]) {
  try {
    const { stderr, stdout } = await execFileAsync(tsxCommand, [cliScript, ...argv], {
      cwd: root,
      maxBuffer: 64 * 1024,
      timeout: 10_000,
    });
    return { exitCode: 0, stderr, stdout };
  } catch (error) {
    const failure = error as Error & {
      code?: number | string;
      stderr?: string;
      stdout?: string;
    };
    return {
      exitCode: typeof failure.code === "number" ? failure.code : 1,
      stderr: failure.stderr ?? "",
      stdout: failure.stdout ?? "",
    };
  }
}

async function withTemporaryRepository(
  files: Record<string, string>,
  run: (root: string) => Promise<void>,
) {
  const root = await mkdtemp(join(tmpdir(), "coredot-doc-links-"));

  try {
    for (const [file, contents] of Object.entries(files)) {
      const path = join(root, file);
      await mkdir(dirname(path), { recursive: true });
      await writeFile(path, contents, "utf8");
    }
    await run(root);
  } finally {
    await rm(root, { force: true, recursive: true });
  }
}

describe("documentation link extraction", () => {
  it("extracts inline, reference, image, raw HTTPS, and fragment-only links", () => {
    const markdown = `
# Local section

[Inline](docs/guide.md#install)
[Reference][guide]
[![Linked image](assets/logo.png)](docs/product-tour.md)
<https://example.com/angle>
Raw: https://example.com/raw.
[Same page](#local-section)

[guide]: docs/reference.md "Reference title"
`;

    expect(extractMarkdownLinks(markdown)).toEqual(expect.arrayContaining([
      "docs/guide.md#install",
      "docs/reference.md",
      "assets/logo.png",
      "docs/product-tour.md",
      "https://example.com/angle",
      "https://example.com/raw",
      "#local-section",
    ]));
  });

  it("extracts raw HTML anchor and image links without treating comments as content", () => {
    const markdown = `
<a class="path" href="docs/guide/">Guide</a>
<img alt="Diagram" src='assets/diagram.svg'>
<a href=docs/reference/>Reference</a>
<!-- <a href="docs/commented.md">Commented</a> -->
`;

    expect(extractMarkdownLinks(markdown)).toEqual([
      "docs/guide/",
      "assets/diagram.svg",
      "docs/reference/",
    ]);
  });

  it("ignores mail, telephone, and fenced-code examples", () => {
    const markdown = `
[Mail](mailto:maintainers@example.com)
[Call](tel:+12025550123)

\`\`\`markdown
[Not real](docs/missing.md)
https://private.example/secret
\`\`\`

~~~text
[Also not real](#missing)
~~~
`;

    expect(extractMarkdownLinks(markdown)).toEqual([]);
  });

  it("matches rendered Markdown for escapes, comments, indented code, angle syntax, and entities", () => {
    const markdown = `
\\[Escaped](https://escaped.example/private)
<!--
[Commented](docs/commented.md)
https://commented.example/private
-->
    [Four spaces](docs/indented.md)
\t[Tabbed](docs/tabbed.md)
[Malformed angle](<https://malformed.example/private> trailing)
[Encoded](docs/A&amp;B.md?first=1&amp;second=2)
`;

    expect(extractMarkdownLinks(markdown)).toEqual([
      "docs/A&B.md?first=1&second=2",
    ]);
  });

  it("keeps rendered list continuations while ignoring true indented code", () => {
    const markdown = `
- First item
- Second item
    [Rendered](docs/rendered.md)

Paragraph

    [Indented code](docs/code.md)
`;

    expect(extractMarkdownLinks(markdown)).toEqual(["docs/rendered.md"]);
  });

  it("removes inline code before recognizing HTML comments", () => {
    const markdown = "`<!--` [Rendered](docs/rendered.md)";

    expect(extractMarkdownLinks(markdown)).toEqual(["docs/rendered.md"]);
  });

  it("rejects angle destinations that contain a newline", () => {
    const markdown = "[Invalid](<docs/foo\nbar.md>)\n[Valid](docs/valid.md)";

    expect(extractMarkdownLinks(markdown)).toEqual(["docs/valid.md"]);
  });

  it("does not treat thematic breaks as list containers for indented code", () => {
    const markdown = `
- - -
    [Dash code](docs/dash-code.md)

* * *
    [Star code](docs/star-code.md)
`;

    expect(extractMarkdownLinks(markdown)).toEqual([]);
  });

  it("follows rendered behavior for mismatched backtick runs", () => {
    const markdown = "` [Rendered](docs/rendered.md) ``";

    expect(extractMarkdownLinks(markdown)).toEqual(["docs/rendered.md"]);
  });

  it("rejects inline destinations with trailing tokens", () => {
    const markdown = `
[Invalid](docs/missing.md trailing)
[Invalid title](docs/missing.md "Title" trailing)
[Valid](docs/valid.md "Title")
`;

    expect(extractMarkdownLinks(markdown)).toEqual(["docs/valid.md"]);
  });
});

describe("internal documentation links", () => {
  it("normalizes MkDocs-compatible heading anchors", () => {
    expect(normalizeHeadingAnchor("  API: Create & Update `Documents`!  ")).toBe(
      "api-create-update-documents",
    );
    expect(normalizeHeadingAnchor("Café crème")).toBe("cafe-creme");
    expect(normalizeHeadingAnchor("한국어 설정")).toBe("");
  });

  it("resolves files, directory indexes, encoded paths, and page anchors", async () => {
    await withTemporaryRepository({
      "README.md": `
# Overview

[Same page](#overview)
[Directory](docs/guide/#install)
[Duplicate](docs/guide/#install_1)
[Duplicate collision](docs/guide/#install_2)
[Encoded](docs/My%20File.md#encoded-section)
[Cross page](docs/reference.md#cross-page)
[GitHub root](/docs/reference.md#cross-page)
`,
      "docs/guide/index.md": "# Install\n\n# Install_1\n\n# Install\n",
      "docs/My File.md": "# Encoded Section\n",
      "docs/reference.md": "# Cross Page\n",
    }, async (root) => {
      await expect(checkInternalLinks(root, [
        "README.md",
        "docs/guide/index.md",
        "docs/My File.md",
        "docs/reference.md",
      ])).resolves.toEqual([]);
    });
  });

  it("maps MkDocs clean URLs to sibling Markdown source files", async () => {
    await withTemporaryRepository({
      "docs/index.md": '<a href="guide/#install">Guide</a>\n',
      "docs/guide.md": "# Install\n",
    }, async (root) => {
      await expect(checkInternalLinks(root, ["docs/index.md", "docs/guide.md"]))
        .resolves.toEqual([]);
    });
  });

  it("does not apply the MkDocs clean URL fallback to README Markdown links", async () => {
    await withTemporaryRepository({
      "README.md": "[Guide](docs/guide/)\n",
      "docs/guide.md": "# Guide\n",
    }, async (root) => {
      await expect(checkInternalLinks(root, ["README.md", "docs/guide.md"]))
        .resolves.toEqual([{
          file: "README.md",
          href: "docs/guide/",
          message: "Missing file: docs/guide",
        }]);
    });
  });

  it("resolves raw HTML assets from the rendered MkDocs page directory", async () => {
    await withTemporaryRepository({
      "docs/product-tour.md": `
<a href="../assets/full.svg">
  <img src="../assets/preview.svg" alt="Preview">
</a>
`,
      "docs/assets/full.svg": "<svg></svg>\n",
      "docs/assets/preview.svg": "<svg></svg>\n",
    }, async (root) => {
      await expect(checkInternalLinks(root, ["docs/product-tour.md"]))
        .resolves.toEqual([]);
    });
  });

  it("checks identical Markdown and raw HTML hrefs with independent provenance", async () => {
    const source = `
[Markdown](guide.md)
<img src="guide.md" alt="Raw HTML">
`;

    await withTemporaryRepository({
      "docs/source.md": source,
      "docs/source/guide.md": "# Raw target\n",
    }, async (root) => {
      await expect(checkInternalLinks(root, ["docs/source.md"]))
        .resolves.toEqual([{
          file: "docs/source.md",
          href: "guide.md",
          message: "Missing file: docs/guide.md",
        }]);
    });

    await withTemporaryRepository({
      "docs/source.md": source,
      "docs/guide.md": "# Markdown target\n",
    }, async (root) => {
      await expect(checkInternalLinks(root, ["docs/source.md"]))
        .resolves.toEqual([{
          file: "docs/source.md",
          href: "guide.md",
          message: "Missing file: docs/source/guide.md",
        }]);
    });
  });

  it("rejects local .md destinations in raw HTML anchors under docs", async () => {
    await withTemporaryRepository({
      "docs/source.md": '<a href="guide.md">Guide</a>\n',
      "docs/guide.md": "# Guide\n",
    }, async (root) => {
      await expect(checkInternalLinks(root, ["docs/source.md", "docs/guide.md"]))
        .resolves.toEqual([{
          file: "docs/source.md",
          href: "guide.md",
          message: "Raw HTML local .md links are not rewritten by MkDocs; use the rendered clean URL",
        }]);
    });
  });

  it("reports missing files and anchors with repository-relative source paths", async () => {
    await withTemporaryRepository({
      "docs/source.md": `
[Missing relative](missing.md)
[Missing root](/docs/also-missing.md)
[Missing anchor](target.md#not-there)
`,
      "docs/target.md": "# Present\n",
    }, async (root) => {
      const issues = await checkInternalLinks(root, ["docs/source.md", "docs/target.md"]);

      expect(issues).toEqual(expect.arrayContaining([
        {
          file: "docs/source.md",
          href: "missing.md",
          message: "Missing file: docs/missing.md",
        },
        {
          file: "docs/source.md",
          href: "/docs/also-missing.md",
          message: "Missing file: docs/also-missing.md",
        },
        {
          file: "docs/source.md",
          href: "target.md#not-there",
          message: 'Missing anchor "#not-there" in docs/target.md',
        },
      ]));
      expect(issues).toHaveLength(3);
    });
  });

  it("rejects file and directory symlinks that resolve outside the repository", async () => {
    const outside = await mkdtemp(join(tmpdir(), "coredot-doc-links-outside-"));
    try {
      await writeFile(join(outside, "outside.md"), "# Outside file\n", "utf8");
      await mkdir(join(outside, "guide"), { recursive: true });
      await writeFile(join(outside, "guide/index.md"), "# Outside directory\n", "utf8");

      await withTemporaryRepository({
        "docs/source.md": `
[File escape](outside.md#outside-file)
[Directory escape](outside-guide/#outside-directory)
`,
      }, async (root) => {
        await symlink(join(outside, "outside.md"), join(root, "docs/outside.md"), "file");
        await symlink(join(outside, "guide"), join(root, "docs/outside-guide"), "dir");

        await expect(checkInternalLinks(root, ["docs/source.md"])).resolves.toEqual([
          {
            file: "docs/source.md",
            href: "outside.md#outside-file",
            message: "Link target leaves repository root",
          },
          {
            file: "docs/source.md",
            href: "outside-guide/#outside-directory",
            message: "Link target leaves repository root",
          },
        ]);
      });
    } finally {
      await rm(outside, { force: true, recursive: true });
    }
  });
});

describe("external documentation links", () => {
  beforeEach(() => {
    dnsMocks.lookup.mockReset();
    dnsMocks.lookup.mockResolvedValue([{ address: "93.184.216.34", family: 4 }]);
    transportMocks.httpRequest.mockReset();
    transportMocks.httpsRequest.mockReset();
    vi.stubGlobal("fetch", vi.fn(async () => {
      throw new Error("global fetch must not be used by the link checker");
    }));
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it("deduplicates links and caps request concurrency at four", async () => {
    let active = 0;
    let maximumActive = 0;
    const releases: Array<() => void> = [];
    installNativeTransport(async () => {
      active += 1;
      maximumActive = Math.max(maximumActive, active);
      await new Promise<void>((release) => releases.push(release));
      active -= 1;
      return { status: 204 };
    });
    const links = [
      "https://one.example/docs",
      "https://two.example/docs",
      "https://three.example/docs",
      "https://four.example/docs",
      "https://five.example/docs",
      "https://six.example/docs",
      "https://one.example/docs",
    ];

    const pending = checkExternalLinks(links, { concurrency: 99 });
    await vi.waitFor(() => expect(releases).toHaveLength(4));
    releases.splice(0).forEach((release) => release());
    await vi.waitFor(() => expect(releases).toHaveLength(2));
    releases.splice(0).forEach((release) => release());

    await expect(pending).resolves.toEqual([]);
    expect(transportMocks.httpsRequest).toHaveBeenCalledTimes(6);
    expect(maximumActive).toBe(4);
  });

  it("uses a five-second default timeout", async () => {
    vi.useFakeTimers();
    installNativeTransport(async () => new Promise<undefined>(() => undefined));

    const pending = checkExternalLinks(["https://timeout.example/docs"]);
    await Promise.resolve();
    await Promise.resolve();
    await vi.advanceTimersByTimeAsync(4_999);
    expect(transportMocks.httpsRequest).toHaveBeenCalledOnce();

    let settled = false;
    void pending.then(() => {
      settled = true;
    });
    await Promise.resolve();
    expect(settled).toBe(false);

    await vi.advanceTimersByTimeAsync(1);
    await expect(pending).resolves.toEqual([{
      file: "",
      href: "https://timeout.example/docs",
      message: "External link check failed",
    }]);
  });

  it("uses HEAD with GET fallback and follows validated redirects", async () => {
    const requests: Array<[
      string,
      string | undefined,
      Record<string, string> | undefined,
    ]> = [];
    const transport = installNativeTransport(async (url, options) => {
      requests.push([String(url), options.method, options.headers]);
      if (String(url) === "https://redirect.example/start") {
        return { location: "https://final.example/docs", status: 302 };
      }
      if (String(url) === "https://final.example/docs" && options.method === "HEAD") {
        return { status: 405 };
      }
      if (String(url) === "https://final.example/docs" && options.method === "GET") {
        return { status: 200 };
      }
      throw new Error("unexpected request");
    });

    await expect(checkExternalLinks([
      "https://redirect.example/start",
    ])).resolves.toEqual([]);
    expect(requests).toEqual([
      ["https://redirect.example/start", "HEAD", undefined],
      ["https://final.example/docs", "HEAD", undefined],
      ["https://final.example/docs", "GET", undefined],
    ]);
    expect(transport.responseBodyReads).toHaveLength(3);
    expect(transport.responseDestroys).toHaveLength(3);
    expect(transport.responseBodyReads.every((read) => read.mock.calls.length === 0)).toBe(true);
    expect(transport.responseDestroys.every((destroy) => destroy.mock.calls.length === 1)).toBe(true);
  });

  it("falls back to GET when HEAD fails before receiving a response", async () => {
    const methods: Array<string | undefined> = [];
    installNativeTransport(async (_url, options) => {
      methods.push(options.method);
      if (options.method === "HEAD") {
        throw new Error("HEAD transport failed");
      }
      return { status: 200 };
    });

    await expect(checkExternalLinks([
      "https://head-failure.example/docs",
    ])).resolves.toEqual([]);
    expect(methods).toEqual(["HEAD", "GET"]);
  });

  it("pins the native connection lookup to the prevalidated DNS address", async () => {
    dnsMocks.lookup.mockResolvedValue([{ address: "93.184.216.34", family: 4 }]);
    let connectedAddress: string | Array<{ address: string; family: number }> | undefined;
    let connectedFamily: number | undefined;
    let servername: string | undefined;
    installNativeTransport(async (_url, options) => {
      servername = options.servername;
      await new Promise<void>((resolveLookup, rejectLookup) => {
        if (!options.lookup) {
          rejectLookup(new Error("missing pinned lookup"));
          return;
        }
        options.lookup("pinned.example", { all: false }, (error, address, family) => {
          if (error) {
            rejectLookup(error);
            return;
          }
          connectedAddress = address;
          connectedFamily = family;
          resolveLookup();
        });
      });
      return { status: 204 };
    });

    await expect(checkExternalLinks([
      "https://pinned.example/docs",
    ])).resolves.toEqual([]);

    expect(connectedAddress).toBe("93.184.216.34");
    expect(connectedFamily).toBe(4);
    expect(servername).toBe("pinned.example");
    expect(dnsMocks.lookup).toHaveBeenCalledWith("pinned.example", {
      all: true,
      verbatim: true,
    });
  });

  it("attempts every validated DNS address within the shared deadline", async () => {
    dnsMocks.lookup.mockResolvedValue([
      { address: "93.184.216.34", family: 4 },
      { address: "93.184.216.35", family: 4 },
    ]);
    const connectedAddresses: string[] = [];
    installNativeTransport(async (_url, options) => {
      const address = await new Promise<string>((resolveLookup, rejectLookup) => {
        if (!options.lookup) {
          rejectLookup(new Error("missing pinned lookup"));
          return;
        }
        options.lookup("multi.example", { all: false }, (error, result) => {
          if (error) {
            rejectLookup(error);
            return;
          }
          if (typeof result !== "string") {
            rejectLookup(new Error("expected one pinned address"));
            return;
          }
          resolveLookup(result);
        });
      });
      connectedAddresses.push(address);
      if (address === "93.184.216.34") {
        throw new Error("first address is unavailable");
      }
      return { status: 204 };
    });

    await expect(checkExternalLinks([
      "https://multi.example/docs",
    ])).resolves.toEqual([]);
    expect(connectedAddresses).toEqual([
      "93.184.216.34",
      "93.184.216.35",
    ]);
    expect(transportMocks.httpsRequest).toHaveBeenCalledTimes(2);
  });

  it("reserves part of the total deadline for later validated addresses", async () => {
    vi.useFakeTimers();
    dnsMocks.lookup.mockResolvedValue([
      { address: "93.184.216.34", family: 4 },
      { address: "93.184.216.35", family: 4 },
    ]);
    const connectedAddresses: string[] = [];
    installNativeTransport(async (_url, options) => {
      const address = await new Promise<string>((resolveLookup, rejectLookup) => {
        if (!options.lookup) {
          rejectLookup(new Error("missing pinned lookup"));
          return;
        }
        options.lookup("fair.example", { all: false }, (error, result) => {
          if (error) {
            rejectLookup(error);
            return;
          }
          if (typeof result !== "string") {
            rejectLookup(new Error("expected one pinned address"));
            return;
          }
          resolveLookup(result);
        });
      });
      connectedAddresses.push(address);
      return address === "93.184.216.34"
        ? new Promise<undefined>(() => undefined)
        : { status: 204 };
    });

    const pending = checkExternalLinks(
      ["https://fair.example/docs"],
      { timeoutMs: 1_000 },
    );
    await vi.advanceTimersByTimeAsync(0);
    expect(connectedAddresses).toEqual(["93.184.216.34"]);

    await vi.advanceTimersByTimeAsync(500);
    expect(connectedAddresses).toEqual([
      "93.184.216.34",
      "93.184.216.35",
    ]);
    await expect(pending).resolves.toEqual([]);
    expect(transportMocks.httpsRequest).toHaveBeenCalledTimes(2);
    const firstRequest = transportMocks.httpsRequest.mock.results[0]?.value as {
      destroy: ReturnType<typeof vi.fn>;
    };
    expect(firstRequest.destroy).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("reports HTTP and transport failures without including response bodies", async () => {
    const transport = installNativeTransport(async (url) => {
      if (String(url).includes("missing")) {
        return { status: 404 };
      }
      throw new Error("private transport detail");
    });

    const issues = await checkExternalLinks([
      "https://example.com/missing",
      "https://example.com/failure",
    ]);

    expect(issues).toEqual([
      {
        file: "",
        href: "https://example.com/missing",
        message: "External link returned HTTP 404",
      },
      {
        file: "",
        href: "https://example.com/failure",
        message: "External link check failed",
      },
    ]);
    expect(JSON.stringify(issues)).not.toMatch(/private response body|private transport detail/);
    expect(transport.responseBodyReads).toHaveLength(2);
    expect(transport.responseDestroys).toHaveLength(2);
    expect(transport.responseBodyReads.every((read) => read.mock.calls.length === 0)).toBe(true);
    expect(transport.responseDestroys.every((destroy) => destroy.mock.calls.length === 1)).toBe(true);
  });

  it("redacts userinfo, query strings, and fragments from external issues", async () => {
    installNativeTransport(async () => ({ status: 404 }));

    const issues = await checkExternalLinks([
      "https://user:super-secret@credential.example/private?token=query-secret#fragment-secret",
      "https://query.example/missing?api_key=query-secret#fragment-secret",
    ]);

    expect(issues).toEqual([
      {
        file: "",
        href: "https://credential.example/private",
        message: "External link target is not allowed",
      },
      {
        file: "",
        href: "https://query.example/missing",
        message: "External link returned HTTP 404",
      },
    ]);
    expect(JSON.stringify(issues)).not.toMatch(
      /user|super-secret|query-secret|fragment-secret|token|api_key/,
    );
  });

  it("rejects non-HTTP, localhost, private, and reserved targets before fetching", async () => {
    dnsMocks.lookup.mockImplementation(async (hostname: string) => (
      hostname === "resolved-private.example"
        ? [{ address: "10.20.30.40", family: 4 }]
        : [{ address: "93.184.216.34", family: 4 }]
    ));
    installNativeTransport(async () => ({ status: 204 }));
    const links = [
      "ftp://example.com/file",
      "http://localhost/admin",
      "http://127.0.0.1/admin",
      "http://10.1.2.3/admin",
      "http://169.254.169.254/latest/meta-data",
      "http://192.0.2.10/docs",
      "http://[::1]/admin",
      "https://resolved-private.example/admin",
    ];

    const issues = await checkExternalLinks(links);

    expect(issues).toHaveLength(links.length);
    expect(issues.every((issue) => issue.message === "External link target is not allowed")).toBe(
      true,
    );
    expect(transportMocks.httpRequest).not.toHaveBeenCalled();
    expect(transportMocks.httpsRequest).not.toHaveBeenCalled();
  });

  it("revalidates redirect targets before following them", async () => {
    installNativeTransport(async () => ({
      location: "http://127.0.0.1/admin",
      status: 302,
    }));

    await expect(checkExternalLinks([
      "https://public.example/redirect",
    ])).resolves.toEqual([{
      file: "",
      href: "https://public.example/redirect",
      message: "External link target is not allowed",
    }]);
    expect(transportMocks.httpsRequest).toHaveBeenCalledOnce();
    expect(transportMocks.httpRequest).not.toHaveBeenCalled();
  });

  it("allows globally routable IPv6 and rejects private, reserved, and deprecated ranges", async () => {
    installNativeTransport(async () => ({ status: 204 }));
    const blocked = [
      "http://[::]/",
      "http://[::1]/",
      "http://[fc00::1]/",
      "http://[fe80::1]/",
      "http://[fec0::1]/",
      "http://[ff02::1]/",
      "http://[2001:db8::1]/",
      "http://[2002:c000:0204::1]/",
      "http://[3ffe::1]/",
      "http://[3fff::1]/",
    ];
    const publicUrl = "https://[2606:4700:4700::1111]/";

    const issues = await checkExternalLinks([...blocked, publicUrl]);

    expect(issues.map(({ href }) => href)).toEqual(blocked);
    expect(issues.every((issue) => issue.message === "External link target is not allowed")).toBe(
      true,
    );
    expect(transportMocks.httpRequest).not.toHaveBeenCalled();
    expect(transportMocks.httpsRequest).toHaveBeenCalledOnce();
  });

  it("includes DNS resolution in the five-second link deadline and clears timers", async () => {
    vi.useFakeTimers();
    dnsMocks.lookup.mockImplementation(async () => new Promise(() => undefined));
    installNativeTransport(async () => ({ status: 204 }));

    const pending = checkExternalLinks(["https://dns-timeout.example/docs"]);
    await Promise.resolve();
    await Promise.resolve();
    expect(vi.getTimerCount()).toBe(1);

    await vi.advanceTimersByTimeAsync(4_999);
    let settled = false;
    void pending.then(() => {
      settled = true;
    });
    await Promise.resolve();
    expect(settled).toBe(false);

    await vi.advanceTimersByTimeAsync(1);
    await expect(pending).resolves.toEqual([{
      file: "",
      href: "https://dns-timeout.example/docs",
      message: "External link check failed",
    }]);
    expect(transportMocks.httpsRequest).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe("documentation link CLI", () => {
  it("scans all public root files and nested docs while excluding private and generated trees", async () => {
    await withTemporaryRepository({
      "README.md": "[Missing](missing-readme.md)\n",
      "CONTRIBUTING.md": "[Missing](missing-contributing.md)\n",
      "SECURITY.md": "[Missing](missing-security.md)\n",
      "CODE_OF_CONDUCT.md": "[Missing](missing-code.md)\n",
      "docs/nested/page.md": "[Missing](missing-doc.md)\n",
      "docs/superpowers/private.md": "[Private](missing-private.md)\n",
      "site/generated.md": "[Generated](missing-generated.md)\n",
    }, async (root) => {
      const result = await runExecutableCli(root, []);
      const issueLines = result.stderr.trim().split("\n");

      expect(result.exitCode).toBe(1);
      expect(result.stdout).toBe("");
      expect(issueLines).toHaveLength(5);
      for (const file of ["README.md", "CONTRIBUTING.md", "SECURITY.md", "CODE_OF_CONDUCT.md"]) {
        expect(result.stderr).toContain(file);
      }
      expect(result.stderr).toContain("docs/nested/page.md");
      expect(result.stderr).not.toMatch(/docs\/superpowers|site\/generated/);
    });
  });

  it("fails closed when root or docs discovery encounters an I/O error", async () => {
    for (const failingPath of ["README.md", "docs"]) {
      const root = await mkdtemp(join(tmpdir(), "coredot-doc-links-io-"));
      try {
        if (failingPath === "docs") {
          await writeFile(join(root, "README.md"), "# Public documentation\n", "utf8");
        }
        await symlink(failingPath, join(root, failingPath), failingPath === "docs" ? "dir" : "file");

        const result = await runExecutableCli(root, []);

        expect(result.exitCode).toBe(1);
        expect(result.stdout).toBe("");
        expect(result.stderr).toBe("Documentation link check failed.\n");
      } finally {
        await rm(root, { force: true, recursive: true });
      }
    }
  });

  it("fails closed when docs exists but is not a directory", async () => {
    await withTemporaryRepository({
      "README.md": "# Public documentation\n",
      "docs": "not a directory\n",
    }, async (root) => {
      const result = await runExecutableCli(root, []);

      expect(result.exitCode).toBe(1);
      expect(result.stdout).toBe("");
      expect(result.stderr).toBe("Documentation link check failed.\n");
    });
  });

  it("defaults to internal checks and validates non-HTTP candidates only with external opt-in", async () => {
    await withTemporaryRepository({
      "README.md": `
[FTP](ftp://user:password@files.example/archive?token=query-secret#fragment-secret)
[Protocol relative](//user:password@cdn.example/asset?signature=query-secret#fragment-secret)
[Mail](mailto:maintainers@example.com)
[Telephone](tel:+12025550123)
`,
    }, async (root) => {
      const internalResult = await runExecutableCli(root, []);

      expect(internalResult.exitCode).toBe(0);
      expect(internalResult.stderr).toBe("");
      expect(internalResult.stdout).toBe("Documentation links are valid (internal).\n");

      const externalResult = await runExecutableCli(root, ["--external"]);
      const issueLines = externalResult.stderr.trim().split("\n");

      expect(externalResult.exitCode).toBe(1);
      expect(externalResult.stdout).toBe("");
      expect(issueLines).toHaveLength(2);
      expect(externalResult.stderr).toContain("ftp://files.example/archive");
      expect(externalResult.stderr).toContain("//cdn.example/asset");
      expect(externalResult.stderr).not.toMatch(
        /mailto:|tel:|user|password|query-secret|fragment-secret|token|signature/,
      );
    });
  });

  it("skips localhost and loopback documentation examples in external collection", async () => {
    await withTemporaryRepository({
      "README.md": `
[Localhost](http://localhost:3000)
[Localhost subdomain](https://docs.localhost/example)
[IPv4 loopback](http://127.0.0.2/example)
[IPv6 loopback](http://[::1]/example)
`,
    }, async (root) => {
      const result = await runExecutableCli(root, ["--external"]);

      expect(result.exitCode).toBe(0);
      expect(result.stderr).toBe("");
      expect(result.stdout).toBe("Documentation links are valid (external).\n");
    });
  });

  it("attributes identically redacted external failures to their raw-link source", async () => {
    await withTemporaryRepository({
      "README.md": "[First](ftp://user:first-secret@files.example/archive?token=first-secret)\n",
      "docs/source.md": "[Second](ftp://user:second-secret@files.example/archive?token=second-secret)\n",
    }, async (root) => {
      const result = await runExecutableCli(root, ["--external"]);

      expect(result.exitCode).toBe(1);
      expect(result.stdout).toBe("");
      expect(result.stderr).toBe([
        "README.md: ftp://files.example/archive - External link target is not allowed",
        "docs/source.md: ftp://files.example/archive - External link target is not allowed",
        "",
      ].join("\n"));
      expect(result.stderr).not.toMatch(/user|first-secret|second-secret|token/);
    });
  });

  it("returns one missing-fragment issue and no success output", async () => {
    await withTemporaryRepository({
      "README.md": "# Present\n\n[Missing](#not-present)\n",
    }, async (root) => {
      const result = await runExecutableCli(root, []);

      expect(result.exitCode).toBe(1);
      expect(result.stdout).toBe("");
      expect(result.stderr).toBe(
        'README.md: #not-present - Missing anchor "#not-present" in README.md\n',
      );
    });
  });
});

describe("link-check command wiring", () => {
  it("keeps the runtime export surface limited to the specified API", () => {
    expect(Object.keys(linkCheckerModule).sort()).toEqual([
      "checkExternalLinks",
      "checkInternalLinks",
      "extractMarkdownLinks",
      "normalizeHeadingAnchor",
    ]);
  });

  it("keeps package scripts, ignores, and the docs workflow aligned", async () => {
    const root = resolve(import.meta.dirname, "../..");
    const packageJson = JSON.parse(
      await readFile(join(root, "package.json"), "utf8"),
    ) as { scripts: Record<string, string> };
    const gitignore = await readFile(join(root, ".gitignore"), "utf8");
    const workflow = await readFile(join(root, ".github/workflows/docs.yml"), "utf8");
    const exampleEnvironment = await readFile(join(root, ".env.example"), "utf8");
    const docsHome = await readFile(join(root, "docs/index.md"), "utf8");

    expect(packageJson.scripts["docs:check-links"]).toBe(
      "tsx scripts/docs/check-links.ts",
    );
    expect(packageJson.scripts["docs:check-links:external"]).toBe(
      "tsx scripts/docs/check-links.ts --external",
    );
    expect(gitignore).toContain("/.superpowers/");

    for (const path of [
      "README.md",
      "CONTRIBUTING.md",
      "SECURITY.md",
      "CODE_OF_CONDUCT.md",
      "scripts/docs/**",
      "package.json",
      "pnpm-lock.yaml",
    ]) {
      expect(workflow).toContain(`- "${path}"`);
    }
    expect(workflow).toContain("uses: pnpm/action-setup@v4");
    expect(workflow).toContain('version: "10.6.5"');
    expect(workflow).toContain("uses: actions/setup-node@v4");
    expect(workflow).toContain('node-version: "20"');
    expect(workflow).toContain("cache: pnpm");
    expect(workflow).toContain("run: pnpm install --frozen-lockfile");
    expect(workflow.indexOf("run: pnpm docs:check-links")).toBeLessThan(
      workflow.indexOf("run: pnpm docs:build"),
    );
    expect(workflow).not.toContain("docs:check-links:external");
    expect(exampleEnvironment).toContain("TURSO_AUTH_TOKEN=\n");
    for (const path of [
      "product-tour/",
      "getting-started/",
      "ADOPTION/",
      "production-readiness/",
      "community/",
    ]) {
      expect(docsHome).toContain(`<a href="${path}">`);
      expect(docsHome).not.toContain(`<a href="${path.slice(0, -1)}.md">`);
    }
  });
});
