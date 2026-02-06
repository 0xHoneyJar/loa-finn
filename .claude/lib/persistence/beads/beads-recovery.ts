/**
 * Beads Recovery Handler — replays WAL entries through br CLI.
 *
 * Restores beads state from WAL after a crash by executing
 * br commands to replay recorded transitions.
 *
 * SECURITY: All user-controllable values are validated and escaped
 * before being used in shell commands to prevent command injection.
 *
 * @module .claude/lib/persistence/beads/beads-recovery
 */

import type { BeadsWALAdapter, BeadWALEntry } from "./beads-wal-adapter.js";
import { PersistenceError } from "../types.js";

// ── Security Constants ─────────────────────────────────────

const ALLOWED_LABEL_ACTIONS = new Set(["add", "remove"]);
const ALLOWED_DEP_ACTIONS = new Set(["add", "remove"]);
const ALLOWED_UPDATE_KEYS = new Set([
  "title",
  "description",
  "priority",
  "type",
  "status",
  "assignee",
  "due",
  "estimate",
]);
const ALLOWED_TYPES = new Set(["task", "bug", "feature", "epic", "story", "chore"]);
const BEAD_ID_PATTERN = /^[a-zA-Z0-9_-]+$/;
const LABEL_PATTERN = /^[a-zA-Z0-9_:-]+$/;
const MAX_STRING_LENGTH = 1024;

// ── Shell Escape ───────────────────────────────────────────

/**
 * Shell-escape a string by wrapping in single quotes.
 * Escapes embedded single quotes with '\'' idiom.
 */
function shellEscape(value: string): string {
  // Strip null bytes which can truncate strings in some shells
  const sanitized = value.replace(/\0/g, "");
  const truncated =
    sanitized.length > MAX_STRING_LENGTH ? sanitized.slice(0, MAX_STRING_LENGTH) : sanitized;
  return `'${truncated.replace(/'/g, "'\\''")}'`;
}

function validateBeadId(beadId: string): void {
  if (!beadId || !BEAD_ID_PATTERN.test(beadId) || beadId.length > 128) {
    throw new PersistenceError("BEADS_SHELL_ESCAPE", `Invalid beadId: ${beadId?.slice(0, 32)}`);
  }
}

// ── Types ──────────────────────────────────────────────────

/** Result of a recovery operation */
export interface RecoveryResult {
  success: boolean;
  entriesReplayed: number;
  beadsAffected: string[];
  durationMs: number;
  error?: string;
}

/** Configuration for BeadsRecoveryHandler */
export interface BeadsRecoveryConfig {
  beadsDir?: string;
  brCommand?: string;
  verbose?: boolean;
  skipSync?: boolean;
}

/**
 * Injectable command executor. Defaults to child_process.execFile (no shell).
 * Allows testing without actual command execution.
 */
export interface ICommandExecutor {
  execFile(
    binary: string,
    args: string[],
    options?: { cwd?: string; timeout?: number },
  ): Promise<{ stdout: string; stderr: string }>;
}

/**
 * @deprecated Use ICommandExecutor instead. Kept for backwards compatibility.
 */
export interface IShellExecutor {
  exec(
    command: string,
    options?: { cwd?: string; timeout?: number },
  ): Promise<{ stdout: string; stderr: string }>;
}

/**
 * Recovery handler for beads state.
 *
 * Checks if recovery is needed by comparing WAL timestamps with SQLite mtime,
 * then replays WAL entries through br commands.
 */
export class BeadsRecoveryHandler {
  private readonly adapter: BeadsWALAdapter;
  private readonly beadsDir: string;
  private readonly brCommand: string;
  private readonly verbose: boolean;
  private readonly skipSync: boolean;
  private readonly executor: ICommandExecutor;

  constructor(adapter: BeadsWALAdapter, config?: BeadsRecoveryConfig, executor?: ICommandExecutor | IShellExecutor) {
    this.adapter = adapter;
    this.beadsDir = config?.beadsDir ?? ".beads";
    this.brCommand = config?.brCommand ?? "br";
    this.verbose = config?.verbose ?? false;
    this.skipSync = config?.skipSync ?? false;

    // Accept either new ICommandExecutor or legacy IShellExecutor
    if (executor && "execFile" in executor) {
      this.executor = executor;
    } else if (executor && "exec" in executor) {
      // Wrap legacy IShellExecutor — still shell-based but behind the interface
      const legacy = executor as IShellExecutor;
      this.executor = {
        execFile: async (binary, args, opts) => {
          return legacy.exec(`${binary} ${args.map(a => shellEscape(a)).join(" ")}`, opts);
        },
      };
    } else {
      // Default executor uses child_process.execFile (no shell)
      this.executor = {
        execFile: async (binary, args, opts) => {
          const { execFile } = await import("child_process");
          const { promisify } = await import("util");
          return promisify(execFile)(binary, args, opts);
        },
      };
    }

    // Validate brCommand is safe (no path traversal, no shell metacharacters)
    if (!/^[a-zA-Z0-9._/-]+$/.test(this.brCommand) || /\.\./.test(this.brCommand)) {
      throw new PersistenceError(
        "BEADS_WHITELIST_VIOLATION",
        "Invalid brCommand: must not contain path traversal or shell metacharacters",
      );
    }
  }

