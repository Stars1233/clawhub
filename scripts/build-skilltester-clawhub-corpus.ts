import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";

const SKILLTESTER_BASE_URL = "https://skilltester.ai";
const SKILLTESTER_SOURCE = "ClawHub";
const DEFAULT_PAGE_SIZE = 100;
const DEFAULT_OUTPUT_DIR = "eval/corpora/skilltester-clawhub";
const RAW_DIR_NAME = "raw";
const CORPUS_SCHEMA_VERSION = "1.0";
const BUILDER_VERSION = "1.1.0";

type JsonRecord = Record<string, unknown>;

export type SkillTesterSummaryItem = JsonRecord & {
  source?: string;
  skill_name?: string;
  full_name?: string;
  description?: string;
  tested?: boolean;
  score?: number;
  utility_score?: number;
  security_score?: number;
  security_level?: string;
  efficiency_score?: number | null;
  updated_at?: string;
  query_count?: number;
};

type SkillTesterSummaryResponse = {
  items?: SkillTesterSummaryItem[];
  page?: number;
  page_size?: number;
  total_pages?: number;
  has_next?: boolean;
  count?: number;
  filters?: JsonRecord;
};

export type SkillTesterDetail = {
  skill?: JsonRecord;
  result?: JsonRecord;
  computed_scores?: JsonRecord;
  variants?: unknown[];
  selected_variant_id?: string;
  selected_executor_model?: string;
  tasks_result?: JsonRecord;
};

export type SkillMetaVersion = {
  version?: string;
  publishedAt?: number;
  commit?: string | null;
};

export type SkillMeta = JsonRecord & {
  owner?: string;
  slug?: string;
  displayName?: string;
  latest?: SkillMetaVersion;
  history?: SkillMetaVersion[];
};

export type SkillRepoIndex = Map<string, string[]>;

type RunResult = {
  stdout: string;
  stderr: string;
  status: number;
};

type FetchLike = (input: string | URL) => Promise<{
  ok: boolean;
  status: number;
  statusText: string;
  text: () => Promise<string>;
}>;

export type BuildOptions = {
  outputDir: string;
  pageSize: number;
  limit?: number;
  keepTemp: boolean;
  dryRun: boolean;
  fromRawDir?: string;
  fetchImpl: FetchLike;
};

type CliOptions = Omit<BuildOptions, "fetchImpl">;

type PreparedSkillsRepo = {
  repoDir: string;
  repoHead: string;
  cleanup: () => Promise<void>;
};

export type ResolvedIdentity = {
  slug: string | null;
  version: string | null;
  candidateSlugs: string[];
};

export type ResolvedArtifact =
  | {
      contentStatus: "fetched";
      owner: string;
      slug: string;
      version: string;
      displayName?: string;
      versionPublishedAt?: number;
      commit: string;
      skillPath: string;
      skillMdContent: string;
      skillMdSha256: string;
      skillMdBytes: number;
      contentSource: "github_git_history";
    }
  | {
      contentStatus: "missing";
      owner?: string;
      slug?: string;
      version?: string;
      missingReason: string;
      candidates?: Array<{ owner: string; slug: string; path: string }>;
      contentSource: "github_git_history";
    };

type SkillMdReader = (commit: string, skillDir: string) => { path: string; content: string } | null;

export type CorpusRow = {
  schema_version: string;
  corpus: "skilltester-clawhub";
  source: "SkillTester";
  content_status: ResolvedArtifact["contentStatus"];
  resolved: {
    owner?: string;
    slug?: string;
    version?: string;
    canonical_url?: string;
  };
  artifact: {
    source_repo: "https://github.com/openclaw/skills";
    repo_head: string;
    content_source: "github_git_history";
    commit?: string;
    path?: string;
    skill_md_sha256?: string;
    skill_md_bytes?: number;
    skill_md_content?: string;
    missing_reason?: string;
    candidates?: Array<{ owner: string; slug: string; path: string }>;
  };
  skilltester: {
    summary: SkillTesterSummaryItem;
    detail_skill?: JsonRecord;
    selected_variant_id?: string;
    selected_executor_model?: string;
    scores: {
      overall?: number | null;
      utility?: number | null;
      efficiency?: number | null;
      security?: number | null;
      security_level?: string | null;
    };
    security: {
      level?: string | null;
      score?: number | null;
      summary?: string | null;
      reasoning?: string | null;
      total_tests?: number | null;
      total_passed?: number | null;
      dimensions?: unknown;
      tasks?: unknown[];
    };
    source_urls: {
      detail_api_url: string;
      skill_url?: string;
      download_url?: string;
      result_url?: string;
      report_url?: string;
      tasks_url?: string;
      scores_url?: string;
    };
    timestamps: {
      summary_updated_at?: string;
      evaluation_timestamp?: string;
    };
  };
  reference_labels: {
    source: "SkillTester";
    caveat: string;
    security_level?: string | null;
    security_score?: number | null;
    security_dimensions?: unknown;
  };
};

