import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";

import {
  GitCommandError,
  VcsRepositoryDetectionError,
  VcsUnsupportedOperationError,
  type ReviewDiffFileStat,
  type ReviewDiffPreviewSource,
  type ReviewBranchCommitsInput,
  type ReviewBranchCommitsResult,
  type ReviewDiffFileContentsInput,
  type ReviewDiffFileContentsResult,
  type ReviewDiffPreviewError,
  type ReviewDiffPreviewInput,
  type ReviewDiffPreviewResult,
} from "@t3tools/contracts";

import * as ServerConfig from "../config.ts";
import * as GitVcsDriver from "../vcs/GitVcsDriver.ts";
import * as MultiRepoWorkspaces from "../vcs/MultiRepoWorkspaces.ts";
import * as VcsDriverRegistry from "../vcs/VcsDriverRegistry.ts";
import * as KnownWorkspaces from "../workspace/KnownWorkspaces.ts";

const GROUP_CONCURRENCY = 4;
const GROUP_BRANCH_COMMIT_LIMIT = 100;
// About a repository's own patch budget, in characters rather than bytes.
const GROUP_REVIEW_PATCH_MAX_LENGTH = 120_000;

const WORKSPACE_BOUND_SUBJECTS = {
  "ReviewService.getBranchCommits": "commit list",
  "ReviewService.getDiffPreview": "diff preview",
  "ReviewService.getDiffFileContents": "diff file contents",
} as const;

export class ReviewService extends Context.Service<
  ReviewService,
  {
    readonly getBranchCommits: (
      input: ReviewBranchCommitsInput,
    ) => Effect.Effect<ReviewBranchCommitsResult, ReviewDiffPreviewError>;
    readonly getDiffPreview: (
      input: ReviewDiffPreviewInput,
    ) => Effect.Effect<ReviewDiffPreviewResult, ReviewDiffPreviewError>;
    readonly getDiffFileContents: (
      input: ReviewDiffFileContentsInput,
    ) => Effect.Effect<ReviewDiffFileContentsResult, ReviewDiffPreviewError>;
  }
>()("t3/review/ReviewService") {}