  /**
   * Perform crash recovery by replaying WAL to SQLite.
   */
  async recover(): Promise<RecoveryResult> {
    const start = Date.now();
    const affectedBeads = new Set<string>();

    try {
      const entries = await this.adapter.replay();

      if (entries.length === 0) {
        return {
          success: true,
          entriesReplayed: 0,
          beadsAffected: [],
          durationMs: Date.now() - start,
        };
      }

      // Group entries by bead for efficient replay
      const byBead = new Map<string, BeadWALEntry[]>();
      for (const entry of entries) {
        const list = byBead.get(entry.beadId) ?? [];
        list.push(entry);
        byBead.set(entry.beadId, list);
      }

      for (const [beadId, beadEntries] of byBead) {
        try {
          validateBeadId(beadId);
          for (const entry of beadEntries) {
            await this.replayEntry(entry);
          }
          affectedBeads.add(beadId);
        } catch {
          // Continue with other beads
        }
      }

      // Final sync
      if (!this.skipSync) {
        try {
          await this.execBr(["sync", "--flush-only"]);
        } catch {
          // Non-fatal
        }
      }

      return {
        success: true,
        entriesReplayed: entries.length,
        beadsAffected: Array.from(affectedBeads),
        durationMs: Date.now() - start,
      };
    } catch {
      return {
        success: false,
        entriesReplayed: 0,
        beadsAffected: Array.from(affectedBeads),
        durationMs: Date.now() - start,
        error: "Recovery failed",
      };
    }
  }

  /**
   * Replay a single WAL entry through br CLI.
   */
  private async replayEntry(entry: BeadWALEntry): Promise<void> {
    const { operation, beadId, payload } = entry;
    validateBeadId(beadId);

    switch (operation) {
      case "create":
        await this.replayCreate(payload);
        break;
      case "update":
        await this.replayUpdate(beadId, payload);
        break;
      case "close":
        await this.replayClose(beadId, payload);
        break;
      case "reopen":
        await this.execBr(["reopen", beadId]);
        break;
      case "label":
        await this.replayLabel(beadId, payload);
        break;
      case "comment":
        await this.replayComment(beadId, payload);
        break;
      case "dep":
        await this.replayDep(beadId, payload);
        break;
    }
  }

  private async replayCreate(payload: Record<string, unknown>): Promise<void> {
    const title = String(payload.title ?? "Untitled");
    const rawType = String(payload.type ?? "task");
    const type = ALLOWED_TYPES.has(rawType) ? rawType : "task";
    const rawPriority = Number(payload.priority);
    const priority =
      Number.isInteger(rawPriority) && rawPriority >= 0 && rawPriority <= 10 ? rawPriority : 2;

    const args = ["create", title, "--type", type, "--priority", String(priority)];
    if (payload.description) {
      args.push("--description", String(payload.description));
    }
    await this.execBr(args);
  }

  private async replayUpdate(beadId: string, payload: Record<string, unknown>): Promise<void> {
    const args = ["update", beadId];
    for (const [key, value] of Object.entries(payload)) {
      if (value !== undefined && value !== null && ALLOWED_UPDATE_KEYS.has(key)) {
        args.push(`--${key}`, String(value));
      }
    }
    if (args.length > 2) {
      await this.execBr(args);
    }
  }

  private async replayClose(beadId: string, payload: Record<string, unknown>): Promise<void> {
    const args = ["close", beadId];
    if (payload.reason) {
      args.push("--reason", String(payload.reason));
    }
    await this.execBr(args);
  }

  private async replayLabel(beadId: string, payload: Record<string, unknown>): Promise<void> {
    const rawAction = String(payload.action ?? "add");
    const action = ALLOWED_LABEL_ACTIONS.has(rawAction) ? rawAction : "add";

    const safeLabels: string[] = [];
    if (Array.isArray(payload.labels)) {
      for (const l of payload.labels) {
        const labelStr = String(l);
        if (LABEL_PATTERN.test(labelStr)) safeLabels.push(labelStr);
      }
    } else {
      const labelStr = String(payload.labels ?? payload.label ?? "");
      if (LABEL_PATTERN.test(labelStr)) safeLabels.push(labelStr);
    }

    if (safeLabels.length > 0) {
      await this.execBr(["label", action, beadId, ...safeLabels]);
    }
  }

  private async replayComment(beadId: string, payload: Record<string, unknown>): Promise<void> {
    const text = String(payload.text ?? "");
    if (text) {
      await this.execBr(["comments", "add", beadId, text]);
    }
  }

  private async replayDep(beadId: string, payload: Record<string, unknown>): Promise<void> {
    const rawAction = String(payload.action ?? "add");
    const action = ALLOWED_DEP_ACTIONS.has(rawAction) ? rawAction : "add";
    const target = payload.target ?? payload.dependency;

    if (target) {
      const targetStr = String(target);
      if (BEAD_ID_PATTERN.test(targetStr)) {
        await this.execBr(["dep", action, beadId, targetStr]);
      }
    }
  }

  private async execBr(args: string[]): Promise<string> {
    const { stdout } = await this.executor.execFile(this.brCommand, args, {
      cwd: this.beadsDir,
      timeout: 30000,
    });
    return stdout;
  }
}