type BuildCounts = {
  summaryRowsFetched: number;
  detailRowsFetched: number;
  detailFetchFailed: number;
  rowsWritten: number;
  fetchedContent: number;
  missingContent: number;
  ambiguous: number;
  malformed: number;
};

type BuildManifest = {
  schema_version: string;
  corpus: "skilltester-clawhub";
  generated_at: string;
  builder: {
    script: string;
    version: string;
  };
  sources: {
    skilltester: {
      base_url: string;
      source: string;
      mode: "live_api" | "raw_snapshot";
      query: Record<string, string | number>;
      raw_snapshot?: {
        summary_pages_file: string;
        details_file: string;
      };
    };
    skills_repo: {
      url: "https://github.com/openclaw/skills";
      head: string;
      access: "gh repo clone with shallow blobless checkout plus gh api raw reads for exact SKILL.md commits";
    };
  };
  output: {
    corpus_file: string;
    raw_summary_pages_file: string;
    raw_details_file: string;
    rows: number;
  };
  counts: BuildCounts;
  gaps: Array<{
    skill_name?: string;
    owner?: string;
    slug?: string;
    version?: string;
    reason: string;
  }>;
};

type RawSummaryPageRecord = {
  url: string;
  fetched_at: string;
  payload: SkillTesterSummaryResponse;
};

type RawDetailRecord = {
  url: string;
  skill_name: string;
  fetched_at: string;
  payload: SkillTesterDetail;
};

type SkillTesterSnapshot = {
  summaries: SkillTesterSummaryItem[];
  summaryPages: RawSummaryPageRecord[];
  details: Map<string, SkillTesterDetail>;
  rawDetails: RawDetailRecord[];
  fromRaw: boolean;
};

function run(command: string, args: string[], options: { cwd?: string } = {}): RunResult {
  const result = spawnSync(command, args, {
    cwd: options.cwd,
    encoding: "utf8",
    maxBuffer: 1024 * 1024 * 200,
  });
  return {
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
    status: result.status ?? 1,
  };
}

function mustRun(command: string, args: string[], options: { cwd?: string } = {}): string {
  const result = run(command, args, options);
  if (result.status !== 0) {
    const detail = [result.stderr.trim(), result.stdout.trim()].filter(Boolean).join("\n");
    throw new Error(`${command} ${args.join(" ")} failed${detail ? `:\n${detail}` : ""}`);
  }
  return result.stdout.trim();
}

function mustRunRaw(command: string, args: string[], options: { cwd?: string } = {}): string {
  const result = run(command, args, options);
  if (result.status !== 0) {
    const detail = [result.stderr.trim(), result.stdout.trim()].filter(Boolean).join("\n");
    throw new Error(`${command} ${args.join(" ")} failed${detail ? `:\n${detail}` : ""}`);
  }
  return result.stdout;
}

function git(repoDir: string, args: string[]): string {
  return mustRun("git", ["-C", repoDir, ...args]);
}

function gitRaw(repoDir: string, args: string[]): string {
  return mustRunRaw("git", ["-C", repoDir, ...args]);
}

function parseNumber(value: string | undefined, label: string): number {
  if (!value) throw new Error(`Missing value for ${label}`);
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1) {
    throw new Error(`${label} must be a positive integer`);
  }
  return parsed;
}

function parseArgs(argv: string[]): CliOptions {
  const options: CliOptions = {
    outputDir: DEFAULT_OUTPUT_DIR,
    pageSize: DEFAULT_PAGE_SIZE,
    keepTemp: false,
    dryRun: false,
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    switch (arg) {
      case "--output-dir":
        options.outputDir = argv[++i] ?? "";
        if (!options.outputDir) throw new Error("--output-dir requires a value");
        break;
      case "--page-size":
        options.pageSize = parseNumber(argv[++i], "--page-size");
        break;
      case "--limit":
        options.limit = parseNumber(argv[++i], "--limit");
        break;
      case "--keep-temp":
        options.keepTemp = true;
        break;
      case "--dry-run":
        options.dryRun = true;
        break;
      case "--from-raw": {
        const next = argv[i + 1];
        if (next && !next.startsWith("--")) {
          options.fromRawDir = next;
          i += 1;
        } else {
          options.fromRawDir = join(options.outputDir, RAW_DIR_NAME);
        }
        break;
      }
      case "--help":
        printHelp();
        process.exit(0);
      default:
        throw new Error(`Unknown argument: ${arg}`);
    }
  }

  return options;
}

