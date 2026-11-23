import { EnvironmentId, ProjectId, type ScopedProjectRef } from "@t3tools/contracts";
import type { EnvironmentProject } from "@t3tools/client-runtime/state/models";
import { describe, expect, it } from "vite-plus/test";
import { buildMultiRepoProjectSetupMenu } from "./multiRepoSetupMenu";
import { reduceCommandPaletteUiState } from "./components/CommandPalette.logic";

const laptop = EnvironmentId.make("laptop");
const desktop = EnvironmentId.make("desktop");
const server = EnvironmentId.make("server");

function project(
  environmentId = laptop,
  overrides: Partial<EnvironmentProject> = {},
): EnvironmentProject {
  return {
    environmentId,
    id: ProjectId.make(`product-${environmentId}`),
    title: "Product",
    workspaceRoot: "/work/product",
    repositoryIdentity: null,
    multiRepo: {
      members: [
        { path: "api", remoteUrl: "git@github.com:acme/api.git" },
        { path: "web", remoteUrl: "https://github.com/acme/web.git" },
      ],
    },
    defaultModelSelection: null,
    scripts: [],
    createdAt: "2026-07-01T00:00:00.000Z",
    updatedAt: "2026-07-01T00:00:00.000Z",
    ...overrides,
  };
}

function environment(environmentId = desktop, label = "Desktop") {
  return {
    environmentId,
    label,
    connection: { phase: "connected" },
    serverConfig: {
      environment: {
        capabilities: { multiRepoProjects: true, projectCloneTracking: true },
      },
    },
  };
}

function projectRef(source: EnvironmentProject): ScopedProjectRef {
  return { environmentId: source.environmentId, projectId: source.id };
}

// The items that set the project up elsewhere, without Manage repositories.
const setupItems = (menu: ReturnType<typeof buildMultiRepoProjectSetupMenu>) =>
  menu.items.filter((item) => !item.id.startsWith("multi-repo-setup:members:"));

const source = project();
const baseInput = {
  projects: [source],
  projectRefs: [projectRef(source)],
  canSetUp: () => true,
};

