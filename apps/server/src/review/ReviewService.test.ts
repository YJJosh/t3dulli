import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/sql/SqlClient";
import { ProjectId } from "@t3tools/contracts";

import * as ServerConfig from "../config.ts";
import * as ProjectStore from "../orchestration-v2/ProjectStore.ts";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as GitVcsDriver from "../vcs/GitVcsDriver.ts";
import * as MultiRepoWorkspaces from "../vcs/MultiRepoWorkspaces.ts";
import * as VcsProcess from "../vcs/VcsProcess.ts";
import * as VcsDriverRegistry from "../vcs/VcsDriverRegistry.ts";
import * as KnownWorkspaces from "../workspace/KnownWorkspaces.ts";
import * as ReviewService from "./ReviewService.ts";

function layer(input: {
  readonly workspaceRoot: string;
  readonly baseDir: string;
  readonly detectCalls?: Array<{ readonly cwd: string }>;
  readonly worktreesDirectory?: string;
  readonly previousWorktreesDirectories?: ReadonlyArray<string>;
  readonly projectRoots?: ReadonlyArray<string> | "unavailable";
  readonly threadWorktrees?: ReadonlyArray<{ worktreePath: string; deleted?: boolean }>;
  readonly gitWorktrees?: ReadonlyArray<string>;
  /** Runs real Git and treats `cwd` as a multi-repo group of these members. */
  readonly group?: { readonly cwd: string; readonly members: ReadonlyArray<string> };
}) {
  const projectRoots = input.projectRoots ?? [];
  const { group } = input;
  return ReviewService.layer.pipe(
    Layer.provide(
      Layer.mock(MultiRepoWorkspaces.MultiRepoWorkspaces)({
        members: (cwd) => Effect.succeed(group?.cwd === cwd ? group.members : null),
      }),
    ),
    Layer.provide(KnownWorkspaces.layer),
    Layer.provide(
      Layer.effectDiscard(
        Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient;
          for (const [index, thread] of (input.threadWorktrees ?? []).entries()) {
            yield* sql`
              INSERT INTO orchestration_v2_projection_threads (
                thread_id, project_id, title, default_provider, runtime_mode, interaction_mode,
                created_at, updated_at, deleted_at, payload_json
              ) VALUES (
                ${`thread-${index}`}, 'project-0', 'Thread', 'codex', 'full-access', 'default',
                '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z',
                ${thread.deleted ? "2026-01-02T00:00:00.000Z" : null},
                ${JSON.stringify({ worktreePath: thread.worktreePath })}
              )
            `;
          }
        }),
      ).pipe(Layer.provideMerge(SqlitePersistence.layerMemory)),
    ),
    Layer.provide(
      Layer.mock(ProjectStore.ProjectStoreV2)({
        listShells: () =>
          projectRoots === "unavailable"
            ? Effect.fail(
                new ProjectStore.ProjectStoreV2Error({ operation: "list", cause: "offline" }),
              )
            : Effect.succeed(
                projectRoots.map((workspaceRoot, index) => ({
                  id: ProjectId.make(`project-${index}`),
                  title: `Project ${index}`,
                  workspaceRoot,
                  defaultModelSelection: null,
                  scripts: [],
                  createdAt: "2026-01-01T00:00:00.000Z",
                  updatedAt: "2026-01-01T00:00:00.000Z",
                })),
              ),
      }),
    ),
    Layer.provide(
      Layer.mock(VcsDriverRegistry.VcsDriverRegistry)({
        get: () => Effect.die("unexpected VCS registry get"),
        resolve: () => Effect.die("unexpected VCS registry resolve"),
        detect: (request) =>
          Effect.sync(() => {
            input.detectCalls?.push({ cwd: request.cwd });
            return null;
          }),
      }),
    ),
    Layer.provideMerge(
      group === undefined
        ? Layer.mock(GitVcsDriver.GitVcsDriver)({
            listWorktreePaths: () => Effect.succeed([...(input.gitWorktrees ?? [])]),
          })
        : GitVcsDriver.layer.pipe(
            Layer.provide(VcsProcess.layer),
            Layer.provide(ServerConfig.layerTest(input.workspaceRoot, input.baseDir)),
            Layer.provide(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer)),
          ),
    ),
    Layer.provide(
      ServerSettings.ServerSettingsService.layerTest({
        worktreesDirectory: input.worktreesDirectory ?? "",
        previousWorktreesDirectories: [...(input.previousWorktreesDirectories ?? [])],
      }),
    ),
    Layer.provide(ServerConfig.layerTest(input.workspaceRoot, input.baseDir)),
    Layer.provideMerge(NodeServices.layer),
  );
}

