import { mkdir, utimes, writeFile } from "node:fs/promises";
import { join } from "node:path";

/**
 * Builds a synthetic Claude projects tree. Fixtures are generated, never copied
 * from a real machine - PRD v0.2 section 48.1.
 */
export type RecordInput = Record<string, unknown>;

export function root(): string {
  const value = process.env["CLAUDE_CONFIG_DIR"];
  if (value === undefined) throw new Error("CLAUDE_CONFIG_DIR is not set; setup did not run");
  return value;
}

/** Encodes a path the way Claude does: every non-alphanumeric becomes "-". */
export function encodeProjectDir(cwd: string): string {
  return cwd.replace(/[^a-zA-Z0-9]/g, "-");
}

export async function writeTranscript(options: {
  id: string;
  cwd: string;
  records: RecordInput[];
  mtime?: Date;
  projectDirName?: string;
}): Promise<string> {
  const dirName = options.projectDirName ?? encodeProjectDir(options.cwd);
  const dir = join(root(), "projects", dirName);
  await mkdir(dir, { recursive: true });
  const path = join(dir, `${options.id}.jsonl`);
  await writeFile(path, options.records.map((r) => JSON.stringify(r)).join("\n") + "\n");
  if (options.mtime) await utimes(path, options.mtime, options.mtime);
  return path;
}

export async function writeRaw(
  projectDirName: string,
  fileName: string,
  body: string,
): Promise<string> {
  const dir = join(root(), "projects", projectDirName);
  await mkdir(dir, { recursive: true });
  const path = join(dir, fileName);
  await writeFile(path, body);
  return path;
}

export async function writeLiveSession(pid: number, sessionId: string): Promise<void> {
  const dir = join(root(), "sessions");
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, `${pid}.json`), JSON.stringify({ pid, sessionId, cwd: "/tmp/x" }));
}

export async function writeSettings(settings: unknown): Promise<void> {
  await mkdir(root(), { recursive: true });
  await writeFile(
    join(root(), "settings.json"),
    typeof settings === "string" ? settings : JSON.stringify(settings),
  );
}

export async function makeSidecar(cwd: string, id: string, kind: string): Promise<void> {
  await mkdir(join(root(), "projects", encodeProjectDir(cwd), id, kind), { recursive: true });
}

/** A minimal but realistic session: user turn, assistant turn, generated title. */
export function conversation(options: {
  id: string;
  cwd: string;
  prompt: string;
  version?: string;
  entrypoint?: string;
  at?: string;
  aiTitle?: string;
  customTitle?: string;
}): RecordInput[] {
  const at = options.at ?? "2026-09-01T10:00:00.000Z";
  const common = {
    sessionId: options.id,
    cwd: options.cwd,
    gitBranch: "main",
    version: options.version ?? "2.1.263",
    entrypoint: options.entrypoint ?? "cli",
    userType: "external",
    isSidechain: false,
  };
  const records: RecordInput[] = [
    { type: "mode", mode: "normal", sessionId: options.id },
    {
      ...common,
      type: "user",
      uuid: "u1",
      parentUuid: null,
      timestamp: at,
      message: { role: "user", content: options.prompt },
    },
    {
      ...common,
      type: "assistant",
      uuid: "a1",
      parentUuid: "u1",
      timestamp: at,
      message: { role: "assistant", content: [{ type: "text", text: "ok" }] },
    },
  ];
  if (options.aiTitle) {
    records.push({ type: "ai-title", aiTitle: options.aiTitle, sessionId: options.id });
  }
  if (options.customTitle) {
    records.push({ type: "custom-title", customTitle: options.customTitle, sessionId: options.id });
  }
  return records;
}

export type HistoryEntry = {
  display: string;
  project: string;
  sessionId?: string;
  timestamp: number;
};

/** Claude's prompt history, which is not swept and outlives transcripts. */
export async function writeHistory(entries: HistoryEntry[]): Promise<string> {
  const path = join(root(), "history.jsonl");
  await mkdir(root(), { recursive: true });
  await writeFile(
    path,
    entries.map((e) => JSON.stringify({ pastedContents: {}, ...e })).join("\n") + "\n",
  );
  return path;
}