describe("multi-repo sidebar setup menu", () => {
  it("offers a direct action for one missing machine and carries the existing setup into the palette intent", () => {
    const menu = buildMultiRepoProjectSetupMenu({
      ...baseInput,
      environments: [environment(laptop, "Laptop"), environment()],
    });
    expect(setupItems(menu)).toEqual([
      { id: "multi-repo-setup:desktop", label: "Set up on Desktop", icon: "folder" },
    ]);
    const intent = menu.setupsByAction.get("multi-repo-setup:desktop")!;
    expect(intent.environmentId).toBe(desktop);
    expect(intent.setup.source).toBe(source);
    expect(intent.setup.members).toEqual(source.multiRepo?.members);
    expect(
      reduceCommandPaletteUiState(
        { open: true, mode: "files", openIntent: null, session: 1 },
        { _tag: "OpenMultiRepoSetup", ...intent },
      ),
    ).toEqual({
      open: true,
      mode: "command",
      openIntent: { kind: "multi-repo-setup", ...intent },
      session: 2,
    });
  });

  it("groups multiple missing environments in a submenu", () => {
    const menu = buildMultiRepoProjectSetupMenu({
      ...baseInput,
      environments: [environment(), environment(server, "Build server")],
    });
    expect(setupItems(menu)).toEqual([
      {
        id: "multi-repo-setup:submenu",
        label: "Set up on...",
        icon: "folder",
        children: [
          { id: "multi-repo-setup:desktop", label: "Set up on Desktop", icon: "folder" },
          { id: "multi-repo-setup:server", label: "Set up on Build server", icon: "folder" },
        ],
      },
    ]);
    expect([...menu.setupsByAction.values()].map((intent) => intent.environmentId)).toEqual([
      desktop,
      server,
    ]);
  });

  it.each([
    { ...environment(), connection: { phase: "disconnected" } },
    { ...environment(), connection: { phase: "connecting" } },
    { ...environment(), serverConfig: null },
    { environmentId: desktop, label: "Desktop", connection: { phase: "connected" } },
    {
      ...environment(),
      serverConfig: {
        environment: { capabilities: { multiRepoProjects: false, projectCloneTracking: true } },
      },
    },
    {
      ...environment(),
      serverConfig: {
        environment: { capabilities: { multiRepoProjects: true, projectCloneTracking: false } },
      },
    },
    {
      ...environment(),
      serverConfig: { environment: { capabilities: {} } },
    },
  ])("omits disconnected or unsupported targets: %j", (target) => {
    const menu = buildMultiRepoProjectSetupMenu({ ...baseInput, environments: [target] });
    expect(setupItems(menu)).toEqual([]);
    expect(menu.setupsByAction.size).toBe(0);
  });

  it("omits targets this client may not set the project up on", () => {
    const menu = buildMultiRepoProjectSetupMenu({
      ...baseInput,
      environments: [environment(), environment(server, "Build server")],
      canSetUp: (environmentId) => environmentId !== desktop,
    });
    expect([...menu.setupsByAction.values()].map((intent) => intent.environmentId)).toEqual([
      server,
    ]);
  });

  it("recognizes an existing setup despite different paths, remote syntax and member order", () => {
    const existing = project(desktop, {
      workspaceRoot: "/home/me/renamed",
      multiRepo: {
        members: [
          { path: "frontend", remoteUrl: "git@github.com:acme/web.git" },
          { path: "backend", remoteUrl: "https://github.com/acme/api" },
        ],
      },
    });
    expect(
      setupItems(
        buildMultiRepoProjectSetupMenu({
          ...baseInput,
          projects: [source, existing],
          environments: [environment()],
        }),
      ),
    ).toEqual([]);
  });

  it("matches by multi-repo identity and seeds from the project the menu belongs to", () => {
    const copy = project(server, { title: "Product copy", workspaceRoot: "/srv/product" });
    const unrelated = project(laptop, {
      id: ProjectId.make("other"),
      multiRepo: { members: [{ path: "tools", remoteUrl: "https://github.com/acme/tools" }] },
    });
    const menu = buildMultiRepoProjectSetupMenu({
      projects: [unrelated, source, copy],
      projectRefs: [projectRef(copy)],
      environments: [environment()],
      canSetUp: () => true,
    });
    expect(setupItems(menu)).toHaveLength(1);
    expect(menu.setupsByAction.get("multi-repo-setup:desktop")?.setup.source).toBe(copy);
  });

  it.each([
    { multiRepo: null },
    { multiRepo: { members: [] } },
    { multiRepo: { members: [{ path: "local-only", remoteUrl: null }] } },
  ])("does not offer ordinary, empty or uncloneable projects: %j", (overrides) => {
    const source = project(laptop, overrides);
    expect(
      setupItems(
        buildMultiRepoProjectSetupMenu({
          projects: [source, project(server)],
          projectRefs: [projectRef(source)],
          environments: [environment()],
          canSetUp: () => true,
        }),
      ),
    ).toEqual([]);
  });

  it("offers to manage the repositories of each copy, naming the machine when there are several", () => {
    const copy = project(server);
    const plain = project(desktop, { multiRepo: null });
    const manage = (refs: ReadonlyArray<EnvironmentProject>) =>
      buildMultiRepoProjectSetupMenu({
        projects: [source, copy, plain],
        projectRefs: refs.map(projectRef),
        environments: [environment(laptop, "Laptop"), environment(server, "Build server")],
        canSetUp: () => false,
      });
    expect(manage([source]).items).toEqual([
      {
        id: "multi-repo-setup:members:laptop:product-laptop",
        label: "Manage repositories",
        icon: "folder",
      },
    ]);
    expect(manage([source, copy]).items.map((item) => item.label)).toEqual([
      "Manage repositories on Laptop",
      "Manage repositories on Build server",
    ]);
    expect(manage([plain]).items).toEqual([]);
    expect(
      manage([source]).membersByAction.get("multi-repo-setup:members:laptop:product-laptop"),
    ).toEqual(projectRef(source));
  });
});