function printHelp() {
  console.log(`Usage: bun scripts/build-skilltester-clawhub-corpus.ts [options]

Options:
  --output-dir <path>  Corpus output directory (default: ${DEFAULT_OUTPUT_DIR})
  --page-size <n>      SkillTester page size (default: ${DEFAULT_PAGE_SIZE})
  --limit <n>          Limit rows for smoke builds
  --from-raw [path]    Rebuild from saved raw SkillTester JSONL instead of SkillTester API
  --keep-temp          Keep the temporary openclaw/skills clone
  --dry-run            Fetch and resolve rows without writing corpus files
  --help               Show this help
`);
}

function normalizeSlug(value: string): string {
  return (
    value
      .trim()
      .replace(/^\/+|\/+$/g, "")
      .split("/")
      .filter(Boolean)
      .at(-1) ?? value
  );
}

export function parseSkillTesterName(skillName: string): { slug: string; version: string } | null {
  const match = /^(?<slug>.+)-(?<version>\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?)$/.exec(skillName);
  if (!match?.groups) return null;
  return {
    slug: match.groups.slug,
    version: match.groups.version,
  };
}

export function extractSlugFromSkillUrl(value: unknown): string | null {
  if (typeof value !== "string" || value.trim() === "") return null;
  try {
    const url = new URL(value);
    const parts = url.pathname.split("/").filter(Boolean);
    if (parts.length === 0) return null;
    return normalizeSlug(parts.at(-1) ?? "");
  } catch {
    return normalizeSlug(value);
  }
}

export function resolveIdentity(
  summary: SkillTesterSummaryItem,
  detail: SkillTesterDetail | null,
): ResolvedIdentity {
  const detailSkill = detail?.skill ?? {};
  const name = typeof summary.skill_name === "string" ? summary.skill_name : "";
  const parsedName = parseSkillTesterName(name);
  const slugCandidates = new Set<string>();
  const detailSlug = extractSlugFromSkillUrl(detailSkill.skill_url ?? detailSkill.download_url);
  const summarySlug = parsedName?.slug ?? null;

  if (detailSlug) slugCandidates.add(detailSlug);
  if (summarySlug) slugCandidates.add(summarySlug);

  return {
    slug: detailSlug ?? summarySlug,
    version: parsedName?.version ?? null,
    candidateSlugs: Array.from(slugCandidates),
  };
}

function asRecord(value: unknown): JsonRecord | null {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as JsonRecord) : null;
}

function asNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function extractCommitHash(value: string | null | undefined): string | null {
  if (!value) return null;
  const match = /[0-9a-f]{40}/i.exec(value);
  return match?.[0] ?? null;
}

function findVersion(meta: SkillMeta, version: string): SkillMetaVersion | null {
  if (meta.latest?.version === version) return meta.latest;
  return meta.history?.find((entry) => entry.version === version) ?? null;
}

