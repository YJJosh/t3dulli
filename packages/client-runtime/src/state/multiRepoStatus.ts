import type { ReviewDiffPreviewSource } from "@t3tools/contracts";

export interface MultiRepoMemberStatus {
  readonly path: string;
  readonly files: number;
  readonly additions: number;
  readonly deletions: number;
}

export interface MultiRepoStatus {
  /** The branch every member is on; null when they differ, undefined before the review loads. */
  readonly branch: string | null | undefined;
  readonly members: ReadonlyArray<MultiRepoMemberStatus>;
  readonly changedMembers: number;
}

/**
 * Each member's changes against its own base, from a multi-repo group's review, whose paths
 * start with the member's folder.
 */
export function summarizeMultiRepoStatus(
  members: ReadonlyArray<string>,
  sources: ReadonlyArray<ReviewDiffPreviewSource> | undefined,
): MultiRepoStatus {
  const changes = sources?.find((source) => source.kind === "branch-range");
  // Two-level members like `apps/web` sit beside `apps`, so the longest folder wins.
  const byLength = [...members].sort((left, right) => right.length - left.length);
  const totals = new Map(members.map((path) => [path, { files: 0, additions: 0, deletions: 0 }]));
  for (const file of changes?.files ?? []) {
    const member = byLength.find((path) => file.path.startsWith(`${path}/`));
    const total = member === undefined ? undefined : totals.get(member);
    if (total === undefined) continue;
    total.files += 1;
    total.additions += file.additions;
    total.deletions += file.deletions;
  }
  const statuses = members.map((path) => ({ path, ...totals.get(path)! }));
  return {
    branch: changes === undefined ? undefined : changes.headRef,
    members: statuses,
    changedMembers: statuses.filter((status) => status.files > 0).length,
  };
}
