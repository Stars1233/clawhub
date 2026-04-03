import { useAction } from "convex/react";
import { useEffect, useRef, useState } from "react";
import { api } from "../../convex/_generated/api";
import { fetchPluginCatalog, type PackageListItem } from "./packageApi";

export type UnifiedSkillResult = {
  type: "skill";
  skill: {
    _id: string;
    slug: string;
    displayName: string;
    summary?: string | null;
    ownerUserId: string;
    ownerPublisherId?: string | null;
    stats: { downloads: number; stars: number; versions?: number };
    updatedAt: number;
    createdAt: number;
  };
  ownerHandle: string | null;
  score: number;
};

export type UnifiedPluginResult = {
  type: "plugin";
  plugin: PackageListItem;
};

export type UnifiedResult = UnifiedSkillResult | UnifiedPluginResult;

export function useUnifiedSearch(query: string, activeType: "all" | "skills" | "plugins") {
  const searchSkills = useAction(api.search.searchSkills);
  const [results, setResults] = useState<UnifiedResult[]>([]);
  const [skillCount, setSkillCount] = useState(0);
  const [pluginCount, setPluginCount] = useState(0);
  const [isSearching, setIsSearching] = useState(false);
  const requestRef = useRef(0);

  useEffect(() => {
    const trimmed = query.trim();
    if (!trimmed) {
      setResults([]);
      setSkillCount(0);
      setPluginCount(0);
      setIsSearching(false);
      return;
    }

    requestRef.current += 1;
    const requestId = requestRef.current;
    setIsSearching(true);

    const handle = window.setTimeout(() => {
      void (async () => {
        try {
          const promises: [
            Promise<unknown> | null,
            Promise<{ items: PackageListItem[] }> | null,
          ] = [null, null];

          if (activeType === "all" || activeType === "skills") {
            promises[0] = searchSkills({
              query: trimmed,
              limit: 25,
              nonSuspiciousOnly: true,
            });
          }

          if (activeType === "all" || activeType === "plugins") {
            promises[1] = fetchPluginCatalog({ q: trimmed, limit: 25 });
          }

          const [skillsRaw, pluginsRaw] = await Promise.all(promises);

          if (requestId !== requestRef.current) return;

          const skillResults: UnifiedSkillResult[] = (
            (skillsRaw as Array<{ skill: UnifiedSkillResult["skill"]; ownerHandle: string | null; score: number }>) ?? []
          ).map((entry) => ({
            type: "skill" as const,
            skill: entry.skill,
            ownerHandle: entry.ownerHandle,
            score: entry.score,
          }));

          const pluginResults: UnifiedPluginResult[] = (
            (pluginsRaw as { items: PackageListItem[] })?.items ?? []
          ).map((item) => ({
            type: "plugin" as const,
            plugin: item,
          }));

          setSkillCount(skillResults.length);
          setPluginCount(pluginResults.length);

          const merged: UnifiedResult[] = [];
          if (activeType === "all") {
            merged.push(...skillResults, ...pluginResults);
          } else if (activeType === "skills") {
            merged.push(...skillResults);
          } else {
            merged.push(...pluginResults);
          }

          setResults(merged);
        } catch {
          if (requestId === requestRef.current) {
            setResults([]);
            setSkillCount(0);
            setPluginCount(0);
          }
        } finally {
          if (requestId === requestRef.current) {
            setIsSearching(false);
          }
        }
      })();
    }, 300);

    return () => window.clearTimeout(handle);
  }, [query, activeType, searchSkills]);

  return { results, skillCount, pluginCount, isSearching };
}