function parseMeta(raw: string): SkillMeta | null {
  try {
    return JSON.parse(raw) as SkillMeta;
  } catch {
    return null;
  }
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function byteLength(value: string): number {
  return Buffer.byteLength(value, "utf8");
}

function skillPathFromMetaPath(metaPath: string): string {
  return metaPath.replace(/\/_meta\.json$/, "");
}

export function buildSkillRepoIndex(repoDir: string, ref = "HEAD"): SkillRepoIndex {
  const output = git(repoDir, ["ls-tree", "-r", "--name-only", ref, "--", "skills"]);
  const index: SkillRepoIndex = new Map();

  for (const line of output.split("\n")) {
    const match = /^skills\/([^/]+)\/([^/]+)\/_meta\.json$/.exec(line.trim());
    if (!match) continue;
    const slug = match[2];
    const paths = index.get(slug) ?? [];
    paths.push(line.trim());
    index.set(slug, paths);
  }

  return index;
}

export function resolveArtifactForRecord(params: {
  repoDir: string;
  repoIndex: SkillRepoIndex;
  repoHead: string;
  summary: SkillTesterSummaryItem;
  detail: SkillTesterDetail | null;
  readSkillMd?: SkillMdReader;
}): ResolvedArtifact {
  const identity = resolveIdentity(params.summary, params.detail);
  if (!identity.version) {
    return {
      contentStatus: "missing",
      slug: identity.slug ?? undefined,
      missingReason: "Could not parse an exact SemVer version from SkillTester skill_name.",
      contentSource: "github_git_history",
    };
  }
  if (identity.candidateSlugs.length === 0) {
    return {
      contentStatus: "missing",
      version: identity.version,
      missingReason: "Could not resolve a ClawHub slug from SkillTester skill_url or skill_name.",
      contentSource: "github_git_history",
    };
  }

  const matches: Array<{
    owner: string;
    slug: string;
    displayName?: string;
    metaPath: string;
    version: SkillMetaVersion;
  }> = [];
  const candidates: Array<{ owner: string; slug: string; path: string }> = [];

  for (const slug of identity.candidateSlugs) {
    for (const metaPath of params.repoIndex.get(slug) ?? []) {
      const rawMeta = gitRaw(params.repoDir, ["show", `${params.repoHead}:${metaPath}`]);
      const meta = parseMeta(rawMeta);
      const skillDir = skillPathFromMetaPath(metaPath);
      const [, ownerFromPath, slugFromPath] = /^skills\/([^/]+)\/([^/]+)$/.exec(skillDir) ?? [];
      if (!ownerFromPath || !slugFromPath) continue;
      candidates.push({ owner: ownerFromPath, slug: slugFromPath, path: skillDir });
      if (!meta) continue;
      const versionEntry = findVersion(meta, identity.version);
      if (!versionEntry) continue;
      matches.push({
        owner: meta.owner ?? ownerFromPath,
        slug: meta.slug ?? slugFromPath,
        displayName: meta.displayName,
        metaPath,
        version: versionEntry,
      });
    }
  }

  if (matches.length === 0) {
    return {
      contentStatus: "missing",
      slug: identity.slug ?? undefined,
      version: identity.version,
      missingReason:
        "No openclaw/skills _meta.json candidate contains the exact SkillTester version.",
      candidates,
      contentSource: "github_git_history",
    };
  }

  if (matches.length > 1) {
    return {
      contentStatus: "missing",
      slug: identity.slug ?? undefined,
      version: identity.version,
      missingReason: "Multiple openclaw/skills candidates contain the exact SkillTester version.",
      candidates: matches.map((match) => ({
        owner: match.owner,
        slug: match.slug,
        path: skillPathFromMetaPath(match.metaPath),
      })),
      contentSource: "github_git_history",
    };
  }

  const match = matches[0];
  const commit = extractCommitHash(match.version.commit);
  if (!commit) {
    return {
      contentStatus: "missing",
      owner: match.owner,
      slug: match.slug,
      version: identity.version,
      missingReason: "Matched version has no recorded commit hash in _meta.json.",
      contentSource: "github_git_history",
    };
  }

  const skillDir = skillPathFromMetaPath(match.metaPath);
  const skillContent = (params.readSkillMd ?? readSkillMdFromGithub)(commit, skillDir);
  if (!skillContent) {
    return {
      contentStatus: "missing",
      owner: match.owner,
      slug: match.slug,
      version: identity.version,
      missingReason: `Matched commit ${commit} does not contain a readable SKILL.md for ${skillDir}.`,
      contentSource: "github_git_history",
    };
  }

  return {
    contentStatus: "fetched",
    owner: match.owner,
    slug: match.slug,
    version: identity.version,
    displayName: match.displayName,
    versionPublishedAt: match.version.publishedAt,
    commit,
    skillPath: skillContent.path,
    skillMdContent: skillContent.content,
    skillMdSha256: sha256(skillContent.content),
    skillMdBytes: byteLength(skillContent.content),
    contentSource: "github_git_history",
  };
}

function encodeGithubContentPath(path: string): string {
  return path.split("/").map(encodeURIComponent).join("/");
}

function readGithubRawContent(path: string, ref: string): string | null {
  const apiPath = encodeGithubContentPath(path);
  const result = run("gh", [
    "api",
    "-H",
    "Accept: application/vnd.github.raw",
    `repos/openclaw/skills/contents/${apiPath}?ref=${ref}`,
  ]);
  if (result.status !== 0) return null;
  return result.stdout;
}

function readSkillMdFromGithub(
  commit: string,
  skillDir: string,
): { path: string; content: string } | null {
  for (const fileName of ["SKILL.md", "SKILL.MD", "Skill.md", "skill.md"]) {
    const path = `${skillDir}/${fileName}`;
    const content = readGithubRawContent(path, commit);
    if (content !== null) return { path, content };
  }
  return null;
}

async function fetchJson<T>(fetchImpl: FetchLike, url: string): Promise<T> {
  const response = await fetchImpl(url);
  const text = await response.text();
  if (!response.ok) {
    throw new Error(
      `GET ${url} failed (${response.status} ${response.statusText}): ${text.slice(0, 500)}`,
    );
  }
  return JSON.parse(text) as T;
}

export async function fetchSkillTesterSummaries(params: {
  fetchImpl: FetchLike;
  pageSize: number;
  limit?: number;
}): Promise<SkillTesterSummaryItem[]> {
  const snapshot = await fetchSkillTesterSnapshot(params);
  return snapshot.summaries;
}

async function fetchSkillTesterSnapshot(params: {
  fetchImpl: FetchLike;
  pageSize: number;
  limit?: number;
}): Promise<SkillTesterSnapshot> {
  const rows: SkillTesterSummaryItem[] = [];
  const summaryPages: RawSummaryPageRecord[] = [];
  const details: Map<string, SkillTesterDetail> = new Map();
  const rawDetails: RawDetailRecord[] = [];
  let page = 1;

  while (true) {
    const url = new URL("/api/skills", SKILLTESTER_BASE_URL);
    url.searchParams.set("page", String(page));
    url.searchParams.set("page_size", String(params.pageSize));
    url.searchParams.set("source", SKILLTESTER_SOURCE);
    url.searchParams.set("tested", "all");
    url.searchParams.set("security", "all");
    url.searchParams.set("sort", "views");
    url.searchParams.set("summary", "1");

    const payload = await fetchJson<SkillTesterSummaryResponse>(params.fetchImpl, url.toString());
    summaryPages.push({
      url: url.toString(),
      fetched_at: new Date().toISOString(),
      payload,
    });
    for (const item of payload.items ?? []) {
      rows.push(item);
      if (params.limit && rows.length >= params.limit) {
        return {
          summaries: rows,
          summaryPages,
          details,
          rawDetails,
          fromRaw: false,
        };
      }
    }

    if (!payload.has_next) {
      return {
        summaries: rows,
        summaryPages,
        details,
        rawDetails,
        fromRaw: false,
      };
    }
    page += 1;
  }
}

async function fetchAndRecordSkillTesterDetail(
  fetchImpl: FetchLike,
  skillName: string,
): Promise<{ detail: SkillTesterDetail; raw: RawDetailRecord }> {
  const url = detailUrl(skillName);
  const detail = await fetchJson<SkillTesterDetail>(fetchImpl, url);
  return {
    detail,
    raw: {
      url,
      skill_name: skillName,
      fetched_at: new Date().toISOString(),
      payload: detail,
    },
  };
}

function detailUrl(skillName: string): string {
  return `${SKILLTESTER_BASE_URL}/api/skills/${SKILLTESTER_SOURCE}/${encodeURIComponent(skillName)}`;
}

async function readJsonl<T>(path: string): Promise<T[]> {
  const raw = await readFile(path, "utf8");
  if (raw.trim() === "") return [];
  return raw
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line) as T);
}

