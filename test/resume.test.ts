import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Discovery } from "../src/adapters/claude/discover.js";
import type { LaunchRequest } from "../src/adapters/claude/resume.js";
import type { Session } from "../src/core/session/types.js";
import { parseArgs } from "../src/cli/args.js";
import { resumeCommand } from "../src/cli/resume.js";

const NOW = new Date("2026-09-12T12:00:00.000Z");
const A = "7f31a2aa-0000-4000-8000-000000000001";
const B = "7f31a2bb-0000-4000-8000-000000000002";
const C = "91bc22cc-0000-4000-8000-000000000003";

function session(id: string, overrides: Partial<Session> = {}): Session {
  return {
    id,
    agent: "claude-code",
    agentVersions: ["2.1.263"],
    sourcePath: `/sandbox/projects/-tmp-repo/${id}.jsonl`,
    projectDirName: "-tmp-repo",
    projectPath: "/tmp/repo",
    projectName: "repo",
    projectPathExists: true,
    updatedAt: NOW,
    sizeBytes: 1024,
    origin: "interactive",
    isLive: false,
    hasSubagents: false,
    hasToolResults: false,
    retention: { status: "ok", ageDays: 0, estimatedDaysLeft: 30 },
    parseWarnings: [],
    ...overrides,
  };
}

function discovery(sessions: Session[]): () => Promise<Discovery> {
  return async () => ({ sessions, artifacts: [], unreadable: [] });
}

let errors: string[];

beforeEach(() => {
  errors = [];
  vi.spyOn(process.stderr, "write").mockImplementation((chunk) => {
    errors.push(String(chunk));
    return true;
  });
});

const stderr = () => errors.join("");

