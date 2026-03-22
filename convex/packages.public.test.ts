/* @vitest-environment node */

import { describe, expect, it, vi } from "vitest";
import {
  getByName,
  publishPackage,
  getVersionByName,
  insertReleaseInternal,
  listPublicPage,
  listVersions,
  searchPublic,
} from "./packages";

type WrappedHandler<TArgs, TResult> = {
  _handler: (ctx: unknown, args: TArgs) => Promise<TResult>;
};

const getByNameHandler = (
  getByName as unknown as WrappedHandler<
    { name: string; viewerUserId?: string },
    {
      package: { name: string; latestVersion: string | null };
      latestRelease: { version: string } | null;
    } | null
  >
)._handler;
const getVersionByNameHandler = (
  getVersionByName as unknown as WrappedHandler<
    { name: string; version: string; viewerUserId?: string },
    { package: { name: string }; version: { version: string } } | null
  >
)._handler;
const listPublicPageHandler = (
  listPublicPage as unknown as WrappedHandler<
    {
      family?: "skill" | "code-plugin" | "bundle-plugin";
      channel?: "official" | "community" | "private";
      isOfficial?: boolean;
      executesCode?: boolean;
      capabilityTag?: string;
      paginationOpts: { cursor: string | null; numItems: number };
    },
    { page: Array<{ name: string }>; isDone: boolean; continueCursor: string }
  >
)._handler;
const listVersionsHandler = (
  listVersions as unknown as WrappedHandler<
    {
      name: string;
      viewerUserId?: string;
      paginationOpts: { cursor: string | null; numItems: number };
    },
    { page: Array<{ version: string }>; isDone: boolean; continueCursor: string }
  >
)._handler;
const insertReleaseInternalHandler = (
  insertReleaseInternal as unknown as WrappedHandler<
    {
      userId: string;
      name: string;
      displayName: string;
      family: "skill" | "code-plugin" | "bundle-plugin";
      version: string;
      changelog: string;
      tags: string[];
      summary: string;
      files: Array<{
        path: string;
        size: number;
        storageId: string;
        sha256: string;
        contentType?: string;
      }>;
      integritySha256: string;
      sourceRepo?: string;
      runtimeId?: string;
      channel?: "official" | "community" | "private";
      compatibility?: unknown;
      capabilities?: unknown;
      verification?: unknown;
      extractedPackageJson?: unknown;
      extractedPluginManifest?: unknown;
      normalizedBundleManifest?: unknown;
      source?: unknown;
    },
    unknown
  >
)._handler;
const searchPublicHandler = (
  searchPublic as unknown as WrappedHandler<
    {
      query: string;
      limit?: number;
      family?: "skill" | "code-plugin" | "bundle-plugin";
      channel?: "official" | "community" | "private";
      isOfficial?: boolean;
      executesCode?: boolean;
      capabilityTag?: string;
    },
    Array<{ package: { name: string } }>
  >
)._handler;
const publishPackageHandler = (
  publishPackage as unknown as WrappedHandler<
    {
      userId: string;
      payload: unknown;
    },
    unknown
  >
)._handler;

function makeDigest(
  name: string,
  overrides: Partial<Record<string, unknown>> = {},
): Record<string, unknown> {
  return {
    _id: `packageSearchDigest:${name}`,
    packageId: `packages:${name}`,
    name,
    normalizedName: name,
    displayName: name,
    family: "code-plugin",
    runtimeId: null,
    channel: "community",
    isOfficial: false,
    summary: `${name} summary`,
    ownerHandle: "owner",
    createdAt: 1,
    updatedAt: 1,
    latestVersion: "1.0.0",
    capabilityTags: [],
    executesCode: false,
    verificationTier: null,
    softDeletedAt: undefined,
    ...overrides,
  };
}

function makePackageDoc(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    _id: "packages:demo",
    name: "demo-plugin",
    normalizedName: "demo-plugin",
    displayName: "Demo Plugin",
    family: "code-plugin",
    channel: "community",
    isOfficial: false,
    ownerUserId: "users:owner",
    tags: {},
    latestReleaseId: "packageReleases:demo-1",
    latestVersionSummary: { version: "1.0.0" },
    compatibility: null,
    capabilities: null,
    verification: null,
    createdAt: 1,
    updatedAt: 1,
    softDeletedAt: undefined,
    ...overrides,
  };
}