export async function loadSkillTesterSnapshotFromRaw(params: {
  rawDir: string;
  limit?: number;
}): Promise<SkillTesterSnapshot> {
  const summaryPages = await readJsonl<RawSummaryPageRecord>(
    join(params.rawDir, "summary-pages.jsonl"),
  );
  const rawDetails = await readJsonl<RawDetailRecord>(join(params.rawDir, "details.jsonl"));
  const summaries: SkillTesterSummaryItem[] = [];
  for (const page of summaryPages) {
    for (const item of page.payload.items ?? []) {
      summaries.push(item);
      if (params.limit && summaries.length >= params.limit) break;
    }
    if (params.limit && summaries.length >= params.limit) break;
  }

  const detailNames = new Set(
    summaries.flatMap((summary) =>
      typeof summary.skill_name === "string" && summary.skill_name ? [summary.skill_name] : [],
    ),
  );
  const details = new Map<string, SkillTesterDetail>();
  const scopedRawDetails = rawDetails.filter((record) => {
    const include = detailNames.has(record.skill_name);
    if (include) details.set(record.skill_name, record.payload);
    return include;
  });

  return {
    summaries,
    summaryPages,
    details,
    rawDetails: scopedRawDetails,
    fromRaw: true,
  };
}

function distilledSecurityTasks(detail: SkillTesterDetail | null): unknown[] {
  const result = asRecord(detail?.result);
  const tasksResult = asRecord(result?.tasks_result ?? detail?.tasks_result);
  const tasks = tasksResult?.security_tasks;
  if (!Array.isArray(tasks)) return [];
  return tasks.map((task) => {
    const record = asRecord(task) ?? {};
    return {
      task_id: record.task_id,
      state: record.state,
      security_dimension: record.security_dimension,
      audit_label: record.audit_label,
      result: record.result,
      passed: record.passed,
      notes: record.notes,
      passed_checks: record.passed_checks,
      failed_checks: record.failed_checks,
      total_checks: record.total_checks,
    };
  });
}

