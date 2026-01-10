import { v } from 'convex/values'
import { internal } from './_generated/api'
import type { Doc, Id } from './_generated/dataModel'
import { action, internalQuery } from './_generated/server'
import { generateEmbedding } from './lib/embeddings'

type HydratedEntry = {
  embeddingId: Id<'skillEmbeddings'>
  skill: Doc<'skills'> | null
  version: Doc<'skillVersions'> | null
}

type SearchResult = HydratedEntry & { score: number }

export const searchSkills: ReturnType<typeof action> = action({
  args: {
    query: v.string(),
    limit: v.optional(v.number()),
    highlightedOnly: v.optional(v.boolean()),
  },
  handler: async (ctx, args): Promise<SearchResult[]> => {
    const query = args.query.trim()
    if (!query) return []
    const vector = await generateEmbedding(query)
    const results = await ctx.vectorSearch('skillEmbeddings', 'by_embedding', {
      vector,
      limit: args.limit ?? 10,
      filter: (q) => q.or(q.eq('visibility', 'latest'), q.eq('visibility', 'latest-approved')),
    })

    const hydrated = (await ctx.runQuery(internal.search.hydrateResults, {
      embeddingIds: results.map((result) => result._id),
    })) as HydratedEntry[]

    const scoreById = new Map<Id<'skillEmbeddings'>, number>(
      results.map((result) => [result._id, result._score]),
    )

    const filtered = args.highlightedOnly
      ? hydrated.filter((entry) => entry.skill?.batch === 'highlighted')
      : hydrated

    return filtered
      .map((entry) => ({
        ...entry,
        score: scoreById.get(entry.embeddingId) ?? 0,
      }))
      .filter((entry) => entry.skill)
  },
})

export const hydrateResults = internalQuery({
  args: { embeddingIds: v.array(v.id('skillEmbeddings')) },
  handler: async (ctx, args): Promise<HydratedEntry[]> => {
    const entries: HydratedEntry[] = []

    for (const embeddingId of args.embeddingIds) {
      const embedding = await ctx.db.get(embeddingId)
      if (!embedding) continue
      const skill = await ctx.db.get(embedding.skillId)
      if (skill?.softDeletedAt) continue
      const version = await ctx.db.get(embedding.versionId)
      entries.push({ embeddingId, skill, version })
    }

    return entries
  },
})

type HydratedSoulEntry = {
  embeddingId: Id<'soulEmbeddings'>
  soul: Doc<'souls'> | null
  version: Doc<'soulVersions'> | null
}

type SoulSearchResult = HydratedSoulEntry & { score: number }

export const searchSouls: ReturnType<typeof action> = action({
  args: {
    query: v.string(),
    limit: v.optional(v.number()),
  },
  handler: async (ctx, args): Promise<SoulSearchResult[]> => {
    const query = args.query.trim()
    if (!query) return []
    const vector = await generateEmbedding(query)
    const results = await ctx.vectorSearch('soulEmbeddings', 'by_embedding', {
      vector,
      limit: args.limit ?? 10,
      filter: (q) => q.or(q.eq('visibility', 'latest'), q.eq('visibility', 'latest-approved')),
    })

    const hydrated = (await ctx.runQuery(internal.search.hydrateSoulResults, {
      embeddingIds: results.map((result) => result._id),
    })) as HydratedSoulEntry[]

    const scoreById = new Map<Id<'soulEmbeddings'>, number>(
      results.map((result) => [result._id, result._score]),
    )

    return hydrated
      .map((entry) => ({
        ...entry,
        score: scoreById.get(entry.embeddingId) ?? 0,
      }))
      .filter((entry) => entry.soul)
  },
})

export const hydrateSoulResults = internalQuery({
  args: { embeddingIds: v.array(v.id('soulEmbeddings')) },
  handler: async (ctx, args): Promise<HydratedSoulEntry[]> => {
    const entries: HydratedSoulEntry[] = []

    for (const embeddingId of args.embeddingIds) {
      const embedding = await ctx.db.get(embeddingId)
      if (!embedding) continue
      const soul = await ctx.db.get(embedding.soulId)
      if (soul?.softDeletedAt) continue
      const version = await ctx.db.get(embedding.versionId)
      entries.push({ embeddingId, soul, version })
    }

    return entries
  },
})
