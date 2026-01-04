import { ConvexError, v } from 'convex/values'
import semver from 'semver'
import { internal } from './_generated/api'
import type { Doc, Id } from './_generated/dataModel'
import { action, internalMutation, internalQuery, mutation, query } from './_generated/server'
import { assertRole, requireUser, requireUserFromAction } from './lib/access'
import { generateEmbedding } from './lib/embeddings'
import {
  buildEmbeddingText,
  getFrontmatterValue,
  isTextFile,
  parseClawdisMetadata,
  parseFrontmatter,
  sanitizePath,
} from './lib/skills'

const MAX_TOTAL_BYTES = 50 * 1024 * 1024
const MAX_FILES_FOR_EMBEDDING = 40

type PublishResult = {
  skillId: Id<'skills'>
  versionId: Id<'skillVersions'>
  embeddingId: Id<'skillEmbeddings'>
}

type ReadmeResult = { path: string; text: string }

export const getBySlug = query({
  args: { slug: v.string() },
  handler: async (ctx, args) => {
    const skill = await ctx.db
      .query('skills')
      .withIndex('by_slug', (q) => q.eq('slug', args.slug))
      .unique()
    if (!skill) return null
    const latestVersion = skill.latestVersionId ? await ctx.db.get(skill.latestVersionId) : null
    const owner = await ctx.db.get(skill.ownerUserId)
    return { skill, latestVersion, owner }
  },
})

export const getSkillBySlugInternal = internalQuery({
  args: { slug: v.string() },
  handler: async (ctx, args) => {
    return ctx.db
      .query('skills')
      .withIndex('by_slug', (q) => q.eq('slug', args.slug))
      .unique()
  },
})

export const list = query({
  args: {
    batch: v.optional(v.string()),
    ownerUserId: v.optional(v.id('users')),
    limit: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const limit = args.limit ?? 24
    if (args.batch) {
      return ctx.db
        .query('skills')
        .withIndex('by_batch', (q) => q.eq('batch', args.batch))
        .order('desc')
        .take(limit)
    }
    const ownerUserId = args.ownerUserId
    if (ownerUserId) {
      return ctx.db
        .query('skills')
        .withIndex('by_owner', (q) => q.eq('ownerUserId', ownerUserId))
        .order('desc')
        .take(limit)
    }
    return ctx.db.query('skills').order('desc').take(limit)
  },
})

export const listVersions = query({
  args: { skillId: v.id('skills'), limit: v.optional(v.number()) },
  handler: async (ctx, args) => {
    const limit = args.limit ?? 20
    return ctx.db
      .query('skillVersions')
      .withIndex('by_skill', (q) => q.eq('skillId', args.skillId))
      .order('desc')
      .take(limit)
  },
})

export const getVersionById = query({
  args: { versionId: v.id('skillVersions') },
  handler: async (ctx, args) => ctx.db.get(args.versionId),
})

export const getVersionByIdInternal = internalQuery({
  args: { versionId: v.id('skillVersions') },
  handler: async (ctx, args) => ctx.db.get(args.versionId),
})

export const getVersionBySkillAndVersion = query({
  args: { skillId: v.id('skills'), version: v.string() },
  handler: async (ctx, args) => {
    return ctx.db
      .query('skillVersions')
      .withIndex('by_skill_version', (q) =>
        q.eq('skillId', args.skillId).eq('version', args.version),
      )
      .unique()
  },
})

