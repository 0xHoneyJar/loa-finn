// src/nft/personality-store-pg.ts — Drizzle PersonalityStorePg Implementation (Cycle 040)
//
// Bridges PersonalityStore's Postgres interface to the Drizzle schema.
// Required for boot sequence wiring of the personality pipeline.

import { eq } from "drizzle-orm"
import { finnPersonalities, finnPersonalityVersions } from "../drizzle/schema.js"
import type { PersonalityStorePg, StoredPersonality, StoredPersonalityVersion } from "./personality-store.js"

type Db = Parameters<typeof eq>[0] extends infer T ? any : any

/**
 * Create a PersonalityStorePg backed by Drizzle ORM.
 */
export function createPersonalityStorePg(db: any): PersonalityStorePg {
  return {
    async getPersonalityByTokenId(tokenId: string): Promise<StoredPersonality | null> {
      const rows = await db
        .select()
        .from(finnPersonalities)
        .where(eq(finnPersonalities.tokenId, tokenId))
        .limit(1)
      return rows[0] ?? null
    },

    async upsertPersonality(p: StoredPersonality): Promise<void> {
      await db
        .insert(finnPersonalities)
        .values({
          id: p.id,
          tokenId: p.tokenId,
          archetype: p.archetype,
          currentVersionId: p.currentVersionId,
          createdAt: p.createdAt,
          updatedAt: p.updatedAt,
        })
        .onConflictDoUpdate({
          target: finnPersonalities.id,
          set: {
            archetype: p.archetype,
            currentVersionId: p.currentVersionId,
            updatedAt: p.updatedAt,
          },
        })
    },

    async getLatestVersion(personalityId: string): Promise<StoredPersonalityVersion | null> {
      const rows = await db
        .select()
        .from(finnPersonalityVersions)
        .where(eq(finnPersonalityVersions.personalityId, personalityId))
        .orderBy(finnPersonalityVersions.versionNumber)
        .limit(1)
      // orderBy is ASC by default; we want the latest (highest versionNumber)
      // Use a subquery approach or just fetch and take last
      const allVersions = await db
        .select()
        .from(finnPersonalityVersions)
        .where(eq(finnPersonalityVersions.personalityId, personalityId))
      if (allVersions.length === 0) return null
      return allVersions.reduce((latest: any, v: any) =>
        v.versionNumber > (latest?.versionNumber ?? -1) ? v : latest,
      null)
    },

    async insertVersion(v: StoredPersonalityVersion): Promise<void> {
      await db
        .insert(finnPersonalityVersions)
        .values({
          id: v.id,
          personalityId: v.personalityId,
          versionNumber: v.versionNumber,
          beauvoirTemplate: v.beauvoirTemplate,
          dampFingerprint: v.dampFingerprint,
          epochNumber: v.epochNumber,
          createdAt: v.createdAt,
        })
    },
  }
}