function makeReleaseDoc(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    _id: "packageReleases:demo-1",
    packageId: "packages:demo",
    version: "1.0.0",
    createdAt: 1,
    softDeletedAt: undefined,
    ...overrides,
  };
}

function makeDigestCtx(options: {
  pages?: Array<{ page: Array<Record<string, unknown>>; isDone: boolean; continueCursor: string }>;
}) {
  const pageByCursor = new Map<
    string | null,
    { page: Array<Record<string, unknown>>; isDone: boolean; continueCursor: string }
  >();
  const indexNames: string[] = [];
  let cursor: string | null = null;
  for (const page of options.pages ?? []) {
    pageByCursor.set(cursor, page);
    cursor = page.continueCursor || null;
  }
  const paginate = vi.fn(async (args: { cursor: string | null }) => {
    return (
      pageByCursor.get(args.cursor ?? null) ?? {
        page: [],
        isDone: true,
        continueCursor: "",
      }
    );
  });
  const withIndex = vi.fn((indexName: string) => {
    indexNames.push(indexName);
    return {
      order: vi.fn(() => ({
        paginate,
      })),
    };
  });

  return {
    indexNames,
    paginate,
    ctx: {
      db: {
        query: vi.fn((table: string) => {
          if (table !== "packageSearchDigest") {
            throw new Error(`Unexpected table ${table}`);
          }
          return { withIndex };
        }),
      },
    },
  };
}

function makeInsertReleaseCtx(
  existing: Record<string, unknown> | null,
  priorReleases: Array<Record<string, unknown>> = [],
) {
  const patch = vi.fn();
  const insert = vi
    .fn()
    .mockResolvedValueOnce("packageReleases:new");
  return {
    patch,
    insert,
    db: {
      get: vi.fn(async (id: string) => {
        if (id === "users:owner") return { _id: id, trustedPublisher: false };
        return null;
      }),
      query: vi.fn((table: string) => {
        if (table === "packages") {
          return {
            withIndex: vi.fn((_indexName: string) => ({
              unique: vi.fn().mockResolvedValue(existing),
            })),
          };
        }
        if (table === "packageReleases") {
          return {
            withIndex: vi.fn((indexName: string) => {
              if (indexName === "by_package") {
                return {
                  collect: vi.fn().mockResolvedValue(priorReleases),
                };
              }
              return {
                unique: vi.fn().mockResolvedValue(null),
              };
            }),
          };
        }
        throw new Error(`Unexpected table ${table}`);
      }),
      insert,
      patch,
      replace: vi.fn(),
      delete: vi.fn(),
      normalizeId: vi.fn(),
    },
  };
}

function makePackageCtx(options: {
  pkg?: Record<string, unknown> | null;
  latestRelease?: Record<string, unknown> | null;
  versionRelease?: Record<string, unknown> | null;
  versionsPage?: { page: Array<Record<string, unknown>>; isDone: boolean; continueCursor: string };
}) {
  const pkg = options.pkg ?? makePackageDoc();
  const latestRelease = options.latestRelease ?? makeReleaseDoc();
  const versionRelease = options.versionRelease ?? latestRelease;
  const versionsPage = options.versionsPage ?? {
    page: [latestRelease].filter(Boolean),
    isDone: true,
    continueCursor: "",
  };

  const releaseIndexNames: string[] = [];
  return {
    releaseIndexNames,
    ctx: {
      db: {
        get: vi.fn(async (id: string) => {
          if (pkg && id === pkg.ownerUserId) return { _id: id, handle: "owner" };
          if (pkg && id === pkg.latestReleaseId) return latestRelease;
          return null;
        }),
        query: vi.fn((table: string) => {
          if (table === "packages") {
            return {
              withIndex: vi.fn(() => ({
                unique: vi.fn().mockResolvedValue(pkg),
              })),
            };
          }
          if (table === "packageReleases") {
            const filteredVersionsPage = {
              ...versionsPage,
              page: versionsPage.page.filter((release) => release.softDeletedAt === undefined),
            };
            return {
              withIndex: vi.fn((indexName: string) => {
                releaseIndexNames.push(indexName);
                if (indexName === "by_package_active_created") {
                  return {
                    order: vi.fn(() => ({
                      paginate: vi.fn().mockResolvedValue(filteredVersionsPage),
                    })),
                  };
                }
                return {
                  unique: vi.fn().mockResolvedValue(versionRelease),
                  filter: vi.fn(() => ({
                    order: vi.fn(() => ({
                      paginate: vi.fn().mockResolvedValue(filteredVersionsPage),
                    })),
                  })),
                  order: vi.fn(() => ({
                    paginate: vi.fn().mockResolvedValue(versionsPage),
                  })),
                };
              }),
            };
          }
          throw new Error(`Unexpected table ${table}`);
        }),
      },
    },
  };
}

