import { Effect } from "effect";
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  watch,
  writeFileSync,
} from "node:fs";
import type { Dirent } from "node:fs";
import { join, normalize, relative, resolve } from "node:path";
import type { BotId } from "@bebots/domain";
import type { BotWorkspace, FileIndexRepository, FileIndexSearchHit } from "@bebots/application";
import { WorkspaceError } from "@bebots/application";
import type { RepositoryError } from "@bebots/application";

export interface CreateWorkspaceOptions {
  readonly root: string;
}

export function createNodeBotWorkspace(options: CreateWorkspaceOptions): BotWorkspace {
  const botsRoot = join(options.root, "bots");

  const assertSafeId = (botId: BotId): void => {
    if (
      botId.length === 0 ||
      botId === "." ||
      botId === ".." ||
      botId.includes("/") ||
      botId.includes("\\") ||
      botId.includes("\0")
    ) {
      throw new WorkspaceError("Unsafe bot id");
    }
  };

  const ensureDir = (path: string): void => {
    if (!existsSync(path)) {
      mkdirSync(path, { recursive: true });
    }
  };

  return {
    root: botsRoot,
    ensureHome: (botId: BotId) =>
      Effect.try({
        try: () => {
          assertSafeId(botId);
          const home = join(botsRoot, botId);
          ensureDir(home);
          ensureDir(join(home, ".opencode"));
          ensureDir(join(home, ".opencode", "skills"));
          ensureDir(join(home, "notes"));
          ensureDir(join(home, "memory"));
          ensureDir(join(home, "logs"));
          return home;
        },
        catch: (cause) => new WorkspaceError("Failed to create bot home directory", cause),
      }),
    writePersona: (botId: BotId, persona: string) =>
      Effect.try({
        try: () => {
          assertSafeId(botId);
          const home = join(botsRoot, botId);
          ensureDir(home);
          writeFileSync(join(home, "AGENTS.md"), persona, "utf8");
        },
        catch: (cause) => new WorkspaceError("Failed to write persona", cause),
      }),
    homePath: (botId: BotId) => {
      assertSafeId(botId);
      return join(botsRoot, botId);
    },
    // Bot deletion: remove the whole home directory (persona, notes, memory,
    // logs, .opencode). The id guard blocks traversal; the containment check
    // additionally guarantees the path resolves strictly inside the bots
    // root, so this can never take out the root itself. Both sides are
    // realpath'd — the root's own ancestors may contain symlinks (macOS
    // /var -> /private/var), which a lexical comparison would misread.
    removeHome: (botId: BotId) =>
      Effect.try({
        try: () => {
          assertSafeId(botId);
          const home = join(botsRoot, botId);
          if (!existsSync(home)) return;
          const realRoot = realpathSync(botsRoot);
          const realHome = realpathSync(home);
          if (realHome === realRoot || !(realHome + "/").startsWith(realRoot + "/")) {
            throw new WorkspaceError("Bot home escapes the workspace root");
          }
          rmSync(realHome, { recursive: true, force: true });
        },
        catch: (cause) =>
          cause instanceof WorkspaceError
            ? cause
            : new WorkspaceError("Failed to remove bot home directory", cause),
      }),
  };
}

// -----------------------------------------------------------------------------
// Workspace file indexer
//
// PLAN §5: the workspace service owns "the filesystem watcher that indexes
// direct file writes". PLAN §7: "Search over notes, memory, and logs via a
// filesystem-watcher-maintained DB index." Index storage goes through the
// FileIndexRepository (persistence layer); path validation happens here
// against the resolved workspace root — lexical checks alone are not
// considered sufficient (symlinks are resolved with realpath).
// -----------------------------------------------------------------------------

const INDEXED_SEGMENTS = new Set(["notes", "memory", "logs"]);

export interface WorkspaceIndexer {
  begin(): void;
  close(): void;
  search(
    query: string,
    botId?: BotId,
  ): Effect.Effect<readonly FileIndexSearchHit[], RepositoryError>;
}

export interface WorkspaceIndexerOptions {
  readonly workspace: BotWorkspace;
  readonly fileIndexRepo: FileIndexRepository;
  readonly onError?: (message: string, cause?: unknown) => void;
}

interface ClassifiedPath {
  readonly relPath: string;
  readonly botId: BotId;
  readonly kind: string;
}

function toPosix(segments: readonly string[]): string {
  return segments.join("/");
}

/** Classify a workspace-root-relative path; undefined when it should not be indexed. */
function classifyRel(segments: readonly string[]): ClassifiedPath | undefined {
  if (segments.length < 3) return undefined; // <botId>/<kind>/<file>
  const botId = segments[0];
  const kind = segments[1];
  if (!botId || !kind || !INDEXED_SEGMENTS.has(kind)) return undefined;
  if (botId === "." || botId === ".." || botId.includes("\\") || botId.includes("\0")) {
    return undefined;
  }
  return { relPath: toPosix(segments), botId: botId as BotId, kind };
}

