/* @vitest-environment node */
import { describe, expect, it } from "vitest";
import {
  candidateLabels,
  classifyPullRequestCandidateLabels,
  managedLabelSpecs,
  runBarnacleAutoResponse,
} from "./barnacle-auto-response.mjs";

const blankTemplateBody = [
  "## Summary",
  "",
  "Describe the problem and fix in 2-5 bullets:",
  "",
  "- Problem:",
  "- Why it matters:",
  "- What changed:",
  "- What did NOT change:",
  "",
  "## Linked Issue/PR",
  "",
  "- Closes #",
  "- Related #",
  "",
  "## Root Cause",
  "",
  "- Root cause:",
  "",
  "## Test Plan",
  "",
  "- Target test or file:",
].join("\n");

function pr(title, body = blankTemplateBody) {
  return {
    title,
    body,
  };
}

function file(filename, status = "modified") {
  return {
    filename,
    status,
  };
}

function barnacleContext(pullRequest, labels = [], options = {}) {
  return {
    repo: {
      owner: "openclaw",
      repo: "clawhub",
    },
    payload: {
      action: options.action ?? "opened",
      label: options.label,
      sender: options.sender,
      pull_request: {
        number: 123,
        title: "Cleanup docs",
        body: blankTemplateBody,
        author_association: "CONTRIBUTOR",
        user: {
          login: "contributor",
        },
        labels: labels.map((name) => ({ name })),
        ...pullRequest,
      },
    },
  };
}

function barnacleGithub(files) {
  const calls = {
    addLabels: [],
    createComment: [],
    createLabel: [],
    lock: [],
    removeLabel: [],
    update: [],
    updateLabel: [],
  };
  const github = {
    paginate: async () => files,
    rest: {
      issues: {
        addLabels: async (params) => {
          calls.addLabels.push(params);
        },
        createComment: async (params) => {
          calls.createComment.push(params);
        },
        createLabel: async (params) => {
          calls.createLabel.push(params);
        },
        getLabel: async (params) => ({
          data: {
            color: managedLabelSpecs[params.name]?.color ?? "C5DEF5",
            description: managedLabelSpecs[params.name]?.description ?? "",
          },
        }),
        lock: async (params) => {
          calls.lock.push(params);
        },
        removeLabel: async (params) => {
          calls.removeLabel.push(params);
        },
        update: async (params) => {
          calls.update.push(params);
        },
        updateLabel: async (params) => {
          calls.updateLabel.push(params);
        },
      },
      pulls: {
        listFiles: async () => files,
      },
      repos: {
        getCollaboratorPermissionLevel: async () => ({
          data: {
            role_name: "read",
          },
        }),
      },
      teams: {
        getMembershipForUserInOrg: async () => {
          const error = new Error("not found");
          error.status = 404;
          throw error;
        },
      },
    },
  };
  return { calls, github };
}