/** @public */
export const make = Effect.gen(function* () {
  const config = yield* ServerConfig.ServerConfig;
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const vcsRegistry = yield* VcsDriverRegistry.VcsDriverRegistry;
  const git = yield* GitVcsDriver.GitVcsDriver;
  const knownWorkspaces = yield* KnownWorkspaces.KnownWorkspaces;
  const multiRepo = yield* Effect.serviceOption(MultiRepoWorkspaces.MultiRepoWorkspaces);

  const canonicalizePath = (value: string) => {
    const resolvedPath = path.resolve(value);
    return fileSystem.realPath(resolvedPath).pipe(
      Effect.catchTags({
        PlatformError: (cause) =>
          cause.reason._tag === "NotFound"
            ? Effect.succeed(resolvedPath)
            : Effect.fail(
                new VcsRepositoryDetectionError({
                  operation: "ReviewService.assertWorkspaceBoundCwd.canonicalizePath",
                  cwd: resolvedPath,
                  detail: "Failed to resolve a path while validating the review workspace.",
                  cause,
                }),
              ),
      }),
    );
  };

  const assertWorkspaceBoundCwd = Effect.fn("ReviewService.assertWorkspaceBoundCwd")(function* (
    operation: keyof typeof WORKSPACE_BOUND_SUBJECTS,
    cwd: string,
  ) {
    const [candidate, workspaceRoot] = yield* Effect.all([
      canonicalizePath(cwd),
      canonicalizePath(config.cwd),
    ]);
    if (
      KnownWorkspaces.isWithinRoot(path, candidate, workspaceRoot) ||
      (yield* knownWorkspaces.contains(candidate))
    ) {
      return;
    }

    return yield* new VcsRepositoryDetectionError({
      operation,
      cwd,
      detail: `Review ${WORKSPACE_BOUND_SUBJECTS[operation]} cwd must stay within the configured workspace root.`,
    });
  });

  // A multi-repo group or workspace has no repository of its own. Its review shows every
  // member at once, with each member's paths under its folder, as checkpoint diffs do.
  const groupMembers = (cwd: string) =>
    Option.isSome(multiRepo) ? multiRepo.value.members(cwd) : Effect.succeed(null);

  /** The member that holds a group path, and that path inside it. */
  const memberForPath = (members: ReadonlyArray<string>, groupPath: string) => {
    const member = members
      .filter((candidate) => groupPath.startsWith(`${candidate}/`))
      .toSorted((left, right) => right.length - left.length)[0];
    return member === undefined ? null : { member, path: groupPath.slice(member.length + 1) };
  };

  const noSuchMember = (operation: string, cwd: string, detail: string) =>
    new GitCommandError({ operation, command: "git", cwd, detail });

  const memberWithCommit = Effect.fn("ReviewService.memberWithCommit")(function* (
    cwd: string,
    members: ReadonlyArray<string>,
    sha: string,
  ) {
    for (const member of members) {
      const result = yield* git.execute({
        operation: "ReviewService.memberWithCommit",
        cwd: path.join(cwd, member),
        args: ["cat-file", "-e", `${sha}^{commit}`],
        allowNonZeroExit: true,
      });
      if (result.exitCode === 0) return member;
    }
    return yield* noSuchMember(
      "ReviewService.memberWithCommit",
      cwd,
      "Selected commit is invalid or no longer available.",
    );
  });

  const sameOrNull = (values: ReadonlyArray<string | null>) =>
    values.length > 0 && values.every((value) => value === values[0]) ? values[0]! : null;

  const mergeGroupSources = (
    perMember: ReadonlyArray<ReadonlyArray<ReviewDiffPreviewSource>>,
  ): ReviewDiffPreviewSource[] => {
    const kinds = [...new Set(perMember.flatMap((sources) => sources.map((s) => s.kind)))];
    return kinds.map((kind) => {
      const sources = perMember.flatMap((memberSources) =>
        memberSources.filter((source) => source.kind === kind),
      );
      const baseRef = sameOrNull(sources.map((source) => source.baseRef));
      let diff = "";
      let truncated = sources.some((source) => source.truncated);
      // The combined patch keeps one member's budget, so a group answer stays as large as a repository's.
      for (const source of sources) {
        if (diff.length + source.diff.length > GROUP_REVIEW_PATCH_MAX_LENGTH) {
          truncated = true;
          break;
        }
        diff += source.diff;
      }
      const files = sources.every((source) => source.files !== undefined)
        ? sources.flatMap((source): ReadonlyArray<ReviewDiffFileStat> => source.files ?? [])
        : undefined;
      return {
        id: kind,
        kind,
        title:
          kind === "working-tree"
            ? "Uncommitted"
            : baseRef === null
              ? "Changes"
              : `Changes vs ${baseRef}`,
        baseRef,
        headRef: sameOrNull(sources.map((source) => source.headRef)),
        diff,
        diffHash: sources.map((source) => source.diffHash).join(":"),
        truncated,
        ...(files === undefined ? {} : { files }),
        ...(sources.length > 0 && sources.every((source) => source.patchesDeferred === true)
          ? { patchesDeferred: true }
          : {}),
      };
    });
  };

  const getGroupDiffPreview = Effect.fn("ReviewService.getGroupDiffPreview")(function* (
    input: ReviewDiffPreviewInput,
    members: ReadonlyArray<string>,
  ) {
    const preview = (member: string, memberInput: ReviewDiffPreviewInput) =>
      git
        .getReviewDiffPreview(
          { ...memberInput, cwd: path.join(input.cwd, member) },
          { pathPrefix: member },
        )
        .pipe(Effect.map((result) => ({ ...result, cwd: input.cwd })));
    if (input.file !== undefined) {
      const target = memberForPath(members, input.file.path);
      const previous =
        input.file.previousPath === null ? null : memberForPath(members, input.file.previousPath);
      if (target === null || (previous !== null && previous.member !== target.member)) {
        return yield* noSuchMember(
          "ReviewService.getGroupDiffPreview",
          input.cwd,
          "This file is not in a repository of the group.",
        );
      }
      // A base the combined source names is one every member shares.
      return yield* preview(target.member, {
        ...input,
        file: { ...input.file, path: target.path, previousPath: previous?.path ?? null },
      });
    }
    if (input.commitSha !== undefined) {
      return yield* preview(yield* memberWithCommit(input.cwd, members, input.commitSha), input);
    }
    // Members rarely share a base branch, so each compares against its own.
    const { baseRef: _baseRef, ...perMemberInput } = input;
    const results = yield* Effect.forEach(members, (member) => preview(member, perMemberInput), {
      concurrency: GROUP_CONCURRENCY,
    });
    return {
      cwd: input.cwd,
      generatedAt: yield* DateTime.now,
      sources: mergeGroupSources(results.map((result) => result.sources)),
      ...(results.some((result) => result.incomplete === true) ? { incomplete: true } : {}),
    };
  });

  const getGroupBranchCommits = Effect.fn("ReviewService.getGroupBranchCommits")(function* (
    input: ReviewBranchCommitsInput,
    members: ReadonlyArray<string>,
  ) {
    const results = yield* Effect.forEach(
      members,
      (member) =>
        git.getReviewBranchCommits({ cwd: path.join(input.cwd, member) }).pipe(
          Effect.map((result) => ({
            ...result,
            commits: result.commits.map((commit) => ({
              ...commit,
              subject: `${member}: ${commit.subject}`,
            })),
          })),
        ),
      { concurrency: GROUP_CONCURRENCY },
    );
    const commits = results
      .flatMap((result) => result.commits)
      .toSorted((left, right) => right.committedAt.localeCompare(left.committedAt));
    return {
      commits: commits.slice(0, GROUP_BRANCH_COMMIT_LIMIT),
      truncated:
        commits.length > GROUP_BRANCH_COMMIT_LIMIT || results.some((result) => result.truncated),
    };
  });

  const getGroupDiffFileContents = Effect.fn("ReviewService.getGroupDiffFileContents")(function* (
    input: ReviewDiffFileContentsInput,
    members: ReadonlyArray<string>,
  ) {
    const target = memberForPath(members, input.newPath);
    const previous = memberForPath(members, input.oldPath);
    if (target === null || previous === null || previous.member !== target.member) {
      return yield* noSuchMember(
        "ReviewService.getGroupDiffFileContents",
        input.cwd,
        "This file is not in a repository of the group.",
      );
    }
    const cwd = path.join(input.cwd, target.member);
    // The combined source names a base only when every member shares it; ask this member's own.
    const baseRef =
      input.sourceKind === "branch-range" && input.baseRef === null
        ? ((yield* git.getReviewDiffPreview({
            cwd,
            sourceKind: "branch-range",
            metadataOnly: true,
            trackedOnly: true,
          })).sources[0]?.baseRef ?? null)
        : input.baseRef;
    return yield* git.getReviewDiffFileContents({
      ...input,
      cwd,
      baseRef,
      oldPath: previous.path,
      newPath: target.path,
    });
  });

  const getBranchCommits: ReviewService["Service"]["getBranchCommits"] = Effect.fn(
    "ReviewService.getBranchCommits",
  )(function* (input) {
    yield* assertWorkspaceBoundCwd("ReviewService.getBranchCommits", input.cwd);
    const members = yield* groupMembers(input.cwd);
    if (members !== null) return yield* getGroupBranchCommits(input, members);

    const handle = yield* vcsRegistry.detect({ cwd: input.cwd, requestedKind: "auto" });
    if (!handle) return { commits: [], truncated: false };
    if (handle.kind !== "git") {
      return yield* new VcsUnsupportedOperationError({
        operation: "ReviewService.getBranchCommits",
        kind: handle.kind,
        detail: "Review commit lists require a Git repository.",
      });
    }
    return yield* git.getReviewBranchCommits(input);
  });

  const getDiffPreview: ReviewService["Service"]["getDiffPreview"] = Effect.fn(
    "ReviewService.getDiffPreview",
  )(function* (input) {
    yield* assertWorkspaceBoundCwd("ReviewService.getDiffPreview", input.cwd);
    const members = yield* groupMembers(input.cwd);
    if (members !== null) return yield* getGroupDiffPreview(input, members);

    const handle = yield* vcsRegistry.detect({ cwd: input.cwd, requestedKind: "auto" });
    if (!handle) {
      return {
        cwd: input.cwd,
        generatedAt: yield* DateTime.now,
        sources: [],
      };
    }

    return yield* git.getReviewDiffPreview(input);
  });

  const getDiffFileContents: ReviewService["Service"]["getDiffFileContents"] = Effect.fn(
    "ReviewService.getDiffFileContents",
  )(function* (input) {
    yield* assertWorkspaceBoundCwd("ReviewService.getDiffFileContents", input.cwd);
    const members = yield* groupMembers(input.cwd);
    if (members !== null) return yield* getGroupDiffFileContents(input, members);

    const handle = yield* vcsRegistry.detect({ cwd: input.cwd, requestedKind: "auto" });
    if (handle?.kind !== "git") {
      return yield* new VcsUnsupportedOperationError({
        operation: "ReviewService.getDiffFileContents",
        kind: handle?.kind ?? "unknown",
        detail: "Unchanged diff expansion currently requires a Git repository.",
      });
    }

    return yield* git.getReviewDiffFileContents(input);
  });

  return ReviewService.of({
    getBranchCommits,
    getDiffPreview,
    getDiffFileContents,
  });
});

export const layer = Layer.effect(ReviewService, make);
