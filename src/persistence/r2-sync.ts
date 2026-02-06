// src/persistence/r2-sync.ts — Incremental sync to Cloudflare R2 (SDD §3.3.2, T-3.2)

import { createHash } from "node:crypto"
import { existsSync, readFileSync } from "node:fs"
import { readFile, writeFile } from "node:fs/promises"
import { join } from "node:path"
import {
  GetObjectCommand,
  HeadObjectCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3"
import { ulid } from "ulid"
import type { FinnConfig } from "../config.js"
import type { WAL } from "./wal.js"

export interface SyncResult {
  filesUploaded: number
  bytesUploaded: number
  duration: number
}

export interface R2Checkpoint {
  checkpointId: string
  timestamp: number
  walSegments: string[]       // WAL segment keys in R2
  walHeadEntryId: string      // Last WAL entry ID in checkpoint
  objects: Array<{
    key: string
    sha256: string
    size: number
  }>
  bootEpoch: string
}

export class ObjectStoreSync {
  private client: S3Client
  private bucket: string
  private dataDir: string
  private lastCheckpoint: R2Checkpoint | undefined
  private bootEpoch: string

  constructor(
    private config: FinnConfig,
    private wal: WAL,
  ) {
    this.bucket = config.r2.bucket
    this.dataDir = config.dataDir
    this.bootEpoch = ulid()

    this.client = new S3Client({
      region: "auto",
      endpoint: config.r2.endpoint,
      credentials: {
        accessKeyId: config.r2.accessKeyId,
        secretAccessKey: config.r2.secretAccessKey,
      },
    })
  }

  /** Check if R2 is configured and usable. */
  get isConfigured(): boolean {
    return !!(this.config.r2.endpoint && this.config.r2.accessKeyId && this.config.r2.secretAccessKey)
  }

  /** Incremental sync: upload new WAL segments and update checkpoint. */
  async sync(): Promise<SyncResult> {
    const start = Date.now()
    let filesUploaded = 0
    let bytesUploaded = 0

    if (!this.isConfigured) {
      return { filesUploaded: 0, bytesUploaded: 0, duration: Date.now() - start }
    }

    try {
      // Phase 1: Upload WAL segments not yet in checkpoint
      const segments = this.wal.getSegments()
      const alreadySynced = new Set(this.lastCheckpoint?.walSegments ?? [])

      for (const segPath of segments) {
        const key = `wal/${segPath.split("/").pop()}`
        if (alreadySynced.has(key)) continue

        const content = readFileSync(segPath)
        const sha256 = createHash("sha256").update(content).digest("hex")

        await this.client.send(new PutObjectCommand({
          Bucket: this.bucket,
          Key: key,
          Body: content,
          ContentType: "application/x-ndjson",
          Metadata: { sha256 },
        }))

        filesUploaded++
        bytesUploaded += content.length
      }

      // Phase 2: Upload checkpoint only after all objects confirmed
      const walHead = await this.wal.getHeadEntryId()
      if (!walHead) {
        return { filesUploaded, bytesUploaded, duration: Date.now() - start }
      }

      const checkpoint: R2Checkpoint = {
        checkpointId: ulid(),
        timestamp: Date.now(),
        walSegments: segments.map((s) => `wal/${s.split("/").pop()}`),
        walHeadEntryId: walHead,
        objects: [], // Populated below
        bootEpoch: this.bootEpoch,
      }

      // Verify all referenced objects exist via HeadObject
      for (const segKey of checkpoint.walSegments) {
        try {
          const head = await this.client.send(new HeadObjectCommand({
            Bucket: this.bucket,
            Key: segKey,
          }))
          checkpoint.objects.push({
            key: segKey,
            sha256: head.Metadata?.sha256 ?? "",
            size: head.ContentLength ?? 0,
          })
        } catch {
          console.error(`[r2-sync] object verification failed for ${segKey}, aborting checkpoint`)
          return { filesUploaded, bytesUploaded, duration: Date.now() - start }
        }
      }

      // Write checkpoint
      await this.client.send(new PutObjectCommand({
        Bucket: this.bucket,
        Key: "checkpoint.json",
        Body: JSON.stringify(checkpoint, null, 2),
        ContentType: "application/json",
      }))

      this.lastCheckpoint = checkpoint
      filesUploaded++
      bytesUploaded += Buffer.byteLength(JSON.stringify(checkpoint))

      return { filesUploaded, bytesUploaded, duration: Date.now() - start }
    } catch (err) {
      console.error("[r2-sync] sync failed:", err)
      return { filesUploaded, bytesUploaded, duration: Date.now() - start }
    }
  }

  /** Restore latest state from R2. Returns checkpoint or undefined. */
  async restore(targetDir: string): Promise<R2Checkpoint | undefined> {
    if (!this.isConfigured) return undefined

    try {
      // Read checkpoint
      const cpResp = await this.client.send(new GetObjectCommand({
        Bucket: this.bucket,
        Key: "checkpoint.json",
      }))
      const cpBody = await cpResp.Body?.transformToString()
      if (!cpBody) return undefined

      const checkpoint = JSON.parse(cpBody) as R2Checkpoint

      // Download all WAL segments listed in checkpoint
      const walDir = join(targetDir, "wal")
      const { mkdirSync } = await import("node:fs")
      mkdirSync(walDir, { recursive: true })

      for (const obj of checkpoint.objects) {
        const resp = await this.client.send(new GetObjectCommand({
          Bucket: this.bucket,
          Key: obj.key,
        }))
        const body = await resp.Body?.transformToByteArray()
        if (!body) continue

        // Verify integrity
        const actual = createHash("sha256").update(body).digest("hex")
        if (obj.sha256 && actual !== obj.sha256) {
          console.error(`[r2-sync] integrity mismatch for ${obj.key}, skipping`)
          continue
        }

        const filename = obj.key.split("/").pop()!
        await writeFile(join(walDir, filename), body)
      }

      this.lastCheckpoint = checkpoint
      return checkpoint
    } catch (err) {
      console.error("[r2-sync] restore failed:", err)
      return undefined
    }
  }

  /** Get the last successful checkpoint. */
  getLastCheckpoint(): R2Checkpoint | undefined {
    return this.lastCheckpoint
  }

  /** Get synced WAL segment keys for pruning coordination. */
  getSyncedSegmentKeys(): string[] {
    return this.lastCheckpoint?.walSegments ?? []
  }
}
