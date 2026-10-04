import { describe, expect, it } from "vitest";
import { readHistory, searchHistory } from "../src/adapters/claude/history.js";
import { snippet } from "../src/core/search/index.js";
import { classifyHistorical, toLostSessions } from "../src/core/session/lost.js";
import { root, writeHistory } from "./helpers/sandbox.js";

const A = "aaaaaaaa-0000-4000-8000-000000000001";
const B = "bbbbbbbb-0000-4000-8000-000000000002";
const DAY = 86_400_000;
const T0 = Date.parse("2026-01-10T10:00:00.000Z");

describe("readHistory", () => {
  it("groups prompts into sessions with a first and last seen", async () => {
    await writeHistory([
      { display: "fix the stripe webhook", project: "/tmp/api", sessionId: A, timestamp: T0 },
      { display: "now the refund path", project: "/tmp/api", sessionId: A, timestamp: T0 + DAY },
      { display: "unrelated work", project: "/tmp/web", sessionId: B, timestamp: T0 },
    ]);

    const scan = await readHistory(root());
    const a = scan.sessions.find((s) => s.id === A);
    expect(scan.sessions).toHaveLength(2);
    expect(a?.promptCount).toBe(2);
    expect(a?.projectPath).toBe("/tmp/api");
    expect(a?.firstSeen.getTime()).toBe(T0);
    expect(a?.lastSeen.getTime()).toBe(T0 + DAY);
  });

  it("counts records without a session id instead of inventing sessions", async () => {
    // Older Claude builds wrote no sessionId. Grouping these by project and
    // time would fabricate sessions that may never have existed (section 14).
    await writeHistory([
      { display: "ancient prompt", project: "/tmp/api", timestamp: T0 },
      { display: "another one", project: "/tmp/api", timestamp: T0 + 1000 },
      { display: "modern prompt", project: "/tmp/api", sessionId: A, timestamp: T0 + DAY },
    ]);

    const scan = await readHistory(root());
    expect(scan.sessions).toHaveLength(1);
    expect(scan.unattributed).toBe(2);
  });

  it("skips malformed lines rather than failing", async () => {
    const { appendFile } = await import("node:fs/promises");
    const path = await writeHistory([
      { display: "good", project: "/tmp/api", sessionId: A, timestamp: T0 },
    ]);
    await appendFile(path, "{ not json\n\n");
    expect((await readHistory(root())).sessions).toHaveLength(1);
  });

  it("returns nothing when there is no history file", async () => {
    const scan = await readHistory(root());
    expect(scan.sessions).toEqual([]);
    expect(scan.unattributed).toBe(0);
  });
});

describe("classifyHistorical", () => {
  const live = new Set([A]);
  const archived = new Set([B]);

  it("prefers resumable, then archived, then lost", () => {
    expect(classifyHistorical(A, live, archived)).toBe("resumable");
    expect(classifyHistorical(B, live, archived)).toBe("archived");
    expect(classifyHistorical("cccc", live, archived)).toBe("lost");
  });

  it("does not call an archived session lost", () => {
    // It is one `termstash restore` away; saying otherwise understates what
    // the user actually has.
    expect(classifyHistorical(B, new Set(), archived)).not.toBe("lost");
  });
});

describe("toLostSessions", () => {
  it("keeps only sessions with neither a transcript nor an archive", async () => {
    await writeHistory([
      { display: "live one", project: "/tmp/api", sessionId: A, timestamp: T0 },
      { display: "archived one", project: "/tmp/api", sessionId: B, timestamp: T0 },
      { display: "gone for good", project: "/tmp/api", sessionId: "cccc", timestamp: T0 },
    ]);
    const scan = await readHistory(root());
    const lost = toLostSessions(scan.sessions, new Set([A]), new Set([B]));

    expect(lost.map((s) => s.id)).toEqual(["cccc"]);
    expect(lost[0]?.resumable).toBe(false);
  });

  it("sorts most recently seen first", async () => {
    await writeHistory([
      { display: "old", project: "/tmp/api", sessionId: A, timestamp: T0 },
      { display: "new", project: "/tmp/api", sessionId: B, timestamp: T0 + DAY },
    ]);
    const scan = await readHistory(root());
    expect(toLostSessions(scan.sessions, new Set(), new Set()).map((s) => s.id)).toEqual([B, A]);
  });
});

describe("searchHistory", () => {
  it("finds work whose transcript is already gone", async () => {
    await writeHistory([
      { display: "debug the stripe signature check", project: "/tmp/api", sessionId: A, timestamp: T0 },
      { display: "nothing relevant", project: "/tmp/web", sessionId: B, timestamp: T0 },
    ]);

    const matches = await searchHistory(root(), "stripe", snippet);
    expect([...matches.keys()]).toEqual([A]);
    expect(matches.get(A)?.snippet).toContain("stripe");
    expect(matches.get(A)?.projectPath).toBe("/tmp/api");
  });

  it("counts repeat hits and keeps the latest sighting", async () => {
    await writeHistory([
      { display: "stripe once", project: "/tmp/api", sessionId: A, timestamp: T0 },
      { display: "stripe twice", project: "/tmp/api", sessionId: A, timestamp: T0 + DAY },
    ]);
    const match = (await searchHistory(root(), "stripe", snippet)).get(A);
    expect(match?.hits).toBe(2);
    expect(match?.lastSeen.getTime()).toBe(T0 + DAY);
  });

  it("is case-insensitive", async () => {
    await writeHistory([
      { display: "STRIPE in caps", project: "/tmp/api", sessionId: A, timestamp: T0 },
    ]);
    expect((await searchHistory(root(), "stripe", snippet)).size).toBe(1);
  });
});
