import { describe, expect, it } from "vitest";
import { discoverSessions } from "../src/adapters/claude/discover.js";
import {
  conversation,
  makeSidecar,
  root,
  writeLiveSession,
  writeTranscript,
} from "./helpers/sandbox.js";

const NOW = new Date("2026-09-12T12:00:00.000Z");
const daysAgo = (n: number) => new Date(NOW.getTime() - n * 86_400_000);

const A = "aaaaaaaa-0000-4000-8000-000000000001";
const B = "bbbbbbbb-0000-4000-8000-000000000002";

async function seed() {
  await writeTranscript({
    id: A,
    cwd: "/tmp/backend_api",
    mtime: daysAgo(1),
    records: conversation({
      id: A,
      cwd: "/tmp/backend_api",
      prompt: "fix the webhook",
      customTitle: "Stripe webhook",
    }),
  });
  await writeTranscript({
    id: B,
    cwd: "/tmp/frontend",
    mtime: daysAgo(28),
    records: conversation({ id: B, cwd: "/tmp/frontend", prompt: "checkout bug" }),
  });
}

describe("discoverSessions", () => {
  it("normalizes sessions and sorts them newest first", async () => {
    await seed();
    const { sessions } = await discoverSessions({ root: root(), now: NOW });

    expect(sessions.map((s) => s.id)).toEqual([A, B]);
    const [first] = sessions;
    expect(first?.title).toBe("Stripe webhook");
    expect(first?.projectName).toBe("backend_api");
    expect(first?.projectPath).toBe("/tmp/backend_api");
    expect(first?.agent).toBe("claude-code");
  });

  it("reads the project path from the transcript, not the directory name", async () => {
    // The directory name is a lossy encoding: "_" and "/" both become "-".
    await seed();
    const { sessions } = await discoverSessions({ root: root(), now: NOW });
    const session = sessions.find((s) => s.id === A);
    expect(session?.projectDirName).toBe("-tmp-backend-api");
    expect(session?.projectPath).toBe("/tmp/backend_api");
  });

  it("uses file mtime for updatedAt and the transcript for lastMessageAt", async () => {
    await seed();
    const { sessions } = await discoverSessions({ root: root(), now: NOW });
    const session = sessions.find((s) => s.id === A);
    expect(session?.updatedAt.getTime()).toBe(daysAgo(1).getTime());
    expect(session?.lastMessageAt?.toISOString()).toBe("2026-09-01T10:00:00.000Z");
  });

  it("marks sessions approaching the retention cutoff", async () => {
    await seed();
    const { sessions } = await discoverSessions({ root: root(), now: NOW });
    expect(sessions.find((s) => s.id === A)?.retention.status).toBe("ok");
    expect(sessions.find((s) => s.id === B)?.retention.status).toBe("at-risk");
  });

  it("detects a session open in another Claude process", async () => {
    await seed();
    await writeLiveSession(process.pid, A);
    const { sessions } = await discoverSessions({ root: root(), now: NOW });
    expect(sessions.find((s) => s.id === A)?.isLive).toBe(true);
    expect(sessions.find((s) => s.id === B)?.isLive).toBe(false);
  });

  it("notes sidecars and whether the project directory still exists", async () => {
    await seed();
    await makeSidecar("/tmp/backend_api", A, "subagents");
    const { sessions } = await discoverSessions({ root: root(), now: NOW });
    const session = sessions.find((s) => s.id === A);
    expect(session?.hasSubagents).toBe(true);
    expect(session?.hasToolResults).toBe(false);
    expect(session?.projectPathExists).toBe(false);
  });

  it("keeps going when one transcript is unreadable", async () => {
    await seed();
    await writeTranscript({ id: "cccccccc-0000-4000-8000-000000000003", cwd: "/tmp/broken", records: [] });
    const { sessions } = await discoverSessions({ root: root(), now: NOW });
    expect(sessions).toHaveLength(3);
    const broken = sessions.find((s) => s.projectDirName === "-tmp-broken");
    expect(broken?.parseWarnings.length).toBeGreaterThan(0);
  });
});

describe("liveness", () => {
  it("ignores a registry file whose process is gone", async () => {
    // A crash leaves the file behind until Claude's next launch. Treating that
    // as live would block resume, archive and restore on a session nobody holds.
    await seed();
    await writeLiveSession(999_999, A);
    const { sessions } = await discoverSessions({ root: root(), now: NOW });
    expect(sessions.find((s) => s.id === A)?.isLive).toBe(false);
  });

  it("counts a session whose process is running", async () => {
    await seed();
    await writeLiveSession(process.pid, A);
    const { sessions } = await discoverSessions({ root: root(), now: NOW });
    expect(sessions.find((s) => s.id === A)?.isLive).toBe(true);
  });
});
