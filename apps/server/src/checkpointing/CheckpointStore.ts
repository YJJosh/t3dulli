import { CheckpointRef } from "@t3tools/contracts";
import * as Cache from "effect/Cache";
import * as Context from "effect/Context";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";

import type { CheckpointStoreError } from "./Errors.ts";
import { parseTurnDiffFilesFromNumstat } from "./Diffs.ts";
import * as VcsDriver from "../vcs/VcsDriver.ts";
import * as MultiRepoWorkspaces from "../vcs/MultiRepoWorkspaces.ts";
import * as VcsDriverRegistry from "../vcs/VcsDriverRegistry.ts";

export interface CaptureCheckpointInput {
  readonly cwd: string;
  readonly checkpointRef: CheckpointRef;
  /** The checkpoint this one follows, so a turn that switched branches starts where it landed. */
  readonly previousCheckpointRef?: CheckpointRef;
  /**
   * Multi-repo groups: keep the ref in members that have it, so a baseline taken again after a
   * member joined does not rewrite what the others recorded.
   */
  readonly onlyMissing?: boolean;
}

export interface RestoreCheckpointInput {
  readonly cwd: string;
  readonly checkpointRef: CheckpointRef;
  readonly fallbackToHead?: boolean;
}

export interface DiffCheckpointsInput {
  readonly cwd: string;
  readonly fromCheckpointRef: CheckpointRef;
  readonly toCheckpointRef: CheckpointRef;
  readonly fallbackFromToHead?: boolean;
  readonly ignoreWhitespace: boolean;
  readonly format?: "patch" | "numstat";
  /** Maximum bytes collected from the diff command. */
  readonly maxOutputBytes?: number;
  /** Limits the diff to these exact paths. An empty list yields an empty diff. */
  readonly filePaths?: ReadonlyArray<string>;
}

export interface ListAuthoredPathsInput {
  readonly cwd: string;
  readonly fromCheckpointRef: CheckpointRef;
  readonly toCheckpointRef: CheckpointRef;
}

export interface DeleteCheckpointRefsInput {
  readonly cwd: string;
  readonly checkpointRefs: ReadonlyArray<CheckpointRef>;
}

export class CheckpointStore extends Context.Service<
  CheckpointStore,
  {
    /** Also true for a multi-repo group or workspace, whose checkpoints span its members. */
    readonly isGitRepository: (cwd: string) => Effect.Effect<boolean, CheckpointStoreError>;

    readonly captureCheckpoint: (
      input: CaptureCheckpointInput,
    ) => Effect.Effect<void, CheckpointStoreError>;

    /** In a multi-repo group, whether every member has the ref. */
    readonly hasCheckpointRef: (
      input: Omit<RestoreCheckpointInput, "fallbackToHead">,
    ) => Effect.Effect<boolean, CheckpointStoreError>;

    /**
     * Whether `restoreCheckpoint` can restore the ref. A multi-repo group needs it in one member:
     * members that joined after the checkpoint keep their files.
     */
    readonly canRestoreCheckpoint: (
      input: Omit<RestoreCheckpointInput, "fallbackToHead">,
    ) => Effect.Effect<boolean, CheckpointStoreError>;

    readonly restoreCheckpoint: (
      input: RestoreCheckpointInput,
    ) => Effect.Effect<boolean, CheckpointStoreError>;

    readonly diffCheckpoints: (
      input: DiffCheckpointsInput,
    ) => Effect.Effect<string, CheckpointStoreError>;

    /**
     * Null means HEAD is unchanged or unrecorded; all changed paths then belong to the turn.
     * In a multi-repo group, paths start with their member's folder, as in `diffCheckpoints`.
     */
    readonly listAuthoredPaths: (
      input: ListAuthoredPathsInput,
    ) => Effect.Effect<ReadonlySet<string> | null, CheckpointStoreError>;

    readonly deleteCheckpointRefs: (
      input: DeleteCheckpointRefsInput,
    ) => Effect.Effect<void, CheckpointStoreError>;
  }
>()("t3/checkpointing/CheckpointStore") {}

