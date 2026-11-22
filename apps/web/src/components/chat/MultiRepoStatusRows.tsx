import type { EnvironmentId } from "@t3tools/contracts";
import { formatDiffCount } from "@t3tools/client-runtime/diff-count";
import { summarizeMultiRepoStatus } from "@t3tools/client-runtime/state/multi-repo-status";
import { T, useGT } from "gt-react";
import { FolderGitIcon, GitBranchIcon } from "lucide-react";

import { cn } from "~/lib/utils";
import { useEnvironmentQuery } from "~/state/query";
import { reviewEnvironment } from "~/state/review";
import { revisionedQuery } from "~/state/revisionedQuery";
import { ThreadDetailsControl } from "./ThreadDetailsControl";
import {
  THREAD_DETAILS_PANEL_ICON_CLASS,
  THREAD_DETAILS_PANEL_LOCKED_ROW_CLASS,
} from "./threadDetailsPanelStyles";

/**
 * A multi-repo thread's branch and each member's changes against its own base. Read from the
 * group's review only while the panel shows it, so it adds no background polling.
 */
export function MultiRepoStatusRows(props: {
  environmentId: EnvironmentId;
  cwd: string;
  members: ReadonlyArray<string>;
  workspaceMutationId: string | null;
  showBranch: boolean;
  showChanges: boolean;
  onOpenChanges?: (() => void) | undefined;
}) {
  const gt = useGT();
  const review = useEnvironmentQuery(
    revisionedQuery(
      reviewEnvironment.diffPreview({
        environmentId: props.environmentId,
        input: { cwd: props.cwd, sourceKind: "branch-range", metadataOnly: true },
      }),
      props.workspaceMutationId ?? undefined,
    ),
  );
  const status = summarizeMultiRepoStatus(props.members, review.data?.sources);
  return (
    <>
      {props.showBranch && status.branch !== undefined ? (
        <div className={cn(THREAD_DETAILS_PANEL_LOCKED_ROW_CLASS, "flex items-center")}>
          <GitBranchIcon className={THREAD_DETAILS_PANEL_ICON_CLASS} aria-hidden />
          <span className="min-w-0 truncate">
            {status.branch ?? gt("Repositories are on different branches")}
          </span>
        </div>
      ) : null}
      {props.showChanges
        ? status.members.map((member) => (
            <ThreadDetailsControl
              key={member.path}
              type="button"
              variant="ghost"
              size="sm"
              part="row"
              disabled={!props.onOpenChanges}
              onClick={props.onOpenChanges}
            >
              <FolderGitIcon className={THREAD_DETAILS_PANEL_ICON_CLASS} aria-hidden />
              <span className="flex min-w-0 flex-1 items-baseline gap-1.5">
                <span className="min-w-0 truncate">{member.path}</span>
                {member.files === 0 ? (
                  <span className="ml-auto shrink-0 ps-2 font-normal text-muted-foreground">
                    <T>No changes</T>
                  </span>
                ) : (
                  <span className="ml-auto flex shrink-0 items-baseline gap-2 ps-2 font-mono tabular-nums">
                    <span className="text-diff-addition-foreground">
                      +{formatDiffCount(member.additions)}
                    </span>
                    <span className="text-diff-deletion-foreground">
                      -{formatDiffCount(member.deletions)}
                    </span>
                  </span>
                )}
              </span>
            </ThreadDetailsControl>
          ))
        : null}
    </>
  );
}
