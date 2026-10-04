import { discoverSessions } from "../adapters/claude/discover.js";
import type { Discovery } from "../adapters/claude/discover.js";
import { readHistory } from "../adapters/claude/history.js";
import { findOrphans } from "../adapters/claude/orphans.js";
import { join } from "node:path";
import { claudeRoot, projectsDir } from "../adapters/claude/paths.js";
import { isAsIntended } from "./hook-install.js";
import { listArchives } from "../core/archive/store.js";
import { runDoctor } from "../core/doctor/run.js";
import { toLostSessions } from "../core/session/lost.js";
import type { DoctorReport, Finding, FindingSection } from "../core/doctor/types.js";
import { termstashRoot } from "../core/paths.js";
import type { ParsedArgs } from "./args.js";
import { flagBool } from "./args.js";
import { jsonOut, out, safe, safeText } from "./format.js";

const SECTIONS: FindingSection[] = ["Sessions", "Retention", "Protection", "Filesystem", "Archives"];

const GLYPH: Record<Finding["class"], string> = {
  confirmed: "⚠",
  potential: "?",
  informational: "·",
};

export type DoctorDeps = {
  discover?: () => Promise<Discovery>;
  claude?: string;
  root?: string;
  now?: Date;
};

export async function doctorCommand(args: ParsedArgs, deps: DoctorDeps = {}): Promise<number> {
  const now = deps.now ?? new Date();
  const claude = deps.claude ?? claudeRoot();
  const root = deps.root ?? termstashRoot();

  const discover = deps.discover ?? (() => discoverSessions({ root: claude, now }));
  const discovery = await discover();
  // A session with a live transcript is not an orphan, whatever else is true.
  const orphans = await findOrphans(claude, new Set(discovery.sessions.map((s) => s.id)));

  const history = await readHistory(claude);
  const liveIds = new Set(discovery.sessions.map((s) => s.id));
  const archivedIds = new Set((await listArchives(root)).map((a) => a.sessionId));
  const lost = toLostSessions(history.sessions, liveIds, archivedIds);

  const report = await runDoctor({
    sessions: discovery.sessions,
    artifacts: discovery.artifacts,
    unreadable: discovery.unreadable,
    orphans,
    termstashRoot: root,
    claudeProjects: projectsDir(claude),
    hookInstalled: await isAsIntended(join(claude, "settings.json"), false),
    history: { lost, unattributed: history.unattributed },
  });

  if (flagBool(args, "json")) {
    jsonOut(report);
    return exitCode(report);
  }

  render(report, flagBool(args, "details"));
  return exitCode(report);
}

function render(report: DoctorReport, details: boolean): void {
  out("\nTermStash Doctor\n\n");
  // "0 resumable sessions" after one unreadable directory is a sentence about
  // this tool's access, not about the user's data, and it read as the latter.
  const noun = safe`resumable Claude session${report.sessionCount === 1 ? "" : "s"}`;
  out(
    report.scanPartial
      ? safe`  ${report.sessionCount} ${noun} found — some locations could not be read\n`
      : safe`  ${report.sessionCount} ${noun}\n`,
  );
  out(safe`  ${report.archiveCount} archive${report.archiveCount === 1 ? "" : "s"}\n`);

  if (report.findings.length === 0) {
    out("\n  ✓ Nothing to report.\n\n");
    return;
  }

  for (const section of SECTIONS) {
    const findings = report.findings.filter((f) => f.section === section);
    if (findings.length === 0) continue;

    out(safe`\n${section}\n`);
    for (const finding of findings) {
      // The summary embeds paths too - "could not read <path>" - so it needs
      // the same treatment as the details, and it prints either way.
      out(safe`  ${GLYPH[finding.class]} ${safeText(finding.summary)}\n`);
      if (!details) continue;
      // Details are paths and ids read off the filesystem. Nothing should be
      // able to name a directory in a way that acts on the reader's terminal.
      for (const line of finding.details.slice(0, 20)) out(safe`      ${safeText(line)}\n`);
      if (finding.details.length > 20) {
        out(safe`      … and ${finding.details.length - 20} more\n`);
      }
    }
  }

  const confirmed = report.findings.filter((f) => f.class === "confirmed").length;
  const potential = report.findings.filter((f) => f.class === "potential").length;

  out("\n");
  if (confirmed > 0 || potential > 0) {
    // The classes carry the weight: "confirmed" is what the filesystem says,
    // "potential" is only what TermStash noticed (PRD v0.2 section 23).
    out(
      safe`  ⚠ ${confirmed} confirmed   ? ${potential} potential   ` +
        safe`· ${report.findings.length - confirmed - potential} informational\n`,
    );
  }
  if (!details) out("  Run 'termstash doctor --details' to see the paths.\n");
  out("\n");
}

/** Only a confirmed problem is worth a non-zero exit; noticing is not failing. */
function exitCode(report: DoctorReport): number {
  return report.findings.some((f) => f.class === "confirmed") ? 1 : 0;
}