/** @public */
export const make = Effect.gen(function* () {
  const vcsRegistry = yield* VcsDriverRegistry.VcsDriverRegistry;
  const path = yield* Path.Path;
  const multiRepo = yield* Effect.serviceOption(MultiRepoWorkspaces.MultiRepoWorkspaces);

  // One turn makes several store calls on the same cwd, and a group's member list
  // costs a Workler call. A workspace's own `.workler` fixes its members, so a short
  // lifetime only delays a member added at the group root.
  const membersCache = yield* Cache.make({
    capacity: 256,
    timeToLive: Duration.seconds(10),
    lookup: (cwd: string) =>
      Option.isSome(multiRepo) ? multiRepo.value.members(cwd) : Effect.succeed(null),
  });

  const resolveCheckpoints = Effect.fn("CheckpointStore.resolveCheckpoints")(function* (
    cwd: string,
  ) {
    const handle = yield* vcsRegistry.resolve({ cwd });
    return handle.driver.checkpoints satisfies VcsDriver.VcsCheckpointOps;
  });

  interface Member {
    readonly prefix: string;
    readonly cwd: string;
    readonly checkpoints: VcsDriver.VcsCheckpointOps;
  }

  /** The members of the group at `cwd` with their checkpoint ops, or null for a single repository. */
  const resolveMembers = Effect.fn("CheckpointStore.resolveMembers")(function* (cwd: string) {
    const members = yield* Cache.get(membersCache, cwd);
    if (members === null) return null;
    return yield* Effect.forEach(members, (member) => {
      const memberCwd = path.join(cwd, member);
      return resolveCheckpoints(memberCwd).pipe(
        Effect.map((checkpoints): Member => ({ prefix: member, cwd: memberCwd, checkpoints })),
      );
    });
  });

  const MEMBER_CONCURRENCY = 4;

  // A member added to the group after the earlier checkpoint has no ref for it, so it
  // has nothing of the turn to show. Any other failure still fails.
  const unlessMemberLacksRef = <A, E>(
    member: Member,
    checkpointRef: CheckpointRef,
    effect: Effect.Effect<A, E>,
    empty: A,
  ) =>
    effect.pipe(
      Effect.catch((error) =>
        member.checkpoints
          .hasCheckpointRef({ cwd: member.cwd, checkpointRef })
          .pipe(Effect.flatMap((exists) => (exists ? Effect.fail(error) : Effect.succeed(empty)))),
      ),
    );

  // The registry reads an unreadable repository as none; ask Git again so that fails here.
  const isGitRepository: CheckpointStore["Service"]["isGitRepository"] = Effect.fn(
    "CheckpointStore.isGitRepository",
  )(function* (cwd) {
    if ((yield* vcsRegistry.detect({ cwd, requestedKind: "git" })) !== null) return true;
    // A group counts once a member is cloned: a leftover `.workler` alone is no checkout.
    const members = yield* Cache.get(membersCache, cwd);
    if (members !== null) {
      for (const member of members) {
        if (
          (yield* vcsRegistry.detect({ cwd: path.join(cwd, member), requestedKind: "git" })) !==
          null
        )
          return true;
      }
      return false;
    }
    const git = yield* vcsRegistry.get("git");
    return (yield* git.detectRepository(cwd)) !== null;
  });

  const captureCheckpoint: CheckpointStore["Service"]["captureCheckpoint"] = Effect.fn(
    "captureCheckpoint",
  )(function* (input) {
    const members = yield* resolveMembers(input.cwd);
    if (members === null) {
      const checkpoints = yield* resolveCheckpoints(input.cwd);
      return yield* checkpoints.captureCheckpoint(input);
    }
    // Every member gets the same ref; `hasCheckpointRef` needs all of them before it counts.
    const { onlyMissing, ...capture } = input;
    yield* Effect.forEach(
      members,
      (member) =>
        Effect.gen(function* () {
          if (
            onlyMissing === true &&
            (yield* member.checkpoints.hasCheckpointRef({
              cwd: member.cwd,
              checkpointRef: input.checkpointRef,
            }))
          ) {
            return;
          }
          yield* member.checkpoints.captureCheckpoint({ ...capture, cwd: member.cwd });
        }),
      { concurrency: MEMBER_CONCURRENCY, discard: true },
    );
  });

  const hasCheckpointRef: CheckpointStore["Service"]["hasCheckpointRef"] = Effect.fn(
    "hasCheckpointRef",
  )(function* (input) {
    const members = yield* resolveMembers(input.cwd);
    if (members === null) {
      const checkpoints = yield* resolveCheckpoints(input.cwd);
      return yield* checkpoints.hasCheckpointRef(input);
    }
    if (members.length === 0) return false;
    const found = yield* Effect.forEach(
      members,
      (member) => member.checkpoints.hasCheckpointRef({ ...input, cwd: member.cwd }),
      { concurrency: MEMBER_CONCURRENCY },
    );
    return found.every(Boolean);
  });

  /** The members that hold `checkpointRef`; a member that joined later has none. */
  const membersWithRef = (members: ReadonlyArray<Member>, checkpointRef: CheckpointRef) =>
    Effect.filter(
      members,
      (member) => member.checkpoints.hasCheckpointRef({ cwd: member.cwd, checkpointRef }),
      { concurrency: MEMBER_CONCURRENCY },
    );

  const canRestoreCheckpoint: CheckpointStore["Service"]["canRestoreCheckpoint"] = Effect.fn(
    "canRestoreCheckpoint",
  )(function* (input) {
    const members = yield* resolveMembers(input.cwd);
    if (members === null) {
      const checkpoints = yield* resolveCheckpoints(input.cwd);
      return yield* checkpoints.hasCheckpointRef(input);
    }
    return (yield* membersWithRef(members, input.checkpointRef)).length > 0;
  });

  const restoreCheckpoint: CheckpointStore["Service"]["restoreCheckpoint"] = Effect.fn(
    "restoreCheckpoint",
  )(function* (input) {
    const members = yield* resolveMembers(input.cwd);
    if (members === null) {
      const checkpoints = yield* resolveCheckpoints(input.cwd);
      return yield* checkpoints.restoreCheckpoint(input);
    }
    const targets =
      input.fallbackToHead === true ? members : yield* membersWithRef(members, input.checkpointRef);
    if (targets.length === 0) return false;
    // Each member's files are saved first, so a member that fails puts the others back. The
    // conversation may already be rewound, so a member Git can't save still gets restored.
    const undoRef = CheckpointRef.make(`${input.checkpointRef}-restore-undo`);
    const dropUndo = Effect.forEach(
      targets,
      (member) =>
        member.checkpoints
          .deleteCheckpointRefs({ cwd: member.cwd, checkpointRefs: [undoRef] })
          .pipe(Effect.ignore),
      { discard: true },
    );
    const run = Effect.gen(function* () {
      const saved = yield* Effect.forEach(
        targets,
        (member) =>
          member.checkpoints.captureCheckpoint({ cwd: member.cwd, checkpointRef: undoRef }).pipe(
            Effect.as(true),
            Effect.catch((error) =>
              Effect.logWarning("Could not save a multi-repo member before restoring it", {
                cwd: member.cwd,
                detail: error.message,
              }).pipe(Effect.as(false)),
            ),
          ),
        { concurrency: MEMBER_CONCURRENCY },
      );
      const canUndo = saved.every(Boolean);
      // Only members the restore reached changed, the failing one perhaps partly.
      const reached: Array<Member> = [];
      const undo = Effect.forEach(
        reached,
        (member) =>
          member.checkpoints
            .restoreCheckpoint({ cwd: member.cwd, checkpointRef: undoRef, fallbackToHead: false })
            .pipe(
              Effect.catch((error) =>
                Effect.logWarning("Could not put a multi-repo member back after a failed restore", {
                  cwd: member.cwd,
                  detail: error.message,
                }),
              ),
            ),
        { discard: true },
      );
      return yield* Effect.forEach(
        targets,
        (member) =>
          Effect.sync(() => reached.push(member)).pipe(
            Effect.andThen(member.checkpoints.restoreCheckpoint({ ...input, cwd: member.cwd })),
            Effect.flatMap((ok) => (ok ? Effect.void : Effect.fail("unavailable" as const))),
          ),
        { discard: true },
      ).pipe(
        Effect.as(true),
        Effect.catch((failure) =>
          (canUndo ? undo : Effect.void).pipe(
            Effect.andThen(
              failure === "unavailable" ? Effect.succeed(false) : Effect.fail(failure),
            ),
          ),
        ),
      );
    });
    // Restoring and putting members back finish together: an interrupt in between would leave
    // the group half restored with its undo points gone.
    return yield* Effect.uninterruptible(run).pipe(Effect.ensuring(dropUndo));
  });

  /** Splits group paths by member; null keeps every path of every member. */
  const pathsByMember = (
    members: ReadonlyArray<Member>,
    filePaths: ReadonlyArray<string> | undefined,
  ) => {
    if (filePaths === undefined) return null;
    const byMember = new Map<string, Array<string>>();
    for (const filePath of filePaths) {
      // Two-level members like `apps/web` mean the longest matching prefix wins.
      const member = members
        .filter((candidate) => filePath.startsWith(`${candidate.prefix}/`))
        .toSorted((left, right) => right.prefix.length - left.prefix.length)[0];
      if (member === undefined) continue;
      const paths = byMember.get(member.prefix) ?? [];
      paths.push(filePath.slice(member.prefix.length + 1));
      byMember.set(member.prefix, paths);
    }
    return byMember;
  };

  const diffCheckpoints: CheckpointStore["Service"]["diffCheckpoints"] = Effect.fn(
    "diffCheckpoints",
  )(function* (input) {
    const members = yield* resolveMembers(input.cwd);
    if (members === null) {
      const checkpoints = yield* resolveCheckpoints(input.cwd);
      return yield* checkpoints.diffCheckpoints(input);
    }
    const filePaths = pathsByMember(members, input.filePaths);
    const maxOutputBytes = input.maxOutputBytes ?? VcsDriver.CHECKPOINT_DIFF_MAX_OUTPUT_BYTES;
    let output = "";
    let remainingBytes = maxOutputBytes;
    for (const member of members) {
      const memberPaths = filePaths?.get(member.prefix);
      if (filePaths !== null && memberPaths === undefined) continue;
      const memberInput = {
        ...input,
        cwd: member.cwd,
        pathPrefix: member.prefix,
        maxOutputBytes: remainingBytes,
        ...(memberPaths === undefined ? {} : { filePaths: memberPaths }),
      };
      const diff = yield* unlessMemberLacksRef(
        member,
        input.fromCheckpointRef,
        member.checkpoints.diffCheckpoints(memberInput),
        "",
      );
      output += diff;
      remainingBytes -= Buffer.byteLength(diff);
      // A member that filled the budget was cut short; later members would follow its cut.
      if (remainingBytes <= 0) break;
    }
    return output;
  });

  const listAuthoredPaths: CheckpointStore["Service"]["listAuthoredPaths"] = Effect.fn(
    "listAuthoredPaths",
  )(function* (input) {
    const members = yield* resolveMembers(input.cwd);
    if (members === null) {
      const checkpoints = yield* resolveCheckpoints(input.cwd);
      return yield* checkpoints.listAuthoredPaths(input);
    }
    const authored = yield* Effect.forEach(
      members,
      (member) =>
        unlessMemberLacksRef(
          member,
          input.fromCheckpointRef,
          member.checkpoints.listAuthoredPaths({ ...input, cwd: member.cwd }),
          new Set<string>() as ReadonlySet<string> | null,
        ).pipe(Effect.map((paths) => ({ member, paths }))),
      { concurrency: MEMBER_CONCURRENCY },
    );
    if (authored.every(({ paths }) => paths === null)) return null;
    const paths = new Set<string>();
    for (const { member, paths: memberPaths } of authored) {
      if (memberPaths !== null) {
        for (const memberPath of memberPaths) paths.add(`${member.prefix}/${memberPath}`);
        continue;
      }
      // An unchanged HEAD means every changed path of this member is the turn's own.
      const numstat = yield* member.checkpoints.diffCheckpoints({
        ...input,
        cwd: member.cwd,
        pathPrefix: member.prefix,
        ignoreWhitespace: false,
        format: "numstat",
      });
      for (const file of parseTurnDiffFilesFromNumstat(numstat)) {
        paths.add(file.path);
        if (file.previousPath !== undefined) paths.add(file.previousPath);
      }
    }
    return paths;
  });

  const deleteCheckpointRefs: CheckpointStore["Service"]["deleteCheckpointRefs"] = Effect.fn(
    "deleteCheckpointRefs",
  )(function* (input) {
    const members = yield* resolveMembers(input.cwd);
    if (members === null) {
      const checkpoints = yield* resolveCheckpoints(input.cwd);
      return yield* checkpoints.deleteCheckpointRefs(input);
    }
    yield* Effect.forEach(
      members,
      (member) => member.checkpoints.deleteCheckpointRefs({ ...input, cwd: member.cwd }),
      { concurrency: MEMBER_CONCURRENCY, discard: true },
    );
  });

  return CheckpointStore.of({
    isGitRepository,
    captureCheckpoint,
    hasCheckpointRef,
    canRestoreCheckpoint,
    restoreCheckpoint,
    diffCheckpoints,
    listAuthoredPaths,
    deleteCheckpointRefs,
  });
});

export const layer = Layer.effect(CheckpointStore, make);