export function createWorkspaceIndexer(options: WorkspaceIndexerOptions): WorkspaceIndexer {
  const { workspace, fileIndexRepo } = options;
  const report = options.onError ?? ((message: string) => console.error(message));
  const rootAbs = resolve(workspace.root);

  let rootReal: string | null = null;
  let watcher: ReturnType<typeof watch> | null = null;

  // Resolve an absolute changed path to a realpath that stays inside the bots
  // root and inside the owning bot's home. Returns undefined when the path
  // escapes (e.g. via symlink) or is otherwise unsafe.
  const safeRealPath = (abs: string): string | undefined => {
    if (rootReal === null) return undefined;
    let real: string;
    try {
      real = realpathSync(abs);
    } catch {
      return undefined;
    }
    if (!(
      real === rootReal ||
      (real.startsWith(rootReal) && real[rootReal.length] === "/") ||
      real.startsWith(rootReal + "/")
    )) {
      return undefined;
    }
    return real;
  };

  const relPosix = (realPath: string): string =>
    relative(rootReal ?? "", realPath)
      .split(/[\\/]/)
      .filter(Boolean)
      .join("/");

  const indexFile = (realFile: string): void => {
    const rel = relPosix(realFile);
    const segments = rel.split("/");
    const classified = classifyRel(segments);
    if (!classified) return;
    try {
      const st = statSync(realFile);
      if (!st.isFile()) return;
      const content = readFileSync(realFile, "utf8");
      void Effect.runPromise(
        fileIndexRepo.upsert({
          botId: classified.botId,
          path: rel,
          kind: classified.kind,
          content,
          updatedAt: Date.now(),
        }),
      ).catch((cause: unknown) => report("Failed to upsert file index entry", cause));
    } catch (cause) {
      report("Failed to index workspace file", cause);
    }
  };

  const handleChanged = (relWatched: string): void => {
    if (!rootReal) return;
    const normalized = normalize(relWatched);
    if (normalized === "" || normalized.startsWith("..") || normalized.includes("\0")) return;
    const abs = resolve(rootReal, normalized);
    const real = safeRealPath(abs);
    if (real === undefined) {
      // Does not resolve (deleted, raced, or symlink escaping the root — such
      // lexical paths were never indexed). Drop rows under the lexical path
      // when it is still inside the root: covers deleted files and the entire
      // subtree of deleted directories.
      const lexical = relPosix(resolve(rootReal, normalized));
      const segments = lexical.split("/");
      const classified = classifyRel(segments);
      if (classified) {
        void Effect.runPromise(fileIndexRepo.removeUnderPrefix(classified.botId, lexical)).catch(
          (cause: unknown) => report("Failed to prune file index", cause),
        );
      }
      return;
    }
    try {
      const st = statSync(real);
      if (st.isDirectory()) {
        // Directory touch/create events often report the directory itself;
        // index the files directly inside it.
        for (const entry of readdirSync(real, { withFileTypes: true })) {
          if (entry.isFile()) indexFile(join(real, entry.name));
        }
        return;
      }
      if (!st.isFile()) return;
      indexFile(real);
    } catch {
      // ignore races between watcher events and filesystem state
    }
  };

  /** Initial scan: index files that already exist on disk before watching. */
  const scanExisting = (): void => {
    if (rootReal === null) return;
    const walk = (absDir: string): void => {
      let entries: Dirent[];
      try {
        entries = readdirSync(absDir, { withFileTypes: true });
      } catch (cause) {
        report("Failed to list workspace directory for indexing", cause);
        return;
      }
      for (const entry of entries) {
        const abs = join(absDir, entry.name);
        if (entry.isSymbolicLink()) {
          const real = safeRealPath(abs);
          if (real === undefined) continue; // symlink escaping the root
          try {
            if (statSync(real).isDirectory()) walk(real);
            else indexFile(real);
          } catch {
            // ignore
          }
          continue;
        }
        if (entry.isDirectory()) {
          walk(abs);
        } else if (entry.isFile()) {
          indexFile(abs);
        }
      }
    };
    walk(rootReal);
  };

  return {
    begin: (): void => {
      try {
        mkdirSync(rootAbs, { recursive: true });
      } catch (cause) {
        report("Failed to create bots root", cause);
        return;
      }
      try {
        rootReal = realpathSync(rootAbs);
      } catch (cause) {
        report("Failed to resolve bots root", cause);
        return;
      }
      scanExisting();
      try {
        watcher = watch(rootAbs, { recursive: true }, (_event, filename) => {
          if (!filename) return;
          try {
            handleChanged(String(filename));
          } catch (cause) {
            report("File watcher handler failed", cause);
          }
        });
      } catch (cause) {
        report("Failed to start workspace watcher", cause);
      }
    },
    close: (): void => {
      try {
        watcher?.close();
      } catch (cause) {
        report("Failed to close workspace watcher", cause);
      }
      watcher = null;
    },
    search: (query: string, botId?: BotId) => fileIndexRepo.search(query, botId),
  };
}
