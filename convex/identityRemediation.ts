import { ConvexError, v } from "convex/values";
import type { Doc, Id } from "./_generated/dataModel";
import { internalMutation } from "./_generated/server";

const APPLY_CONFIRMATION = "APPLY_IDENTITY_REMEDIATION";

const profilePatchValidator = v.object({
  name: v.optional(v.string()),
  handle: v.optional(v.string()),
  displayName: v.optional(v.string()),
  bio: v.optional(v.union(v.string(), v.null())),
  image: v.optional(v.string()),
});

type ProfilePatch = {
  name?: string;
  handle?: string;
  displayName?: string;
  bio?: string | null;
  image?: string;
};

type AuthAccountSummary = {
  _id: Id<"authAccounts">;
  provider: string;
  providerAccountId: string;
  userId: Id<"users">;
  _creationTime: number;
};

type ApiTokenSummary = {
  _id: Id<"apiTokens">;
  label: string;
  prefix: string;
  createdAt: number;
  lastUsedAt: number | null;
  revokedAt: number | null;
};

type SessionSummary = {
  _id: Id<"authSessions">;
  _creationTime: number;
  expirationTime: number;
  refreshTokenCount: number;
};

function summarizeAuthAccount(account: Doc<"authAccounts">): AuthAccountSummary {
  return {
    _id: account._id,
    provider: account.provider,
    providerAccountId: account.providerAccountId,
    userId: account.userId,
    _creationTime: account._creationTime,
  };
}

function summarizeApiToken(token: Doc<"apiTokens">): ApiTokenSummary {
  return {
    _id: token._id,
    label: token.label,
    prefix: token.prefix,
    createdAt: token.createdAt,
    lastUsedAt: token.lastUsedAt ?? null,
    revokedAt: token.revokedAt ?? null,
  };
}

function buildUserPatch(profile: ProfilePatch, now: number): Partial<Doc<"users">> {
  const patch: Partial<Doc<"users">> = { updatedAt: now };
  if (profile.name !== undefined) patch.name = profile.name;
  if (profile.handle !== undefined) patch.handle = profile.handle;
  if (profile.displayName !== undefined) patch.displayName = profile.displayName;
  if (profile.bio !== undefined) patch.bio = profile.bio ?? undefined;
  if (profile.image !== undefined) patch.image = profile.image;
  return patch;
}

function buildPublisherPatch(profile: ProfilePatch, now: number): Partial<Doc<"publishers">> {
  const patch: Partial<Doc<"publishers">> = { updatedAt: now };
  if (profile.handle !== undefined) patch.handle = profile.handle;
  if (profile.displayName !== undefined) patch.displayName = profile.displayName;
  if (profile.bio !== undefined) patch.bio = profile.bio ?? undefined;
  if (profile.image !== undefined) patch.image = profile.image;
  return patch;
}