export const publishVersion: ReturnType<typeof action> = action({
  args: {
    slug: v.string(),
    displayName: v.string(),
    version: v.string(),
    changelog: v.string(),
    tags: v.optional(v.array(v.string())),
    files: v.array(
      v.object({
        path: v.string(),
        size: v.number(),
        storageId: v.id('_storage'),
        sha256: v.string(),
        contentType: v.optional(v.string()),
      }),
    ),
  },
  handler: async (ctx, args): Promise<PublishResult> => {
    const { userId } = await requireUserFromAction(ctx)

    const version = args.version.trim()
    const slug = args.slug.trim().toLowerCase()
    const displayName = args.displayName.trim()
    if (!slug || !displayName) throw new ConvexError('Slug and display name required')
    if (!/^[a-z0-9][a-z0-9-]*$/.test(slug)) {
      throw new ConvexError('Slug must be lowercase and url-safe')
    }
    if (!semver.valid(version)) {
      throw new ConvexError('Version must be valid semver')
    }
    const existingSkill = await ctx.runQuery(internal.skills.getSkillBySlugInternal, { slug })
    const changelogText = args.changelog.trim()
    if (existingSkill && !changelogText) {
      throw new ConvexError('Changelog is required for updates')
    }

    const sanitizedFiles = args.files.map((file) => ({
      ...file,
      path: sanitizePath(file.path),
    }))
    if (sanitizedFiles.some((file) => !file.path)) {
      throw new ConvexError('Invalid file paths')
    }
    if (
      sanitizedFiles.some((file) => !isTextFile(file.path ?? '', file.contentType ?? undefined))
    ) {
      throw new ConvexError('Only text-based files are allowed')
    }

    const totalBytes = sanitizedFiles.reduce((sum, file) => sum + file.size, 0)
    if (totalBytes > MAX_TOTAL_BYTES) {
      throw new ConvexError('Skill bundle exceeds 50MB limit')
    }

    const readmeFile = sanitizedFiles.find(
      (file) => file.path?.toLowerCase() === 'skill.md' || file.path?.toLowerCase() === 'skills.md',
    )
    if (!readmeFile) throw new ConvexError('SKILL.md is required')

    const readmeText = await fetchText(ctx, readmeFile.storageId)
    const frontmatter = parseFrontmatter(readmeText)
    const clawdis = parseClawdisMetadata(frontmatter)
    const metadataRaw = getFrontmatterValue(frontmatter, 'metadata')
    const metadata = metadataRaw ? safeJson(metadataRaw) : undefined

    const otherFiles = [] as Array<{ path: string; content: string }>
    for (const file of sanitizedFiles) {
      if (!file.path || file.path.toLowerCase().endsWith('.md')) continue
      if (!isTextFile(file.path, file.contentType ?? undefined)) continue
      const content = await fetchText(ctx, file.storageId)
      otherFiles.push({ path: file.path, content })
      if (otherFiles.length >= MAX_FILES_FOR_EMBEDDING) break
    }

    const embeddingText = buildEmbeddingText({
      frontmatter,
      readme: readmeText,
      otherFiles,
    })

    let embedding: number[]
    try {
      embedding = await generateEmbedding(embeddingText)
    } catch (error) {
      throw new ConvexError(formatEmbeddingError(error))
    }

    return ctx.runMutation(internal.skills.insertVersion, {
      userId,
      slug,
      displayName,
      version,
      changelog: changelogText,
      tags: args.tags?.map((tag) => tag.trim()).filter(Boolean),
      files: sanitizedFiles.map((file) => ({
        ...file,
        path: file.path ?? '',
      })),
      parsed: {
        frontmatter,
        metadata,
        clawdis,
      },
      embedding,
    })
  },
})

export const getReadme: ReturnType<typeof action> = action({
  args: { versionId: v.id('skillVersions') },
  handler: async (ctx, args): Promise<ReadmeResult> => {
    const version = (await ctx.runQuery(internal.skills.getVersionByIdInternal, {
      versionId: args.versionId,
    })) as Doc<'skillVersions'> | null
    if (!version) throw new ConvexError('Version not found')
    const readmeFile = version.files.find(
      (file) => file.path.toLowerCase() === 'skill.md' || file.path.toLowerCase() === 'skills.md',
    )
    if (!readmeFile) throw new ConvexError('SKILL.md not found')
    const text = await fetchText(ctx, readmeFile.storageId)
    return { path: readmeFile.path, text }
  },
})

