/**
 * PRD v0.2 sections 22 and 23.
 *
 * The classes are the point. "Confirmed" means the filesystem says so;
 * "potential" means we noticed something we cannot prove is wrong; and
 * "informational" is neither. Telling a user their data is broken on a hunch
 * is the failure this product cannot afford.
 */
export type FindingClass = "confirmed" | "potential" | "informational";

export type FindingSection = "Sessions" | "Retention" | "Protection" | "Filesystem" | "Archives";

export type Finding = {
  section: FindingSection;
  class: FindingClass;
  code: string;
  summary: string;
  /** Concrete paths or ids, shown with --details. */
  details: string[];
};

export type DoctorReport = {
  sessionCount: number;
  archiveCount: number;
  /**
   * True when at least one location could not be read.
   *
   * `sessionCount` is then a floor, not a count, and every finding that
   * reasons from a session's absence is a guess. Carried on the report rather
   * than re-derived from the findings so a reader cannot forget to ask.
   */
  scanPartial: boolean;
  /**
   * The two facts a first run should lead with, as numbers rather than prose.
   *
   * They were already findings - and both informational, printed as grey
   * dots below three red warnings about directories Claude leaves behind. On
   * a real machine the first screen led with 68 orphaned `session-env`
   * directories and put "at least 1878 sessions are no longer resumable" in
   * the middle of a list. The reader's attention went to the least useful
   * line on the page.
   */
  headline: {
    /** Sessions Claude's history proves existed, with no transcript left. A floor. */
    lost: number;
    atRisk: number;
    /** At-risk sessions TermStash holds no archive of: what a pin would change. */
    atRiskWithoutArchive: number;
  };
  findings: Finding[];
};