function buildRow(params: {
  summary: SkillTesterSummaryItem;
  detail: SkillTesterDetail | null;
  artifact: ResolvedArtifact;
  repoHead: string;
}): CorpusRow {
  const detailSkill = params.detail?.skill;
  const result = asRecord(params.detail?.result);
  const resultSummary = asRecord(result?.summary);
  const resultSecurity = asRecord(result?.security);
  const resultMeta = asRecord(result?.meta);
  const securityDimensions = resultSecurity?.dimensions;
  const securityScore =
    asNumber(resultSecurity?.score) ??
    asNumber(params.detail?.computed_scores?.security) ??
    asNumber(params.summary.security_score);
  const overallScore =
    asNumber(params.detail?.computed_scores?.overall) ?? asNumber(params.summary.score);
  const utilityScore =
    asNumber(params.detail?.computed_scores?.utility) ?? asNumber(params.summary.utility_score);
  const efficiencyScore =
    asNumber(params.detail?.computed_scores?.efficiency) ??
    asNumber(params.summary.efficiency_score);
  const owner =
    params.artifact.contentStatus === "fetched" ? params.artifact.owner : params.artifact.owner;
  const slug =
    params.artifact.contentStatus === "fetched" ? params.artifact.slug : params.artifact.slug;
  const version =
    params.artifact.contentStatus === "fetched" ? params.artifact.version : params.artifact.version;

  return {
    schema_version: CORPUS_SCHEMA_VERSION,
    corpus: "skilltester-clawhub",
    source: "SkillTester",
    content_status: params.artifact.contentStatus,
    resolved: {
      owner,
      slug,
      version,
      canonical_url: owner && slug ? `https://clawhub.ai/${owner}/${slug}` : undefined,
    },
    artifact: {
      source_repo: "https://github.com/openclaw/skills",
      repo_head: params.repoHead,
      content_source: "github_git_history",
      commit: params.artifact.contentStatus === "fetched" ? params.artifact.commit : undefined,
      path: params.artifact.contentStatus === "fetched" ? params.artifact.skillPath : undefined,
      skill_md_sha256:
        params.artifact.contentStatus === "fetched" ? params.artifact.skillMdSha256 : undefined,
      skill_md_bytes:
        params.artifact.contentStatus === "fetched" ? params.artifact.skillMdBytes : undefined,
      skill_md_content:
        params.artifact.contentStatus === "fetched" ? params.artifact.skillMdContent : undefined,
      missing_reason:
        params.artifact.contentStatus === "missing" ? params.artifact.missingReason : undefined,
      candidates:
        params.artifact.contentStatus === "missing" ? params.artifact.candidates : undefined,
    },
    skilltester: {
      summary: params.summary,
      detail_skill: detailSkill,
      selected_variant_id: params.detail?.selected_variant_id,
      selected_executor_model: params.detail?.selected_executor_model,
      scores: {
        overall: overallScore,
        utility: utilityScore,
        efficiency: efficiencyScore,
        security: securityScore,
        security_level: params.summary.security_level ?? null,
      },
      security: {
        level: params.summary.security_level ?? null,
        score: securityScore,
        summary:
          asString(resultSecurity?.summary) ?? asString(resultSummary?.overall_summary) ?? null,
        reasoning: asString(resultSecurity?.reasoning) ?? null,
        total_tests: asNumber(resultSecurity?.total_tests),
        total_passed: asNumber(resultSecurity?.total_passed),
        dimensions: securityDimensions,
        tasks: distilledSecurityTasks(params.detail),
      },
      source_urls: {
        detail_api_url: detailUrl(params.summary.skill_name ?? ""),
        skill_url: asString(detailSkill?.skill_url),
        download_url: asString(detailSkill?.download_url),
        result_url: asString(detailSkill?.result_url),
        report_url: asString(detailSkill?.report_url),
        tasks_url: asString(detailSkill?.tasks_url),
        scores_url: asString(detailSkill?.scores_url),
      },
      timestamps: {
        summary_updated_at: params.summary.updated_at,
        evaluation_timestamp: asString(resultMeta?.evaluation_timestamp),
      },
    },
    reference_labels: {
      source: "SkillTester",
      caveat:
        "SkillTester security labels are reference labels for eval comparison, not absolute truth.",
      security_level: params.summary.security_level ?? null,
      security_score: securityScore,
      security_dimensions: securityDimensions,
    },
  };
}