describe("barnacle-auto-response", () => {
  it("keeps Barnacle-owned labels documented for ClawHub", () => {
    expect(managedLabelSpecs["r: support"].description).toContain("support requests");
    expect(managedLabelSpecs["r: direct-skill-content"].description).toContain("published");
    expect(managedLabelSpecs["r: paid-skill"].description).toContain("paid skills");

    for (const label of Object.values(candidateLabels)) {
      expect(managedLabelSpecs[label]).toBeDefined();
      expect(managedLabelSpecs[label].description).toMatch(/^Candidate:/);
    }
  });

  it("labels low-signal docs without closing on bot-applied labels", async () => {
    const labels = classifyPullRequestCandidateLabels(pr("Update README translation"), [
      file("README.md"),
    ]);

    expect(labels).toEqual(
      expect.arrayContaining([candidateLabels.blankTemplate, candidateLabels.lowSignalDocs]),
    );

    const { calls, github } = barnacleGithub([file("README.md")]);
    await runBarnacleAutoResponse({
      github,
      context: barnacleContext({}, [candidateLabels.lowSignalDocs], {
        action: "labeled",
        label: { name: candidateLabels.lowSignalDocs },
        sender: { login: "github-actions[bot]", type: "Bot" },
      }),
      core: {
        info: () => undefined,
      },
    });

    expect(calls.update).toEqual([]);
    expect(calls.createComment).toEqual([]);
  });

  it("labels direct skill content as a ClawHub publishing bypass", () => {
    const labels = classifyPullRequestCandidateLabels(pr("Add useful browser skill"), [
      file("skills/browser/SKILL.md", "added"),
    ]);

    expect(labels).toContain(candidateLabels.directSkillContent);
  });

  it("does not treat repo-local developer skills as published skill content", () => {
    const labels = classifyPullRequestCandidateLabels(pr("Update Convex helper skill"), [
      file(".agents/skills/convex/SKILL.md", "modified"),
    ]);

    expect(labels).not.toContain(candidateLabels.directSkillContent);
  });

  it("uses linked issues as context and suppresses low-signal docs labels", () => {
    const labels = classifyPullRequestCandidateLabels(
      pr("Update docs", `${blankTemplateBody}\n\nRelated #123`),
      [file("docs/skill-format.md")],
    );

    expect(labels).not.toContain(candidateLabels.lowSignalDocs);
  });

  it("warns on broad high-surface PRs instead of auto-closing them immediately", async () => {
    const { calls, github } = barnacleGithub([
      file("src/routes/index.tsx"),
      file("convex/skills.ts"),
      file("server/routes/og/skill.png.tsx"),
      file("docs/skill-format.md"),
    ]);

    await runBarnacleAutoResponse({
      github,
      context: barnacleContext({}),
      core: {
        info: () => undefined,
      },
    });

    expect(calls.addLabels).toContainEqual(
      expect.objectContaining({
        labels: expect.arrayContaining([candidateLabels.dirtyCandidate]),
      }),
    );
    expect(calls.createComment).toEqual([]);
    expect(calls.update).toEqual([]);
  });

  it("does not add candidate labels to maintainer-authored PRs", async () => {
    const { calls, github } = barnacleGithub([
      file("src/routes/index.tsx"),
      file("convex/skills.ts"),
      file("server/routes/og/skill.png.tsx"),
      file("docs/skill-format.md"),
    ]);

    await runBarnacleAutoResponse({
      github,
      context: barnacleContext({
        author_association: "OWNER",
        user: {
          login: "maintainer",
        },
      }),
      core: {
        info: () => undefined,
      },
    });

    expect(calls.addLabels).toEqual([]);
  });

  it("actions manually applied candidate labels", async () => {
    const { calls, github } = barnacleGithub([file("skills/browser/SKILL.md", "added")]);

    await runBarnacleAutoResponse({
      github,
      context: barnacleContext({}, [candidateLabels.directSkillContent], {
        action: "labeled",
        label: { name: candidateLabels.directSkillContent },
        sender: { login: "maintainer", type: "User" },
      }),
      core: {
        info: () => undefined,
      },
    });

    expect(calls.createComment).toContainEqual(
      expect.objectContaining({
        body: expect.stringContaining("published through ClawHub"),
      }),
    );
    expect(calls.update).toContainEqual(expect.objectContaining({ state: "closed" }));
  });

  it("closes explicit support-labeled issues", async () => {
    const { calls, github } = barnacleGithub([]);

    await runBarnacleAutoResponse({
      github,
      context: {
        repo: {
          owner: "openclaw",
          repo: "clawhub",
        },
        payload: {
          action: "labeled",
          issue: {
            number: 456,
            title: "Need help installing a skill",
            body: "",
            user: {
              login: "user",
            },
            labels: [{ name: "r: support" }],
          },
        },
      },
      core: {
        info: () => undefined,
      },
    });

    expect(calls.createComment).toContainEqual(
      expect.objectContaining({
        issue_number: 456,
        body: expect.stringContaining("community support server"),
      }),
    );
    expect(calls.update).toContainEqual(
      expect.objectContaining({
        issue_number: 456,
        state: "closed",
        state_reason: "not_planned",
      }),
    );
  });
});
