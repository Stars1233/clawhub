/* @vitest-environment node */
import { spawnSync } from "node:child_process";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  buildSkillRepoIndex,
  extractSlugFromSkillUrl,
  fetchSkillTesterSummaries,
  loadSkillTesterSnapshotFromRaw,
  parseSkillTesterName,
  resolveArtifactForRecord,
  type SkillTesterDetail,
} from "./build-skilltester-clawhub-corpus";

const tempDirs: string[] = [];

async function makeTempDir(prefix: string) {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

function runGit(cwd: string, args: string[]) {
  const result = spawnSync("git", args, {
    cwd,
    encoding: "utf8",
  });
  if (result.status !== 0) {
    throw new Error(result.stderr || result.stdout || `git ${args.join(" ")} failed`);
  }
  return result.stdout.trim();
}

async function writeRepoFile(repo: string, path: string, content: string) {
  const fullPath = join(repo, path);
  await mkdir(dirname(fullPath), { recursive: true });
  await writeFile(fullPath, content, "utf8");
}

function commitAll(repo: string, message: string) {
  runGit(repo, ["add", "."]);
  runGit(repo, ["commit", "-m", message]);
  return runGit(repo, ["rev-parse", "HEAD"]);
}

function readFixtureSkillMd(repo: string) {
  return (commit: string, skillDir: string) => {
    const content = runGit(repo, ["show", `${commit}:${skillDir}/SKILL.md`]);
    return { path: `${skillDir}/SKILL.md`, content: `${content}\n` };
  };
}

async function createSkillsRepoFixture() {
  const repo = await makeTempDir("clawhub-corpus-skills-");
  runGit(repo, ["init"]);
  runGit(repo, ["config", "user.email", "tests@example.com"]);
  runGit(repo, ["config", "user.name", "Tests"]);

  await writeRepoFile(repo, "skills/acme/demo/SKILL.md", "version one\n");
  await writeRepoFile(
    repo,
    "skills/acme/demo/_meta.json",
    JSON.stringify({ owner: "acme", slug: "demo", latest: { version: "1.0.0" } }, null, 2),
  );
  const versionOneCommit = commitAll(repo, "demo v1");

  await writeRepoFile(repo, "skills/acme/demo/SKILL.md", "version two\n");
  await writeRepoFile(
    repo,
    "skills/acme/demo/_meta.json",
    JSON.stringify({ owner: "acme", slug: "demo", latest: { version: "2.0.0" } }, null, 2),
  );
  const versionTwoCommit = commitAll(repo, "demo v2");

  await writeRepoFile(
    repo,
    "skills/acme/demo/_meta.json",
    JSON.stringify(
      {
        owner: "acme",
        slug: "demo",
        displayName: "Demo",
        latest: {
          version: "2.0.0",
          publishedAt: 2000,
          commit: `https://github.com/openclaw/skills/commit/${versionTwoCommit}`,
        },
        history: [
          {
            version: "1.0.0",
            publishedAt: 1000,
            commit: `https://github.com/openclaw/skills/commit/${versionOneCommit}`,
          },
        ],
      },
      null,
      2,
    ),
  );
  commitAll(repo, "record version commits");

  return { repo, versionOneCommit, versionTwoCommit };
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("SkillTester ClawHub corpus builder helpers", () => {
  it("parses SkillTester skill names with SemVer suffixes", () => {
    expect(parseSkillTesterName("ui-ux-pro-max-0.1.0")).toEqual({
      slug: "ui-ux-pro-max",
      version: "0.1.0",
    });
    expect(parseSkillTesterName("demo-1.2.3-beta.1")).toEqual({
      slug: "demo",
      version: "1.2.3-beta.1",
    });
    expect(parseSkillTesterName("demo")).toBeNull();
  });

  it("extracts slugs from SkillTester ClawHub URLs", () => {
    expect(extractSlugFromSkillUrl("https://clawhub.ai/skills/byterover")).toBe("byterover");
    expect(extractSlugFromSkillUrl("https://clawhub.ai/acme/demo")).toBe("demo");
    expect(extractSlugFromSkillUrl("demo")).toBe("demo");
  });

  it("reads historical SKILL.md content from the exact version commit", async () => {
    const { repo, versionOneCommit } = await createSkillsRepoFixture();
    const repoIndex = buildSkillRepoIndex(repo);
    const detail: SkillTesterDetail = {
      skill: {
        skill_url: "https://clawhub.ai/skills/demo",
      },
    };

    const artifact = resolveArtifactForRecord({
      repoDir: repo,
      repoIndex,
      repoHead: runGit(repo, ["rev-parse", "HEAD"]),
      summary: {
        skill_name: "demo-1.0.0",
      },
      detail,
      readSkillMd: readFixtureSkillMd(repo),
    });

    expect(artifact.contentStatus).toBe("fetched");
    if (artifact.contentStatus !== "fetched") return;
    expect(artifact.commit).toBe(versionOneCommit);
    expect(artifact.skillPath).toBe("skills/acme/demo/SKILL.md");
    expect(artifact.skillMdContent).toBe("version one\n");
    expect(artifact.owner).toBe("acme");
    expect(artifact.slug).toBe("demo");
    expect(artifact.version).toBe("1.0.0");
  });

  it("keeps unresolved exact-version content as a missing row", async () => {
    const { repo } = await createSkillsRepoFixture();
    const repoIndex = buildSkillRepoIndex(repo);

    const artifact = resolveArtifactForRecord({
      repoDir: repo,
      repoIndex,
      repoHead: runGit(repo, ["rev-parse", "HEAD"]),
      summary: {
        skill_name: "demo-3.0.0",
      },
      detail: {
        skill: {
          skill_url: "https://clawhub.ai/skills/demo",
        },
      },
    });

    expect(artifact.contentStatus).toBe("missing");
    if (artifact.contentStatus !== "missing") return;
    expect(artifact.missingReason).toContain("exact SkillTester version");
    expect(artifact.version).toBe("3.0.0");
  });

  it("paginates SkillTester summary rows and honors limits", async () => {
    const requestedUrls: string[] = [];
    const fetchImpl = async (input: string | URL) => {
      const url = input.toString();
      requestedUrls.push(url);
      const page = new URL(url).searchParams.get("page");
      const payload =
        page === "1"
          ? { items: [{ skill_name: "one-1.0.0" }, { skill_name: "two-1.0.0" }], has_next: true }
          : { items: [{ skill_name: "three-1.0.0" }], has_next: false };
      return {
        ok: true,
        status: 200,
        statusText: "OK",
        text: async () => JSON.stringify(payload),
      };
    };

    const rows = await fetchSkillTesterSummaries({
      fetchImpl,
      pageSize: 2,
      limit: 3,
    });

    expect(rows.map((row) => row.skill_name)).toEqual(["one-1.0.0", "two-1.0.0", "three-1.0.0"]);
    expect(requestedUrls).toHaveLength(2);
    expect(requestedUrls[0]).toContain("source=ClawHub");
  });

  it("loads a preserved raw SkillTester snapshot without network access", async () => {
    const rawDir = await makeTempDir("clawhub-corpus-raw-");
    await writeRepoFile(
      rawDir,
      "summary-pages.jsonl",
      `${JSON.stringify({
        url: "https://skilltester.ai/api/skills?page=1",
        fetched_at: "2026-04-29T00:00:00.000Z",
        payload: {
          items: [{ skill_name: "one-1.0.0" }, { skill_name: "two-1.0.0" }],
          has_next: false,
        },
      })}\n`,
    );
    await writeRepoFile(
      rawDir,
      "details.jsonl",
      `${JSON.stringify({
        url: "https://skilltester.ai/api/skills/ClawHub/one-1.0.0",
        skill_name: "one-1.0.0",
        fetched_at: "2026-04-29T00:00:00.000Z",
        payload: { skill: { skill_url: "https://clawhub.ai/skills/one" } },
      })}\n${JSON.stringify({
        url: "https://skilltester.ai/api/skills/ClawHub/two-1.0.0",
        skill_name: "two-1.0.0",
        fetched_at: "2026-04-29T00:00:00.000Z",
        payload: { skill: { skill_url: "https://clawhub.ai/skills/two" } },
      })}\n`,
    );

    const snapshot = await loadSkillTesterSnapshotFromRaw({ rawDir, limit: 1 });

    expect(snapshot.fromRaw).toBe(true);
    expect(snapshot.summaries.map((summary) => summary.skill_name)).toEqual(["one-1.0.0"]);
    expect(snapshot.details.get("one-1.0.0")?.skill?.skill_url).toBe(
      "https://clawhub.ai/skills/one",
    );
    expect(snapshot.rawDetails).toHaveLength(1);
  });
});
