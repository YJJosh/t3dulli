import { describe, expect, it } from "vite-plus/test";

import { summarizeMultiRepoStatus } from "./multiRepoStatus.ts";

const source = (headRef: string | null, paths: ReadonlyArray<string>) => ({
  id: "branch-range",
  kind: "branch-range" as const,
  title: "Changes",
  baseRef: null,
  headRef,
  diff: "",
  diffHash: "hash",
  truncated: false,
  files: paths.map((path) => ({ path, previousPath: null, additions: 2, deletions: 1 })),
});

describe("summarizeMultiRepoStatus", () => {
  it("counts each file for the deepest member folder that holds it", () => {
    const status = summarizeMultiRepoStatus(
      ["apps", "apps/web", "docs"],
      [source("feature", ["apps/web/a.ts", "apps/b.ts", "apps/web/c.ts"])],
    );
    expect(status).toEqual({
      branch: "feature",
      changedMembers: 2,
      members: [
        { path: "apps", files: 1, additions: 2, deletions: 1 },
        { path: "apps/web", files: 2, additions: 4, deletions: 2 },
        { path: "docs", files: 0, additions: 0, deletions: 0 },
      ],
    });
  });

  it("tells members on different branches apart from a review still loading", () => {
    expect(summarizeMultiRepoStatus(["api"], [source(null, [])]).branch).toBeNull();
    expect(summarizeMultiRepoStatus(["api"], undefined).branch).toBeUndefined();
  });
});