export const remediateLinkedGitHubAccounts = internalMutation({
  args: {
    dryRun: v.boolean(),
    confirmation: v.optional(v.string()),
    targetUserId: v.id("users"),
    provider: v.optional(v.string()),
    canonicalProviderAccountId: v.string(),
    removeProviderAccountIds: v.array(v.string()),
    profile: profilePatchValidator,
    expireSessions: v.optional(v.boolean()),
    revokeActiveApiTokens: v.optional(v.boolean()),
    reason: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const provider = args.provider ?? "github";
    const now = Date.now();
    const removeProviderAccountIds = [...new Set(args.removeProviderAccountIds)];
    if (removeProviderAccountIds.length !== args.removeProviderAccountIds.length) {
      throw new ConvexError("Duplicate provider account ids are not allowed");
    }
    if (removeProviderAccountIds.includes(args.canonicalProviderAccountId)) {
      throw new ConvexError("Cannot remove the canonical provider account id");
    }
    if (!args.dryRun && args.confirmation !== APPLY_CONFIRMATION) {
      throw new ConvexError("Apply mode requires confirmation");
    }

    const user = await ctx.db.get(args.targetUserId);
    if (!user) throw new ConvexError("Target user not found");

    const accounts = await ctx.db
      .query("authAccounts")
      .withIndex("userIdAndProvider", (q) =>
        q.eq("userId", args.targetUserId).eq("provider", provider),
      )
      .collect();
    const canonicalAccounts = accounts.filter(
      (account) => account.providerAccountId === args.canonicalProviderAccountId,
    );
    if (canonicalAccounts.length !== 1) {
      throw new ConvexError("Expected exactly one canonical provider account");
    }

    const removeAccounts = accounts.filter((account) =>
      removeProviderAccountIds.includes(account.providerAccountId),
    );
    const foundRemoveIds = new Set(removeAccounts.map((account) => account.providerAccountId));
    const missingRemoveProviderAccountIds = removeProviderAccountIds.filter(
      (providerAccountId) => !foundRemoveIds.has(providerAccountId),
    );
    if (missingRemoveProviderAccountIds.length > 0) {
      throw new ConvexError("One or more remove provider account ids were not found");
    }

    const sessions = await ctx.db
      .query("authSessions")
      .withIndex("userId", (q) => q.eq("userId", args.targetUserId))
      .collect();
    const sessionSummaries: SessionSummary[] = [];
    let refreshTokenDeleteCount = 0;
    for (const session of sessions) {
      const refreshTokens = await ctx.db
        .query("authRefreshTokens")
        .withIndex("sessionId", (q) => q.eq("sessionId", session._id))
        .collect();
      sessionSummaries.push({
        _id: session._id,
        _creationTime: session._creationTime,
        expirationTime: session.expirationTime,
        refreshTokenCount: refreshTokens.length,
      });
      refreshTokenDeleteCount += refreshTokens.length;
      if (!args.dryRun && args.expireSessions) {
        for (const refreshToken of refreshTokens) {
          await ctx.db.delete(refreshToken._id);
        }
        await ctx.db.delete(session._id);
      }
    }

    const apiTokens = await ctx.db
      .query("apiTokens")
      .withIndex("by_user", (q) => q.eq("userId", args.targetUserId))
      .collect();
    const activeApiTokens = apiTokens.filter((token) => token.revokedAt === undefined);

    let publisher: Doc<"publishers"> | null = null;
    if (user.personalPublisherId) {
      publisher = await ctx.db.get(user.personalPublisherId);
    }

    const userPatch = buildUserPatch(args.profile, now);
    const publisherPatch = publisher ? buildPublisherPatch(args.profile, now) : null;

    if (!args.dryRun) {
      for (const account of removeAccounts) {
        await ctx.db.delete(account._id);
      }
      await ctx.db.patch(args.targetUserId, userPatch);
      if (publisher && publisherPatch) {
        await ctx.db.patch(publisher._id, publisherPatch);
      }
      if (args.revokeActiveApiTokens) {
        for (const token of activeApiTokens) {
          await ctx.db.patch(token._id, { revokedAt: now });
        }
      }
      await ctx.db.insert("auditLogs", {
        actorUserId: undefined,
        action: "user.auth_identity.remediate",
        targetType: "user",
        targetId: args.targetUserId,
        metadata: {
          provider,
          reason: args.reason ?? null,
          canonicalProviderAccountId: args.canonicalProviderAccountId,
          removedProviderAccountIds: removeProviderAccountIds,
          profileFieldsReset: Object.keys(args.profile),
          expiredSessions: Boolean(args.expireSessions),
          revokedActiveApiTokens: Boolean(args.revokeActiveApiTokens),
        },
        createdAt: now,
      });
    }

    return {
      dryRun: args.dryRun,
      targetUserId: args.targetUserId,
      provider,
      canonicalAccount: summarizeAuthAccount(canonicalAccounts[0]),
      accountsBefore: accounts.map(summarizeAuthAccount),
      removeAccounts: removeAccounts.map(summarizeAuthAccount),
      missingRemoveProviderAccountIds,
      userBefore: {
        _id: user._id,
        name: user.name ?? null,
        handle: user.handle ?? null,
        displayName: user.displayName ?? null,
        bio: user.bio ?? null,
        image: user.image ?? null,
        personalPublisherId: user.personalPublisherId ?? null,
      },
      userPatch,
      publisherBefore: publisher
        ? {
            _id: publisher._id,
            handle: publisher.handle,
            displayName: publisher.displayName,
            bio: publisher.bio ?? null,
            image: publisher.image ?? null,
          }
        : null,
      publisherPatch,
      sessions: sessionSummaries,
      sessionsDeleted: !args.dryRun && args.expireSessions ? sessions.length : 0,
      refreshTokensDeleted: !args.dryRun && args.expireSessions ? refreshTokenDeleteCount : 0,
      apiTokens: apiTokens.map(summarizeApiToken),
      activeApiTokensRevoked:
        !args.dryRun && args.revokeActiveApiTokens ? activeApiTokens.length : 0,
      applied: !args.dryRun,
    };
  },
});
