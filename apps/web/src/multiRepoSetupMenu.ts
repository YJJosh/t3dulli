import {
  AuthFilesystemReadScope,
  AuthOrchestrationOperateScope,
  AuthSourceControlWriteScope,
  type ContextMenuItem,
  type EnvironmentId,
  type ScopedProjectRef,
} from "@t3tools/contracts";
import type { EnvironmentProject } from "@t3tools/client-runtime/state/models";
import {
  deriveMultiRepoKey,
  listMultiRepoProjectsToSetUp,
  type MultiRepoProjectSetup,
} from "@t3tools/client-runtime/state/project-grouping";
import { msg } from "gt-react";
import { type CommandPaletteMultiRepoSetup, openCommandPalette } from "./commandPaletteBus";
import { openMultiRepoMembers } from "./components/MultiRepoMembersDialog";
import { m } from "./i18n/messages";

/** Whether an environment can clone a multi-repo project from another machine. */
export function canSetUpMultiRepoProjects(
  capabilities:
    | { readonly multiRepoProjects?: boolean; readonly projectCloneTracking?: boolean }
    | undefined,
): boolean {
  return capabilities?.multiRepoProjects === true && capabilities.projectCloneTracking === true;
}

export type MultiRepoSetupMenuId = `multi-repo-setup:${string}`;

export function isMultiRepoSetupMenuId(id: string | null): id is MultiRepoSetupMenuId {
  return id?.startsWith("multi-repo-setup:") === true;
}

interface MultiRepoSetupEnvironment {
  readonly environmentId: EnvironmentId;
  readonly label: string;
  readonly connection: { readonly phase: string };
  readonly serverConfig?: {
    readonly environment: {
      readonly capabilities: {
        readonly multiRepoProjects?: boolean;
        readonly projectCloneTracking?: boolean;
      };
    };
  } | null;
}

interface MultiRepoSetupInput<Environment extends MultiRepoSetupEnvironment> {
  readonly projects: ReadonlyArray<EnvironmentProject>;
  readonly projectRefs: ReadonlyArray<ScopedProjectRef>;
  readonly environments: ReadonlyArray<Environment>;
  readonly canSetUp: (environmentId: EnvironmentId) => boolean;
}

/** The grants the setup form needs on the target: inspect the folder, clone, add the project. */
export const MULTI_REPO_SETUP_SCOPES = [
  AuthFilesystemReadScope,
  AuthSourceControlWriteScope,
  AuthOrchestrationOperateScope,
] as const;

/**
 * Machines the multi-repo project behind `projectRefs` can be set up on: connected,
 * capable, allowed by `canSetUp`, and without the project yet, whatever the grouping.
 */
export function listMultiRepoSetupTargets<Environment extends MultiRepoSetupEnvironment>(
  input: MultiRepoSetupInput<Environment>,
): Array<{ readonly environment: Environment; readonly setup: MultiRepoProjectSetup }> {
  const isReferenced = (project: EnvironmentProject) =>
    input.projectRefs.some(
      (ref) => ref.environmentId === project.environmentId && ref.projectId === project.id,
    );
  const referenced = input.projects.filter(isReferenced);
  // Copies sharing a key collapse into the first one listed, so the seed is this project's own.
  const projects = [...referenced, ...input.projects.filter((project) => !isReferenced(project))];
  const projectKeys = new Set(
    referenced.flatMap((project) => {
      const key = deriveMultiRepoKey(project.multiRepo);
      return key === null ? [] : [key];
    }),
  );
  if (projectKeys.size === 0) return [];
  return input.environments.flatMap((environment) => {
    if (
      environment.connection.phase !== "connected" ||
      !canSetUpMultiRepoProjects(environment.serverConfig?.environment.capabilities) ||
      !input.canSetUp(environment.environmentId)
    ) {
      return [];
    }
    const setup = listMultiRepoProjectsToSetUp(projects, environment.environmentId).find(
      (candidate) => projectKeys.has(candidate.key),
    );
    return setup ? [{ environment, setup }] : [];
  });
}

/**
 * "Manage repositories" and "Set up on <machine>" items for a project's menu; built only
 * when the menu opens.
 */
export function buildMultiRepoProjectSetupMenu(
  input: MultiRepoSetupInput<MultiRepoSetupEnvironment>,
) {
  const setupsByAction = new Map<MultiRepoSetupMenuId, CommandPaletteMultiRepoSetup>();
  const membersByAction = new Map<MultiRepoSetupMenuId, ScopedProjectRef>();
  const memberItems: Array<ContextMenuItem<MultiRepoSetupMenuId>> = [];
  const groups = input.projects.filter(
    (project) =>
      project.multiRepo != null &&
      input.projectRefs.some(
        (ref) => ref.environmentId === project.environmentId && ref.projectId === project.id,
      ),
  );
  for (const project of groups) {
    const id: MultiRepoSetupMenuId = `multi-repo-setup:members:${project.environmentId}:${project.id}`;
    membersByAction.set(id, { environmentId: project.environmentId, projectId: project.id });
    const environment = input.environments.find(
      (candidate) => candidate.environmentId === project.environmentId,
    );
    memberItems.push({
      id,
      // Each machine keeps its own list, so a project on several names the machine.
      label:
        groups.length > 1 && environment
          ? m(msg("Manage repositories on {environment}", { environment: environment.label }))
          : m(msg("Manage repositories")),
      icon: "folder",
    });
  }
  const items: Array<ContextMenuItem<MultiRepoSetupMenuId>> = [];
  for (const { environment, setup } of listMultiRepoSetupTargets(input)) {
    const id: MultiRepoSetupMenuId = `multi-repo-setup:${environment.environmentId}`;
    setupsByAction.set(id, { environmentId: environment.environmentId, setup });
    items.push({
      id,
      label: m(msg("Set up on {environment}", { environment: environment.label })),
      icon: "folder",
    });
  }
  const menuItems: ReadonlyArray<ContextMenuItem<MultiRepoSetupMenuId>> = [
    ...memberItems,
    ...(items.length > 1
      ? [
          {
            id: "multi-repo-setup:submenu" as const,
            label: m(msg("Set up on...")),
            icon: "folder",
            children: items,
          },
        ]
      : items),
  ];
  return { items: menuItems, setupsByAction, membersByAction };
}

/** Runs a clicked item of `buildMultiRepoProjectSetupMenu`. */
export function runMultiRepoSetupMenuAction(
  menu: ReturnType<typeof buildMultiRepoProjectSetupMenu>,
  id: MultiRepoSetupMenuId,
) {
  const members = menu.membersByAction.get(id);
  if (members) return openMultiRepoMembers(members);
  const multiRepoSetup = menu.setupsByAction.get(id);
  if (multiRepoSetup) openCommandPalette({ multiRepoSetup });
}