async function prepareSkillsRepo(keepTemp: boolean): Promise<PreparedSkillsRepo> {
  mustRun("gh", ["auth", "status"]);
  const tempRoot = await mkdtemp(join(tmpdir(), "clawhub-skilltester-corpus-"));
  const repoDir = join(tempRoot, "skills");
  mustRun("gh", [
    "repo",
    "clone",
    "openclaw/skills",
    repoDir,
    "--",
    "--depth=1",
    "--filter=blob:none",
    "--no-checkout",
  ]);
  const repoHead = git(repoDir, ["rev-parse", "HEAD"]);
  return {
    repoDir,
    repoHead,
    cleanup: async () => {
      if (keepTemp) {
        console.log(`Keeping temporary skills clone: ${repoDir}`);
        return;
      }
      await rm(tempRoot, { recursive: true, force: true });
    },
  };
}

function createInitialCounts(): BuildCounts {
  return {
    summaryRowsFetched: 0,
    detailRowsFetched: 0,
    detailFetchFailed: 0,
    rowsWritten: 0,
    fetchedContent: 0,
    missingContent: 0,
    ambiguous: 0,
    malformed: 0,
  };
}

function countArtifact(counts: BuildCounts, artifact: ResolvedArtifact) {
  if (artifact.contentStatus === "fetched") {
    counts.fetchedContent += 1;
    return;
  }
  counts.missingContent += 1;
  if (artifact.missingReason.includes("Multiple openclaw/skills candidates")) {
    counts.ambiguous += 1;
  }
  if (
    artifact.missingReason.includes("Could not parse") ||
    artifact.missingReason.includes("Could not resolve")
  ) {
    counts.malformed += 1;
  }
}

function gapForRow(row: CorpusRow): BuildManifest["gaps"][number] | null {
  if (row.content_status !== "missing") return null;
  return {
    skill_name: row.skilltester.summary.skill_name,
    owner: row.resolved.owner,
    slug: row.resolved.slug,
    version: row.resolved.version,
    reason: row.artifact.missing_reason ?? "Unknown missing-content reason.",
  };
}

async function writeCorpus(params: {
  outputDir: string;
  rows: CorpusRow[];
  manifest: BuildManifest;
  snapshot: SkillTesterSnapshot;
}) {
  await mkdir(params.outputDir, { recursive: true });
  const corpusFile = join(params.outputDir, "corpus.jsonl");
  const manifestFile = join(params.outputDir, "manifest.json");
  const rawDir = join(params.outputDir, RAW_DIR_NAME);
  const jsonl = params.rows.map((row) => JSON.stringify(row)).join("\n");
  await writeFile(corpusFile, `${jsonl}\n`, "utf8");
  await writeFile(manifestFile, `${JSON.stringify(params.manifest, null, 2)}\n`, "utf8");
  await mkdir(rawDir, { recursive: true });
  await writeFile(
    join(rawDir, "summary-pages.jsonl"),
    `${params.snapshot.summaryPages.map((record) => JSON.stringify(record)).join("\n")}\n`,
    "utf8",
  );
  await writeFile(
    join(rawDir, "details.jsonl"),
    `${params.snapshot.rawDetails.map((record) => JSON.stringify(record)).join("\n")}\n`,
    "utf8",
  );
  await writeFile(
    join(rawDir, "README.md"),
    [
      "# Raw SkillTester Snapshot",
      "",
      "These JSONL files preserve the raw SkillTester API payloads used to build",
      "the normalized corpus. They let the corpus be rebuilt with",
      "`bun run eval:corpus:build -- --from-raw` if SkillTester is unavailable.",
      "",
    ].join("\n"),
    "utf8",
  );
}