describe("ReviewService", () => {
  it.effect("reviews every member of a multi-repo group under its folder", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const workspaceRoot = yield* fs.realPath(
        yield* fs.makeTempDirectoryScoped({ prefix: "t3-review-group-" }),
      );
      const baseDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-review-base-" });
      const cwd = `${workspaceRoot}/group`;
      const result = yield* Effect.gen(function* () {
        const git = yield* GitVcsDriver.GitVcsDriver;
        const run = (repo: string, args: ReadonlyArray<string>) =>
          git.execute({ operation: "test", cwd: repo, args });
        for (const member of ["api", "web"]) {
          const repo = `${cwd}/${member}`;
          yield* fs.makeDirectory(repo, { recursive: true });
          yield* run(repo, ["init", "-b", "main"]);
          yield* run(repo, ["config", "user.email", "t@example.test"]);
          yield* run(repo, ["config", "user.name", "Test"]);
          yield* fs.writeFileString(`${repo}/README.md`, `# ${member}\n`);
          yield* run(repo, ["add", "."]);
          yield* run(repo, ["commit", "-m", `${member} initial`]);
        }
        yield* run(`${cwd}/api`, ["checkout", "-b", "feature"]);
        yield* fs.writeFileString(`${cwd}/api/work.txt`, "work\n");
        yield* run(`${cwd}/api`, ["add", "."]);
        yield* run(`${cwd}/api`, ["commit", "-m", "api work"]);
        yield* fs.writeFileString(`${cwd}/api/README.md`, "# api changed\n");
        yield* fs.writeFileString(`${cwd}/web/new.txt`, "new\n");
        const review = yield* ReviewService.ReviewService;
        const preview = yield* review.getDiffPreview({ cwd, sourceKind: "working-tree" });
        const file = yield* review.getDiffPreview({
          cwd,
          sourceKind: "working-tree",
          file: { path: "api/README.md", previousPath: null, sourceKind: "working-tree" },
        });
        const contents = yield* review.getDiffFileContents({
          cwd,
          sourceKind: "working-tree",
          changeType: "change",
          baseRef: "HEAD",
          headRef: null,
          oldPath: "api/README.md",
          newPath: "api/README.md",
        });
        const commits = yield* review.getBranchCommits({ cwd });
        const commit = yield* review.getDiffPreview({ cwd, commitSha: commits.commits[0]!.sha });
        return { preview, file, contents, commits, commit };
      }).pipe(
        // `gone` is listed but has no folder here, as a member added after the workspace.
        Effect.provide(
          layer({ workspaceRoot, baseDir, group: { cwd, members: ["api", "web", "gone"] } }),
        ),
      );

      const [source] = result.preview.sources;
      assert.deepStrictEqual(
        source?.files?.map((file) => file.path),
        ["api/README.md", "web/new.txt"],
      );
      assert.include(source?.diff, "diff --git a/api/README.md b/api/README.md");
      assert.include(source?.diff, "+++ b/web/new.txt");
      assert.include(result.file.sources[0]?.diff, "+++ b/api/README.md");
      assert.notInclude(result.file.sources[0]?.diff, "web/new.txt");
      assert.deepStrictEqual(result.contents, {
        oldContents: "# api\n",
        newContents: "# api changed\n",
      });
      // Each member lists its own commits against its own base.
      assert.deepStrictEqual(
        result.commits.commits.map((commit) => commit.subject),
        ["api: api work"],
      );
      assert.include(result.commit.sources[0]?.diff, "+++ b/api/work.txt");
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("keeps every member's changes when one member is too large to list", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const workspaceRoot = yield* fs.realPath(
        yield* fs.makeTempDirectoryScoped({ prefix: "t3-review-group-large-" }),
      );
      const baseDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-review-base-" });
      const cwd = `${workspaceRoot}/group`;
      const preview = yield* Effect.gen(function* () {
        const git = yield* GitVcsDriver.GitVcsDriver;
        const run = (repo: string, args: ReadonlyArray<string>) =>
          git.execute({ operation: "test", cwd: repo, args });
        for (const member of ["api", "docs"]) {
          const repo = `${cwd}/${member}`;
          yield* fs.makeDirectory(repo, { recursive: true });
          yield* run(repo, ["init", "-b", "main"]);
          yield* run(repo, ["config", "user.email", "t@example.test"]);
          yield* run(repo, ["config", "user.name", "Test"]);
          yield* fs.writeFileString(`${repo}/README.md`, `# ${member}\n`);
          yield* run(repo, ["add", "."]);
          yield* run(repo, ["commit", "-m", `${member} initial`]);
        }
        // More untracked files than review lists, so api sends a bounded patch.
        yield* fs.makeDirectory(`${cwd}/api/generated`);
        yield* Effect.forEach(
          Array.from({ length: 5_001 }, (_, index) => index),
          (index) => fs.writeFileString(`${cwd}/api/generated/${index}.txt`, ""),
          { concurrency: 64, discard: true },
        );
        yield* fs.writeFileString(`${cwd}/docs/README.md`, "# docs changed\n");
        const review = yield* ReviewService.ReviewService;
        return yield* review.getDiffPreview({
          cwd,
          sourceKind: "working-tree",
          metadataOnly: true,
        });
      }).pipe(
        Effect.provide(layer({ workspaceRoot, baseDir, group: { cwd, members: ["api", "docs"] } })),
      );

      const [source] = preview.sources;
      assert.isUndefined(source?.files);
      assert.include(source?.diff, "+++ b/docs/README.md");
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("rejects diff preview cwd outside the configured workspace roots", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const workspaceRoot = yield* fs.makeTempDirectoryScoped({ prefix: "t3-review-workspace-" });
      const outsideRoot = yield* fs.makeTempDirectoryScoped({ prefix: "t3-review-outside-" });
      const baseDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-review-base-" });
      const detectCalls: Array<{ readonly cwd: string }> = [];

      const error = yield* Effect.gen(function* () {
        const review = yield* ReviewService.ReviewService;
        return yield* review.getDiffPreview({ cwd: outsideRoot }).pipe(Effect.flip);
      }).pipe(Effect.provide(layer({ workspaceRoot, baseDir, detectCalls })));

      assert.strictEqual(error._tag, "VcsRepositoryDetectionError");
      assert.strictEqual(error.operation, "ReviewService.getDiffPreview");
      assert.match(
        "detail" in error ? error.detail : "",
        /must stay within the configured workspace root/,
      );
      assert.deepStrictEqual(detectCalls, []);
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("allows previous custom worktree locations but never a filesystem root", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const workspaceRoot = yield* fs.makeTempDirectoryScoped({ prefix: "t3-review-workspace-" });
      const baseDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-review-base-" });
      const previous = yield* fs.makeTempDirectoryScoped({ prefix: "t3-review-old-worktrees-" });
      const outsideRoot = yield* fs.makeTempDirectoryScoped({ prefix: "t3-review-outside-" });

      const result = yield* Effect.gen(function* () {
        const review = yield* ReviewService.ReviewService;
        return yield* review.getDiffPreview({ cwd: previous });
      }).pipe(
        Effect.provide(
          layer({
            workspaceRoot,
            baseDir,
            worktreesDirectory: "/",
            previousWorktreesDirectories: [previous],
          }),
        ),
      );
      assert.strictEqual(result.cwd, previous);

      const rootLink = `${baseDir}/root-link`;
      yield* fs.symlink("/", rootLink);
      for (const worktreesDirectory of ["/", rootLink]) {
        const error = yield* Effect.gen(function* () {
          const review = yield* ReviewService.ReviewService;
          return yield* review.getDiffPreview({ cwd: outsideRoot }).pipe(Effect.flip);
        }).pipe(Effect.provide(layer({ workspaceRoot, baseDir, worktreesDirectory })));
        assert.strictEqual(error._tag, "VcsRepositoryDetectionError");
      }
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("allows registered project roots outside the server cwd", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const workspaceRoot = yield* fs.makeTempDirectoryScoped({ prefix: "t3-review-workspace-" });
      const baseDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-review-base-" });
      const projectRoot = yield* fs.makeTempDirectoryScoped({ prefix: "t3-review-project-" });
      const projectChild = `${projectRoot}/packages/app`;
      yield* fs.makeDirectory(projectChild, { recursive: true });
      const sibling = `${projectRoot}-sibling`;
      yield* fs.makeDirectory(sibling);
      yield* Effect.addFinalizer(() => fs.remove(sibling, { recursive: true }).pipe(Effect.ignore));

      const review = (cwd: string, projectRoots: ReadonlyArray<string> | "unavailable") =>
        Effect.gen(function* () {
          const service = yield* ReviewService.ReviewService;
          return yield* service.getDiffPreview({ cwd });
        }).pipe(Effect.provide(layer({ workspaceRoot, baseDir, projectRoots })));

      assert.strictEqual((yield* review(projectRoot, [projectRoot])).cwd, projectRoot);
      assert.strictEqual((yield* review(projectChild, [projectRoot])).cwd, projectChild);
      const dottedChild = `${projectRoot}/..feature`;
      yield* fs.makeDirectory(dottedChild);
      assert.strictEqual((yield* review(dottedChild, [projectRoot])).cwd, dottedChild);
      for (const [cwd, projectRoots] of [
        [sibling, [projectRoot]],
        [projectRoot, []],
        [projectRoot, "unavailable"],
      ] as const) {
        const error = yield* review(cwd, projectRoots).pipe(Effect.flip);
        assert.strictEqual(error._tag, "VcsRepositoryDetectionError");
      }
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("allows the worktree a thread is bound to, and nothing else outside the project", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const workspaceRoot = yield* fs.makeTempDirectoryScoped({ prefix: "t3-review-workspace-" });
      const baseDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-review-base-" });
      const project = yield* fs.makeTempDirectoryScoped({ prefix: "t3-review-project-" });
      const bound = yield* fs.makeTempDirectoryScoped({ prefix: "t3-review-bound-" });
      const deleted = yield* fs.makeTempDirectoryScoped({ prefix: "t3-review-deleted-" });
      const unbound = yield* fs.makeTempDirectoryScoped({ prefix: "t3-review-unbound-" });
      const claimed = yield* fs.makeTempDirectoryScoped({ prefix: "t3-review-claimed-" });
      yield* fs.makeDirectory(`${bound}/sub`);

      const review = (cwd: string) =>
        Effect.gen(function* () {
          const service = yield* ReviewService.ReviewService;
          return yield* service.getDiffPreview({ cwd });
        }).pipe(
          Effect.provide(
            layer({
              workspaceRoot,
              baseDir,
              projectRoots: [project],
              gitWorktrees: [project, bound, deleted],
              threadWorktrees: [
                { worktreePath: bound },
                { worktreePath: claimed },
                { worktreePath: deleted, deleted: true },
                { worktreePath: "t3-review-relative" },
                { worktreePath: "/" },
              ],
            }),
          ),
        );

      for (const cwd of [bound, `${bound}/sub`]) {
        assert.strictEqual((yield* review(cwd)).cwd, cwd);
      }
      for (const cwd of [deleted, unbound, claimed, `${process.cwd()}/t3-review-relative`]) {
        const error = yield* review(cwd).pipe(Effect.flip);
        assert.strictEqual(error._tag, "VcsRepositoryDetectionError");
      }
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("allows a thread's worktree linked from a managed folder to a checkout elsewhere", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const workspaceRoot = yield* fs.makeTempDirectoryScoped({ prefix: "t3-review-workspace-" });
      const baseDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-review-base-" });
      const managed = yield* fs.realPath(
        yield* fs.makeTempDirectoryScoped({ prefix: "t3-review-worktrees-" }),
      );
      const checkout = yield* fs.makeTempDirectoryScoped({ prefix: "t3-review-checkout-" });
      yield* fs.symlink(checkout, `${managed}/feature`);

      const result = yield* Effect.gen(function* () {
        const review = yield* ReviewService.ReviewService;
        return yield* review.getDiffPreview({ cwd: checkout });
      }).pipe(
        Effect.provide(
          layer({
            workspaceRoot,
            baseDir,
            worktreesDirectory: managed,
            threadWorktrees: [{ worktreePath: `${managed}/feature` }],
          }),
        ),
      );
      assert.strictEqual(result.cwd, checkout);
    }).pipe(Effect.provide(NodeServices.layer)),
  );
});
