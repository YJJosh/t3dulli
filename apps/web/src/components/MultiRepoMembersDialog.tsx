import { useAtomValue } from "@effect/atom-react";
import {
  getCloneDestinationPath,
  parseMultiRepoCloneInput,
} from "@t3tools/client-runtime/operations/projects";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import type { ProjectMultiRepoMembersResult, ScopedProjectRef } from "@t3tools/contracts";
import { FolderGitIcon } from "lucide-react";
import { T, useGT, Var } from "gt-react";
import { useId, useState } from "react";
import { create } from "zustand";

import { readProject, subscribeProject, useProject } from "../state/entities";
import { projectEnvironment } from "../state/projects";
import { useEnvironmentQuery } from "../state/query";
import { revisionedQuery } from "../state/revisionedQuery";
import { sourceControlEnvironment } from "../state/sourceControl";
import { useAtomCommand } from "../state/use-atom-command";
import { Button } from "./ui/button";
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "./ui/dialog";
import { Input } from "./ui/input";
import { Label } from "./ui/label";
import { toastManager } from "./ui/toast";

const useRequest = create<{
  projectRef: ScopedProjectRef | null;
  session: number;
  /** Bumped by every change, so a reopened dialog reads the list again. */
  revision: number;
}>(() => ({
  projectRef: null,
  session: 0,
  revision: 0,
}));

let endRequestWithProject: (() => void) | null = null;

/** Opens the dialog that adds or removes repositories of a multi-repo project. */
export function openMultiRepoMembers(projectRef: ScopedProjectRef) {
  if (readProject(projectRef)?.multiRepo == null) return;
  endRequestWithProject?.();
  endRequestWithProject = subscribeProject(projectRef, (project) => {
    if (project === null) close();
  });
  useRequest.setState((state) => ({ projectRef, session: state.session + 1 }));
}

function close() {
  endRequestWithProject?.();
  endRequestWithProject = null;
  useRequest.setState({ projectRef: null });
}

export function MultiRepoMembersDialogHost() {
  const projectRef = useRequest((state) => state.projectRef);
  const session = useRequest((state) => state.session);
  return projectRef ? <MultiRepoMembersDialog key={session} projectRef={projectRef} /> : null;
}

type Busy = { readonly kind: "add" | "remove" | "clone"; readonly path: string } | null;