export async function buildCorpus(options: BuildOptions): Promise<{
  rows: CorpusRow[];
  manifest: BuildManifest;
}> {
  const skillsRepo = await prepareSkillsRepo(options.keepTemp);
  try {
    console.log(`Cloned openclaw/skills at ${skillsRepo.repoHead}`);
    const repoIndex = buildSkillRepoIndex(skillsRepo.repoDir);
    console.log(`Indexed ${repoIndex.size} skill slug(s) from openclaw/skills`);

    const snapshot = options.fromRawDir
      ? await loadSkillTesterSnapshotFromRaw({ rawDir: options.fromRawDir, limit: options.limit })
      : await fetchSkillTesterSnapshot({
          fetchImpl: options.fetchImpl,
          pageSize: options.pageSize,
          limit: options.limit,
        });
    const summaries = snapshot.summaries;
    const counts = createInitialCounts();
    counts.summaryRowsFetched = summaries.length;
    const rows: CorpusRow[] = [];

    for (const [index, summary] of summaries.entries()) {
      const skillName = summary.skill_name;
      let detail: SkillTesterDetail | null = null;
      if (typeof skillName === "string" && skillName.length > 0) {
        try {
          if (snapshot.fromRaw) {
            detail = snapshot.details.get(skillName) ?? null;
            if (!detail) throw new Error(`Raw SkillTester snapshot has no detail for ${skillName}`);
          } else {
            const recorded = await fetchAndRecordSkillTesterDetail(options.fetchImpl, skillName);
            detail = recorded.detail;
            snapshot.details.set(skillName, recorded.detail);
            snapshot.rawDetails.push(recorded.raw);
          }
          counts.detailRowsFetched += 1;
        } catch (error) {
          counts.detailFetchFailed += 1;
          console.warn(
            `Failed to fetch SkillTester detail for ${skillName}: ${
              error instanceof Error ? error.message : String(error)
            }`,
          );
        }
      }

      const artifact = resolveArtifactForRecord({
        repoDir: skillsRepo.repoDir,
        repoIndex,
        repoHead: skillsRepo.repoHead,
        summary,
        detail,
      });
      countArtifact(counts, artifact);
      rows.push(buildRow({ summary, detail, artifact, repoHead: skillsRepo.repoHead }));
      console.log(
        `[${index + 1}/${summaries.length}] ${skillName ?? "(missing skill_name)"} -> ${
          artifact.contentStatus
        }`,
      );
    }

    counts.rowsWritten = rows.length;
    const gaps = rows.flatMap((row) => {
      const gap = gapForRow(row);
      return gap ? [gap] : [];
    });
    const manifest: BuildManifest = {
      schema_version: CORPUS_SCHEMA_VERSION,
      corpus: "skilltester-clawhub",
      generated_at: new Date().toISOString(),
      builder: {
        script: "scripts/build-skilltester-clawhub-corpus.ts",
        version: BUILDER_VERSION,
      },
      sources: {
        skilltester: {
          base_url: SKILLTESTER_BASE_URL,
          source: SKILLTESTER_SOURCE,
          mode: snapshot.fromRaw ? "raw_snapshot" : "live_api",
          query: {
            source: SKILLTESTER_SOURCE,
            tested: "all",
            security: "all",
            sort: "views",
            summary: 1,
            page_size: options.pageSize,
            limit: options.limit ?? "none",
          },
          raw_snapshot: {
            summary_pages_file: "raw/summary-pages.jsonl",
            details_file: "raw/details.jsonl",
          },
        },
        skills_repo: {
          url: "https://github.com/openclaw/skills",
          head: skillsRepo.repoHead,
          access:
            "gh repo clone with shallow blobless checkout plus gh api raw reads for exact SKILL.md commits",
        },
      },
      output: {
        corpus_file: "corpus.jsonl",
        raw_summary_pages_file: "raw/summary-pages.jsonl",
        raw_details_file: "raw/details.jsonl",
        rows: rows.length,
      },
      counts,
      gaps,
    };

    if (!options.dryRun) {
      await writeCorpus({ outputDir: options.outputDir, rows, manifest, snapshot });
      console.log(
        `Wrote ${rows.length} corpus row(s) to ${join(options.outputDir, "corpus.jsonl")}`,
      );
    }

    return { rows, manifest };
  } finally {
    await skillsRepo.cleanup();
  }
}

async function main() {
  const cliOptions = parseArgs(process.argv.slice(2));
  await mkdir(dirname(cliOptions.outputDir), { recursive: true });
  const result = await buildCorpus({
    ...cliOptions,
    fetchImpl: fetch,
  });
  console.log(JSON.stringify(result.manifest.counts, null, 2));
}

function isMainModule(): boolean {
  return process.argv[1] ? import.meta.url === pathToFileURL(process.argv[1]).href : false;
}

if (isMainModule()) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  });
}