function formatEmbeddingError(error: unknown) {
  if (error instanceof Error) {
    if (error.message.includes('OPENAI_API_KEY')) {
      return 'OPENAI_API_KEY is not configured.'
    }
    if (error.message.startsWith('Embedding failed')) {
      return error.message
    }
  }
  return 'Embedding failed. Please try again.'
}

export const updateTags = mutation({
  args: {
    skillId: v.id('skills'),
    tags: v.array(v.object({ tag: v.string(), versionId: v.id('skillVersions') })),
  },
  handler: async (ctx, args) => {
    const { user } = await requireUser(ctx)
    const skill = await ctx.db.get(args.skillId)
    if (!skill) throw new Error('Skill not found')
    if (skill.ownerUserId !== user._id) {
      assertRole(user, ['admin', 'moderator'])
    }

    const nextTags = { ...skill.tags }
    for (const entry of args.tags) {
      nextTags[entry.tag] = entry.versionId
    }

    const latestEntry = args.tags.find((entry) => entry.tag === 'latest')
    await ctx.db.patch(skill._id, {
      tags: nextTags,
      latestVersionId: latestEntry ? latestEntry.versionId : skill.latestVersionId,
      updatedAt: Date.now(),
    })

    if (latestEntry) {
      const embeddings = await ctx.db
        .query('skillEmbeddings')
        .withIndex('by_skill', (q) => q.eq('skillId', skill._id))
        .collect()
      for (const embedding of embeddings) {
        const isLatest = embedding.versionId === latestEntry.versionId
        await ctx.db.patch(embedding._id, {
          isLatest,
          visibility: visibilityFor(isLatest, embedding.isApproved),
          updatedAt: Date.now(),
        })
      }
    }
  },
})

export const setRedactionApproved = mutation({
  args: { skillId: v.id('skills'), approved: v.boolean() },
  handler: async (ctx, args) => {
    const { user } = await requireUser(ctx)
    assertRole(user, ['admin', 'moderator'])

    const skill = await ctx.db.get(args.skillId)
    if (!skill) throw new Error('Skill not found')

    const badge = args.approved ? { byUserId: user._id, at: Date.now() } : undefined

    await ctx.db.patch(skill._id, {
      badges: { ...skill.badges, redactionApproved: badge },
      updatedAt: Date.now(),
    })

    const embeddings = await ctx.db
      .query('skillEmbeddings')
      .withIndex('by_skill', (q) => q.eq('skillId', skill._id))
      .collect()
    for (const embedding of embeddings) {
      await ctx.db.patch(embedding._id, {
        isApproved: Boolean(badge),
        visibility: visibilityFor(embedding.isLatest, Boolean(badge)),
        updatedAt: Date.now(),
      })
    }

    await ctx.db.insert('auditLogs', {
      actorUserId: user._id,
      action: args.approved ? 'badge.set' : 'badge.unset',
      targetType: 'skill',
      targetId: skill._id,
      metadata: { badge: 'redactionApproved', approved: args.approved },
      createdAt: Date.now(),
    })
  },
})

export const setBatch = mutation({
  args: { skillId: v.id('skills'), batch: v.optional(v.string()) },
  handler: async (ctx, args) => {
    const { user } = await requireUser(ctx)
    assertRole(user, ['admin', 'moderator'])
    const skill = await ctx.db.get(args.skillId)
    if (!skill) throw new Error('Skill not found')
    await ctx.db.patch(skill._id, {
      batch: args.batch?.trim() || undefined,
      updatedAt: Date.now(),
    })
    await ctx.db.insert('auditLogs', {
      actorUserId: user._id,
      action: 'batch.set',
      targetType: 'skill',
      targetId: skill._id,
      metadata: { batch: args.batch?.trim() ?? null },
      createdAt: Date.now(),
    })
  },
})