describe("resumeCommand", () => {
  it("asks for an id when none is given", async () => {
    const code = await resumeCommand(parseArgs(["resume"]), {
      discover: discovery([session(A)]),
      now: NOW,
    });
    expect(code).toBe(1);
    expect(stderr()).toMatch(/needs a session id/);
  });

  it("refuses an unknown id and does not launch", async () => {
    const launcher = vi.fn();
    const code = await resumeCommand(parseArgs(["resume", "zzzzzz"]), {
      discover: discovery([session(A)]),
      launcher,
      now: NOW,
    });
    expect(code).toBe(1);
    expect(launcher).not.toHaveBeenCalled();
    expect(stderr()).toMatch(/No session matches/);
  });

  it("lists candidates instead of guessing when a prefix is ambiguous", async () => {
    const launcher = vi.fn();
    const code = await resumeCommand(parseArgs(["resume", "7f31a2"]), {
      discover: discovery([session(A), session(B), session(C)]),
      launcher,
      now: NOW,
    });
    expect(code).toBe(1);
    expect(launcher).not.toHaveBeenCalled();
    expect(stderr()).toMatch(/matches 2 sessions/);
  });

  it("launches Claude with the session's own project directory", async () => {
    const seen: LaunchRequest[] = [];
    const code = await resumeCommand(parseArgs(["resume", A]), {
      discover: discovery([session(A)]),
      launcher: async (request) => {
        seen.push(request);
        return { code: 0 };
      },
      now: NOW,
    });
    expect(code).toBe(0);
    expect(seen).toEqual([{ sessionId: A, cwd: "/tmp/repo" }]);
  });

  it("passes Claude's exit code through", async () => {
    const code = await resumeCommand(parseArgs(["resume", A]), {
      discover: discovery([session(A)]),
      launcher: async () => ({ code: 42 }),
      now: NOW,
    });
    expect(code).toBe(42);
  });

  it("refuses a session already open in another Claude process", async () => {
    const launcher = vi.fn();
    const code = await resumeCommand(parseArgs(["resume", A]), {
      discover: discovery([session(A, { isLive: true })]),
      launcher,
      now: NOW,
    });
    expect(code).toBe(1);
    expect(launcher).not.toHaveBeenCalled();
    expect(stderr()).toMatch(/currently active in another Claude process/);
  });

  it("refuses rather than guessing when the project directory is gone", async () => {
    const launcher = vi.fn();
    const code = await resumeCommand(parseArgs(["resume", A]), {
      discover: discovery([
        session(A, { projectPath: "/gone/backend", projectPathExists: false }),
      ]),
      launcher,
      now: NOW,
    });
    expect(code).toBe(1);
    expect(launcher).not.toHaveBeenCalled();
    expect(stderr()).toMatch(/cannot find the original project directory/);
    expect(stderr()).toMatch(/--cwd/);
  });

  it("refuses when the session never recorded a cwd", async () => {
    const bare = session(A);
    delete (bare as { projectPath?: string }).projectPath;
    delete (bare as { projectPathExists?: boolean }).projectPathExists;
    const code = await resumeCommand(parseArgs(["resume", A]), {
      discover: discovery([bare]),
      launcher: vi.fn(),
      now: NOW,
    });
    expect(code).toBe(1);
    expect(stderr()).toMatch(/cannot find the original project directory/);
  });

  it("rejects a --cwd that does not exist", async () => {
    const launcher = vi.fn();
    const code = await resumeCommand(parseArgs(["resume", A, "--cwd", "/definitely/not/here"]), {
      discover: discovery([session(A)]),
      launcher,
      now: NOW,
    });
    expect(code).toBe(1);
    expect(launcher).not.toHaveBeenCalled();
    expect(stderr()).toMatch(/must point to an existing directory/);
  });

  it("uses an explicit --cwd over the recorded one", async () => {
    const real = mkdtempSync(join(tmpdir(), "termstash-cwd-"));
    const seen: LaunchRequest[] = [];
    const code = await resumeCommand(parseArgs(["resume", A, "--cwd", real]), {
      discover: discovery([session(A, { projectPath: "/gone", projectPathExists: false })]),
      launcher: async (request) => {
        seen.push(request);
        return { code: 0 };
      },
      now: NOW,
    });
    expect(code).toBe(0);
    expect(seen[0]?.cwd).toBe(real);
  });

  it("never silently falls back to the current directory", async () => {
    const launcher = vi.fn();
    await resumeCommand(parseArgs(["resume", A]), {
      discover: discovery([session(A, { projectPath: "/gone", projectPathExists: false })]),
      launcher,
      now: NOW,
    });
    expect(launcher).not.toHaveBeenCalled();
    expect(stderr()).not.toMatch(process.cwd());
  });
});

describe("ambiguous candidate list", () => {
  it("truncates long titles so the list stays readable", async () => {
    const long = "x".repeat(200);
    await resumeCommand(parseArgs(["resume", "7f31a2"]), {
      discover: discovery([session(A, { title: long }), session(B, { title: long })]),
      launcher: vi.fn(),
      now: NOW,
    });
    for (const line of stderr().split("\n")) {
      expect(line.length).toBeLessThan(120);
    }
  });
});

describe("resume without a terminal", () => {
  it("refuses, launches nothing, and gives the command to run in one", async () => {
    // The suite itself runs without a TTY, which is exactly the situation an
    // agent or a script is in. No launcher is injected, so this is the path
    // that would otherwise spawn the real `claude --resume` into a pipe.
    const project = mkdtempSync(join(tmpdir(), "termstash-resume-"));
    const code = await resumeCommand(parseArgs(["resume", "91bc22"]), {
      discover: discovery([session(C, { projectPath: project })]),
      now: NOW,
    });
    // The refusal is returned before the launcher is reached, so this message
    // and a launch cannot both happen. (ESM will not let `spawn` be spied on.)
    expect(code).toBe(1);
    expect(stderr()).toContain("Nothing was launched.");
    expect(stderr()).toMatch(/has none - it is\nrunning inside an agent/);
    expect(stderr()).toContain(`--resume ${C}`);
    expect(stderr()).not.toContain("�");
  });
});
