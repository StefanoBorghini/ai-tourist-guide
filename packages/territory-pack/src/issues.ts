export type IssueLevel = "error" | "warning";

export interface PackIssue {
  level: IssueLevel;
  code: string;
  packId: string;
  /** File del pack, relativo alla sua cartella. */
  file?: string;
  /** Elemento coinvolto (id di luogo, affermazione, unità…). */
  item?: string;
  message: string;
}

export class IssueCollector {
  readonly issues: PackIssue[] = [];

  error(issue: Omit<PackIssue, "level">): void {
    this.issues.push({ level: "error", ...issue });
  }

  warning(issue: Omit<PackIssue, "level">): void {
    this.issues.push({ level: "warning", ...issue });
  }
}

export function hasErrors(issues: readonly PackIssue[]): boolean {
  return issues.some((i) => i.level === "error");
}