describe("packages public queries", () => {
  it("keeps buffered cursor items aligned across paginated public pages", async () => {
    const { ctx, paginate } = makeDigestCtx({
      pages: [
        {
          page: [
            makeDigest("alpha"),
            makeDigest("bravo"),
            makeDigest("charlie"),
            makeDigest("delta"),
          ],
          isDone: false,
          continueCursor: "cursor:1",
        },
        {
          page: [makeDigest("echo")],
          isDone: true,
          continueCursor: "",
        },
      ],
    });

    const first = await listPublicPageHandler(ctx, {
      paginationOpts: { cursor: null, numItems: 2 },
    });
    const second = await listPublicPageHandler(ctx, {
      paginationOpts: { cursor: first.continueCursor, numItems: 2 },
    });
    const third = await listPublicPageHandler(ctx, {
      paginationOpts: { cursor: second.continueCursor, numItems: 2 },
    });

    expect(first.page.map((entry) => entry.name)).toEqual(["alpha", "bravo"]);
    expect(second.page.map((entry) => entry.name)).toEqual(["charlie", "delta"]);
    expect(third.page.map((entry) => entry.name)).toEqual(["echo"]);
    expect(paginate).toHaveBeenCalledTimes(3);
  });

  it("keeps package page cursors compact even with large summaries", async () => {
    const { ctx } = makeDigestCtx({
      pages: [
        {
          page: [
            makeDigest("alpha", { summary: "a".repeat(8_000) }),
            makeDigest("bravo", { summary: "b".repeat(8_000) }),
            makeDigest("charlie", { summary: "c".repeat(8_000) }),
          ],
          isDone: false,
          continueCursor: "cursor:1",
        },
      ],
    });

    const result = await listPublicPageHandler(ctx, {
      paginationOpts: { cursor: null, numItems: 1 },
    });

    expect(result.page.map((entry) => entry.name)).toEqual(["alpha"]);
    expect(result.continueCursor.length).toBeLessThan(512);
    expect(result.continueCursor).not.toContain("aaaaaaaa");
    expect(result.continueCursor).not.toContain("bravo summary");
  });

  it("excludes private packages from public list pages", async () => {
    const { ctx } = makeDigestCtx({
      pages: [
        {
          page: [
            makeDigest("secret-plugin", { channel: "private" }),
            makeDigest("public-plugin"),
          ],
          isDone: true,
          continueCursor: "",
        },
      ],
    });

    const result = await listPublicPageHandler(ctx, {
      paginationOpts: { cursor: null, numItems: 10 },
    });

    expect(result.page.map((entry) => entry.name)).toEqual(["public-plugin"]);
  });

  it("applies isOfficial filtering even with family and channel set", async () => {
    const { ctx } = makeDigestCtx({
      pages: [
        {
          page: [
            makeDigest("official-demo", {
              family: "code-plugin",
              channel: "community",
              isOfficial: true,
            }),
            makeDigest("community-demo", {
              family: "code-plugin",
              channel: "community",
              isOfficial: false,
            }),
          ],
          isDone: true,
          continueCursor: "",
        },
      ],
    });

    const result = await listPublicPageHandler(ctx, {
      family: "code-plugin",
      channel: "community",
      isOfficial: true,
      paginationOpts: { cursor: null, numItems: 10 },
    });

    expect(result.page.map((entry) => entry.name)).toEqual(["official-demo"]);
  });

  it("keeps scanning official-only listings without a family filter", async () => {
    const { ctx } = makeDigestCtx({
      pages: [
        {
          page: [makeDigest("noise-1", { isOfficial: false })],
          isDone: false,
          continueCursor: "cursor:1",
        },
        {
          page: [makeDigest("noise-2", { isOfficial: false })],
          isDone: false,
          continueCursor: "cursor:2",
        },
        {
          page: [makeDigest("noise-3", { isOfficial: false })],
          isDone: false,
          continueCursor: "cursor:3",
        },
        {
          page: [makeDigest("noise-4", { isOfficial: false })],
          isDone: false,
          continueCursor: "cursor:4",
        },
        {
          page: [makeDigest("noise-5", { isOfficial: false })],
          isDone: false,
          continueCursor: "cursor:5",
        },
        {
          page: [makeDigest("official-late", { isOfficial: true, updatedAt: 10 })],
          isDone: true,
          continueCursor: "",
        },
      ],
    });

    const result = await listPublicPageHandler(ctx, {
      isOfficial: true,
      paginationOpts: { cursor: null, numItems: 1 },
    });

    expect(result.page.map((entry) => entry.name)).toEqual(["official-late"]);
  });

  it("filters private packages and capability flags in public search", async () => {
    const { ctx } = makeDigestCtx({
      pages: [
        {
          page: [
            makeDigest("secret-tools", {
              channel: "private",
              executesCode: true,
              capabilityTags: ["tools"],
            }),
            makeDigest("bundle-demo", {
              family: "bundle-plugin",
              executesCode: false,
              capabilityTags: [],
            }),
            makeDigest("tools-demo", {
              executesCode: true,
              capabilityTags: ["tools"],
            }),
          ],
          isDone: true,
          continueCursor: "",
        },
      ],
    });

    const result = await searchPublicHandler(ctx, {
      query: "demo",
      executesCode: true,
      capabilityTag: "tools",
      limit: 10,
    });

    expect(result.map((entry) => entry.package.name)).toEqual(["tools-demo"]);
  });

  it("keeps searching beyond the first digest page", async () => {
    const olderMatch = makeDigest("demo-plugin", {
      updatedAt: 10,
    });
    const { ctx } = makeDigestCtx({
      pages: [
        {
          page: Array.from({ length: 200 }, (_, index) =>
            makeDigest(`noise-${index}`, { updatedAt: 5_000 - index }),
          ),
          isDone: false,
          continueCursor: "cursor:1",
        },
        {
          page: [olderMatch],
          isDone: true,
          continueCursor: "",
        },
      ],
    });

    const result = await searchPublicHandler(ctx, {
      query: "demo-plugin",
      limit: 10,
    });

    expect(result.map((entry) => entry.package.name)).toContain("demo-plugin");
  });

  it("caps public list scans below the Convex read limit budget", async () => {
    const { ctx, paginate } = makeDigestCtx({
      pages: Array.from({ length: 120 }, (_, index) => ({
        page: [makeDigest(`noise-${index}`, { executesCode: false })],
        isDone: false,
        continueCursor: `cursor:${index + 1}`,
      })),
    });

    const result = await listPublicPageHandler(ctx, {
      executesCode: true,
      paginationOpts: { cursor: null, numItems: 100 },
    });

    expect(result.page).toEqual([]);
    expect(paginate).toHaveBeenCalledTimes(100);
  });

  it("caps public search scans below the Convex read limit budget", async () => {
    const { ctx, paginate } = makeDigestCtx({
      pages: Array.from({ length: 170 }, (_, index) => ({
        page: [makeDigest(`noise-${index}`, { executesCode: false, updatedAt: 10_000 - index })],
        isDone: false,
        continueCursor: `cursor:${index + 1}`,
      })),
    });

    const result = await searchPublicHandler(ctx, {
      query: "demo",
      executesCode: true,
      limit: 100,
    });

    expect(result).toEqual([]);
    expect(paginate).toHaveBeenCalledTimes(150);
  });

  it("uses the official index for no-family official search filters", async () => {
    const { ctx, indexNames } = makeDigestCtx({
      pages: [
        {
          page: [makeDigest("official-demo", { isOfficial: true })],
          isDone: true,
          continueCursor: "",
        },
      ],
    });

    const result = await searchPublicHandler(ctx, {
      query: "official",
      isOfficial: true,
      limit: 10,
    });

    expect(result.map((entry) => entry.package.name)).toEqual(["official-demo"]);
    expect(indexNames).toEqual(["by_active_official_updated"]);
  });

  it("uses the channel index for no-family channel search filters", async () => {
    const { ctx, indexNames } = makeDigestCtx({
      pages: [
        {
          page: [makeDigest("community-demo", { channel: "community" })],
          isDone: true,
          continueCursor: "",
        },
      ],
    });

    const result = await searchPublicHandler(ctx, {
      query: "community",
      channel: "community",
      limit: 10,
    });

    expect(result.map((entry) => entry.package.name)).toEqual(["community-demo"]);
    expect(indexNames).toEqual(["by_active_channel_updated"]);
  });

  it("uses the combined channel and official index when both filters are set", async () => {
    const { ctx, indexNames } = makeDigestCtx({
      pages: [
        {
          page: [
            makeDigest("official-community-demo", {
              channel: "community",
              isOfficial: true,
            }),
          ],
          isDone: true,
          continueCursor: "",
        },
      ],
    });

    const result = await searchPublicHandler(ctx, {
      query: "official-community",
      channel: "community",
      isOfficial: true,
      limit: 10,
    });

    expect(result.map((entry) => entry.package.name)).toEqual(["official-community-demo"]);
    expect(indexNames).toEqual(["by_active_channel_official_updated"]);
  });

  it("blocks anonymous reads of private packages", async () => {
    const { ctx } = makePackageCtx({
      pkg: makePackageDoc({ channel: "private" }),
    });

    await expect(
      getByNameHandler(ctx, { name: "demo-plugin" }),
    ).resolves.toBeNull();
    await expect(
      listVersionsHandler(ctx, {
        name: "demo-plugin",
        paginationOpts: { cursor: null, numItems: 10 },
      }),
    ).resolves.toEqual({
      page: [],
      isDone: true,
      continueCursor: "",
    });
    await expect(
      getVersionByNameHandler(ctx, { name: "demo-plugin", version: "1.0.0" }),
    ).resolves.toBeNull();
  });

  it("allows owners to read their private packages", async () => {
    const { ctx } = makePackageCtx({
      pkg: makePackageDoc({ channel: "private" }),
    });

    const detail = await getByNameHandler(ctx, {
      name: "demo-plugin",
      viewerUserId: "users:owner",
    });
    const version = await getVersionByNameHandler(ctx, {
      name: "demo-plugin",
      version: "1.0.0",
      viewerUserId: "users:owner",
    });

    expect(detail?.package.name).toBe("demo-plugin");
    expect(version?.version.version).toBe("1.0.0");
  });

  it("does not expose a soft-deleted latest release as latestVersion", async () => {
    const { ctx } = makePackageCtx({
      latestRelease: makeReleaseDoc({ softDeletedAt: 10 }),
    });

    const result = await getByNameHandler(ctx, {
      name: "demo-plugin",
    });

    expect(result?.package.latestVersion).toBeNull();
    expect(result?.latestRelease).toBeNull();
  });

  it("hides soft-deleted releases from public version lists", async () => {
    const { ctx, releaseIndexNames } = makePackageCtx({
      versionsPage: {
        page: [
          makeReleaseDoc({ version: "1.1.0", softDeletedAt: 10 }),
          makeReleaseDoc({ _id: "packageReleases:demo-2", version: "1.0.0" }),
        ],
        isDone: true,
        continueCursor: "",
      },
    });

    const result = await listVersionsHandler(ctx, {
      name: "demo-plugin",
      paginationOpts: { cursor: null, numItems: 10 },
    });

    expect(result.page.map((entry) => entry.version)).toEqual(["1.0.0"]);
    expect(releaseIndexNames).toContain("by_package_active_created");
  });

  it("rejects family changes on an existing package name", async () => {
    const ctx = makeInsertReleaseCtx(makePackageDoc({ family: "bundle-plugin" }));

    await expect(
      insertReleaseInternalHandler(ctx, {
        userId: "users:owner",
        name: "demo-plugin",
        displayName: "Demo Plugin",
        family: "code-plugin",
        version: "1.0.0",
        changelog: "init",
        tags: ["latest"],
        summary: "demo",
        files: [],
        integritySha256: "abc123",
      }),
    ).rejects.toThrow("family changes are not allowed");
  });

  it("promotes existing packages to official when publisher becomes trusted", async () => {
    const ctx = makeInsertReleaseCtx(
      makePackageDoc({
        channel: "community",
        isOfficial: false,
        stats: { downloads: 0, installs: 0, stars: 0, versions: 1 },
      }),
    );
    ctx.db.get.mockImplementation(async (id: string) => {
      if (id === "users:owner") return { _id: id, trustedPublisher: true };
      return null;
    });

    await insertReleaseInternalHandler(ctx, {
      userId: "users:owner",
      name: "demo-plugin",
      displayName: "Demo Plugin",
      family: "code-plugin",
      version: "1.1.0",
      changelog: "promote",
      tags: ["latest"],
      summary: "demo",
      files: [],
      integritySha256: "abc123",
      capabilities: { capabilityTags: ["tools"], executesCode: true },
    });

    expect(ctx.patch).toHaveBeenCalledWith(
      "packages:demo",
      expect.objectContaining({
        channel: "official",
        isOfficial: true,
      }),
    );
  });

  it("does not overwrite capability search fields for non-latest releases", async () => {
    const ctx = makeInsertReleaseCtx(
      makePackageDoc({
        capabilityTags: ["channel:chat"],
        executesCode: true,
        tags: { latest: "packageReleases:demo-1" },
        latestReleaseId: "packageReleases:demo-1",
        stats: { downloads: 0, installs: 0, stars: 0, versions: 1 },
      }),
    );

    await insertReleaseInternalHandler(ctx, {
      userId: "users:owner",
      name: "demo-plugin",
      displayName: "Demo Plugin",
      family: "code-plugin",
      version: "0.9.9",
      changelog: "branch patch",
      tags: ["legacy"],
      summary: "demo",
      files: [],
      integritySha256: "abc123",
      capabilities: { capabilityTags: ["legacy"], executesCode: false },
    });

    expect(ctx.patch).toHaveBeenCalledWith(
      "packages:demo",
      expect.objectContaining({
        capabilityTags: ["channel:chat"],
        executesCode: true,
      }),
    );
  });

  it("keeps package summary pinned to the promoted release for non-latest publishes", async () => {
    const ctx = makeInsertReleaseCtx(
      makePackageDoc({
        summary: "latest summary",
        tags: { latest: "packageReleases:demo-1" },
        latestReleaseId: "packageReleases:demo-1",
        stats: { downloads: 0, installs: 0, stars: 0, versions: 1 },
      }),
    );

    await insertReleaseInternalHandler(ctx, {
      userId: "users:owner",
      name: "demo-plugin",
      displayName: "Demo Plugin",
      family: "code-plugin",
      version: "0.9.9",
      changelog: "branch patch",
      tags: ["legacy"],
      summary: "legacy branch summary",
      files: [],
      integritySha256: "abc123",
    });

    expect(ctx.patch).toHaveBeenCalledWith(
      "packages:demo",
      expect.objectContaining({
        summary: "latest summary",
      }),
    );
  });

  it("removes moved dist-tags from older package releases", async () => {
    const olderRelease = makeReleaseDoc({
      _id: "packageReleases:old",
      version: "1.0.0",
      distTags: ["latest", "stable"],
    });
    const ctx = makeInsertReleaseCtx(
      makePackageDoc({
        tags: { latest: "packageReleases:old", stable: "packageReleases:old" },
        latestReleaseId: "packageReleases:old",
        stats: { downloads: 0, installs: 0, stars: 0, versions: 1 },
      }),
      [olderRelease],
    );

    await insertReleaseInternalHandler(ctx, {
      userId: "users:owner",
      name: "demo-plugin",
      displayName: "Demo Plugin",
      family: "code-plugin",
      version: "1.1.0",
      changelog: "promote",
      tags: ["latest"],
      summary: "demo",
      files: [],
      integritySha256: "abc123",
    });

    expect(ctx.patch).toHaveBeenCalledWith("packageReleases:old", {
      distTags: ["stable"],
    });
  });

  it("validates package publish payloads inside the action path", async () => {
    await expect(
      publishPackageHandler({} as never, {
        userId: "users:owner",
        payload: {
          name: "demo-plugin",
          family: "bundle-plugin",
          version: "1.0.0",
          changelog: "init",
          bundle: { hostTargets: ["desktop"] },
          files: "invalid",
        },
      }),
    ).rejects.toThrow(/Package publish payload/i);
  });
});