function MultiRepoMembersDialog({ projectRef }: { projectRef: ScopedProjectRef }) {
  const gt = useGT();
  const id = useId();
  const project = useProject(projectRef);
  const { environmentId, projectId } = projectRef;
  // Read again on every open and after every change here: another client or an agent can
  // change the list too.
  const session = useRequest((state) => state.session);
  const revision = useRequest((state) => state.revision);
  const listed = useEnvironmentQuery(
    revisionedQuery(
      projectEnvironment.multiRepoMembers({ environmentId, input: { projectId } }),
      `${session}:${revision}`,
    ),
  );
  // Each change answers with the new lists, so they show before the query reruns.
  const [latest, setLatest] = useState<ProjectMultiRepoMembersResult | null>(null);
  const lists = latest ?? listed.data ?? null;
  const changed = (result: ProjectMultiRepoMembersResult) => {
    setLatest(result);
    useRequest.setState((state) => ({ revision: state.revision + 1 }));
  };
  const [busy, setBusy] = useState<Busy>(null);
  const [cloneText, setCloneText] = useState("");
  const addMember = useAtomCommand(projectEnvironment.addMultiRepoMember, { reportFailure: false });
  const removeMember = useAtomCommand(projectEnvironment.removeMultiRepoMember, {
    reportFailure: false,
  });
  const cloneRepository = useAtomCommand(sourceControlEnvironment.cloneRepository, {
    reportFailure: false,
  });
  const canChange = useAtomValue(
    projectEnvironment.addMultiRepoMember.permissionAtom(environmentId),
  );
  const clone = parseMultiRepoCloneInput(cloneText);
  // One at a time, so a failed clone never leaves the others half added.
  const cloneMember =
    clone.invalid.length === 0 && clone.members.length === 1 ? clone.members[0]! : null;
  const cloneTaken =
    cloneMember !== null &&
    [...(lists?.members ?? []), ...(lists?.candidates ?? [])].some(
      (path) => path.toLowerCase() === cloneMember.path.toLowerCase(),
    );

  const fail = (title: string, result: Parameters<typeof isAtomCommandInterrupted>[0]) => {
    if (result._tag !== "Failure" || isAtomCommandInterrupted(result)) return;
    const error = squashAtomCommandFailure(result);
    toastManager.add({
      type: "error",
      title,
      description: error instanceof Error ? error.message : gt("An error occurred."),
    });
  };

  const add = async (path: string) => {
    setBusy({ kind: "add", path });
    const result = await addMember({ environmentId, input: { projectId, path } });
    setBusy(null);
    if (result._tag === "Success") changed(result.value);
    else fail(gt("Could not add {path}", { path }), result);
  };

  const remove = async (path: string) => {
    setBusy({ kind: "remove", path });
    const result = await removeMember({ environmentId, input: { projectId, path } });
    setBusy(null);
    if (result._tag === "Success") changed(result.value);
    else fail(gt("Could not remove {path}", { path }), result);
  };

  const cloneAndAdd = async () => {
    if (cloneMember === null || project === null || cloneTaken) return;
    setBusy({ kind: "clone", path: cloneMember.path });
    const cloned = await cloneRepository({
      environmentId,
      input: {
        remoteUrl: cloneMember.remoteUrl,
        destinationPath: getCloneDestinationPath(project.workspaceRoot, cloneMember.path),
      },
    });
    if (cloned._tag !== "Success") {
      setBusy(null);
      fail(gt("Could not clone {path}", { path: cloneMember.path }), cloned);
      return;
    }
    setCloneText("");
    await add(cloneMember.path);
  };

  return (
    <Dialog open onOpenChange={(open) => !open && close()}>
      <DialogPopup className="max-w-lg">
        <DialogHeader>
          <DialogTitle>
            <T>Repositories</T>
          </DialogTitle>
          <DialogDescription>
            <T>
              Repositories that <Var>{project?.title ?? ""}</Var> groups. New worktrees get the
              change; existing ones keep the repositories they were made with.
            </T>
          </DialogDescription>
        </DialogHeader>
        <DialogPanel>
          <div className="flex flex-col gap-4">
            <section className="flex flex-col gap-1">
              {lists === null ? (
                <p className="text-muted-foreground text-sm">
                  {listed.error ? gt("Could not read the repositories.") : gt("Loading…")}
                </p>
              ) : (
                lists.members.map((path) => (
                  <div key={path} className="flex items-center gap-2 text-sm">
                    <FolderGitIcon className="size-4 shrink-0 text-muted-foreground" aria-hidden />
                    <span className="min-w-0 flex-1 truncate">{path}</span>
                    <Button
                      size="xs"
                      variant="ghost"
                      disabled={!canChange || busy !== null || lists.members.length === 1}
                      onClick={() => void remove(path)}
                    >
                      {busy?.kind === "remove" && busy.path === path
                        ? gt("Removing…")
                        : gt("Remove")}
                    </Button>
                  </div>
                ))
              )}
            </section>
            {lists !== null && lists.candidates.length > 0 ? (
              <section className="flex flex-col gap-1">
                <h3 className="font-medium text-muted-foreground text-xs">
                  <T>In the project folder, not added</T>
                </h3>
                {lists.candidates.map((path) => (
                  <div key={path} className="flex items-center gap-2 text-sm">
                    <FolderGitIcon className="size-4 shrink-0 text-muted-foreground" aria-hidden />
                    <span className="min-w-0 flex-1 truncate">{path}</span>
                    <Button
                      size="xs"
                      variant="outline"
                      disabled={!canChange || busy !== null}
                      onClick={() => void add(path)}
                    >
                      {busy?.kind === "add" && busy.path === path ? gt("Adding…") : gt("Add")}
                    </Button>
                  </div>
                ))}
              </section>
            ) : null}
            <form
              className="flex flex-col gap-1.5"
              onSubmit={(event) => {
                event.preventDefault();
                void cloneAndAdd();
              }}
            >
              <Label htmlFor={`${id}-clone`}>
                <T>Clone a repository into the project</T>
              </Label>
              <div className="flex gap-2">
                <Input
                  id={`${id}-clone`}
                  className="flex-1"
                  placeholder={gt("Git URL or owner/repo")}
                  value={cloneText}
                  disabled={!canChange || busy !== null}
                  onChange={(event) => setCloneText(event.target.value)}
                />
                <Button
                  type="submit"
                  variant="outline"
                  disabled={!canChange || busy !== null || cloneMember === null || cloneTaken}
                >
                  {busy?.kind === "clone" ? gt("Cloning…") : gt("Clone and add")}
                </Button>
              </div>
              {cloneTaken ? (
                <p className="text-destructive text-xs">
                  <T>
                    The project folder already has <Var>{cloneMember?.path}</Var>.
                  </T>
                </p>
              ) : null}
            </form>
          </div>
        </DialogPanel>
        <DialogFooter>
          <Button variant="outline" onClick={close}>
            <T>Done</T>
          </Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}