export const insertVersion = internalMutation({
  args: {
    userId: v.id('users'),
    slug: v.string(),
    displayName: v.string(),
    version: v.string(),
    changelog: v.string(),
    tags: v.optional(v.array(v.string())),
    files: v.array(
      v.object({
        path: v.string(),
        size: v.number(),
        storageId: v.id('_storage'),
        sha256: v.string(),
        contentType: v.optional(v.string()),
      }),
    ),
    parsed: v.object({
      frontmatter: v.record(v.string(), v.string()),
      metadata: v.optional(v.any()),
      clawdis: v.optional(v.any()),
    }),
    embedding: v.array(v.number()),
  },
  handler: async (ctx, args) => {
    const userId = args.userId
    const user = await ctx.db.get(userId)
    if (!user || user.deletedAt) throw new Error('User not found')

    let skill = await ctx.db
      .query('skills')
      .withIndex('by_slug', (q) => q.eq('slug', args.slug))
      .unique()

    if (skill && skill.ownerUserId !== userId) {
      throw new Error('Only the owner can publish updates')
    }

    const now = Date.now()
    if (!skill) {
      const summary = getFrontmatterValue(args.parsed.frontmatter, 'description')
      const skillId = await ctx.db.insert('skills', {
        slug: args.slug,
        displayName: args.displayName,
        summary: summary ?? undefined,
        ownerUserId: userId,
        latestVersionId: undefined,
        tags: {},
        badges: { redactionApproved: undefined },
        stats: { downloads: 0, stars: 0, versions: 0, comments: 0 },
        createdAt: now,
        updatedAt: now,
      })
      skill = await ctx.db.get(skillId)
    }

    if (!skill) throw new Error('Skill creation failed')

    const existingVersion = await ctx.db
      .query('skillVersions')
      .withIndex('by_skill_version', (q) => q.eq('skillId', skill._id).eq('version', args.version))
      .unique()
    if (existingVersion) {
      throw new Error('Version already exists')
    }

    const versionId = await ctx.db.insert('skillVersions', {
      skillId: skill._id,
      version: args.version,
      changelog: args.changelog,
      files: args.files,
      parsed: args.parsed,
      createdBy: userId,
      createdAt: now,
      softDeletedAt: undefined,
    })

    const nextTags: Record<string, Id<'skillVersions'>> = { ...skill.tags }
    nextTags.latest = versionId
    for (const tag of args.tags ?? []) {
      nextTags[tag] = versionId
    }

    const latestBefore = skill.latestVersionId

    await ctx.db.patch(skill._id, {
      displayName: args.displayName,
      summary: getFrontmatterValue(args.parsed.frontmatter, 'description') ?? skill.summary,
      latestVersionId: versionId,
      tags: nextTags,
      stats: { ...skill.stats, versions: skill.stats.versions + 1 },
      updatedAt: now,
    })

    const embeddingId = await ctx.db.insert('skillEmbeddings', {
      skillId: skill._id,
      versionId,
      ownerId: userId,
      embedding: args.embedding,
      isLatest: true,
      isApproved: Boolean(skill.badges.redactionApproved),
      visibility: visibilityFor(true, Boolean(skill.badges.redactionApproved)),
      updatedAt: now,
    })

    if (latestBefore) {
      const previousEmbedding = await ctx.db
        .query('skillEmbeddings')
        .withIndex('by_version', (q) => q.eq('versionId', latestBefore))
        .unique()
      if (previousEmbedding) {
        await ctx.db.patch(previousEmbedding._id, {
          isLatest: false,
          visibility: visibilityFor(false, previousEmbedding.isApproved),
          updatedAt: now,
        })
      }
    }

    return { skillId: skill._id, versionId, embeddingId }
  },
})

async function fetchText(
  ctx: { storage: { get: (id: Id<'_storage'>) => Promise<Blob | null> } },
  storageId: Id<'_storage'>,
) {
  const blob = await ctx.storage.get(storageId)
  if (!blob) throw new Error('File missing in storage')
  return blob.text()
}

function safeJson(value: string) {
  try {
    return JSON.parse(value)
  } catch {
    return undefined
  }
}

function visibilityFor(isLatest: boolean, isApproved: boolean) {
  if (isLatest && isApproved) return 'latest-approved'
  if (isLatest) return 'latest'
  if (isApproved) return 'archived-approved'
  return 'archived'
}
