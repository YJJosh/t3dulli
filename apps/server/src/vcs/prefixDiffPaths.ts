import { quoteGitPatchPath, unquoteGitPatchPath } from "@t3tools/shared/gitPatchPath";

/** Git's `--src-prefix`/`--dst-prefix` for a patch whose paths sit below `prefix`. */
export function prefixedPatchRenderArgs(prefix: string): ReadonlyArray<string> {
  return [`--src-prefix=a/${prefix}/`, `--dst-prefix=b/${prefix}/`];
}

// Git's patch prefixes skip rename and copy headers, which name bare paths.
const RENAME_OR_COPY_HEADER = /^(rename|copy) (from|to) (.+)$/gm;

/** Puts `prefix` before the paths of a patch rendered with `prefixedPatchRenderArgs`. */
export function prefixPatchHeaders(patch: string, prefix: string): string {
  return patch.replace(
    RENAME_OR_COPY_HEADER,
    (_line, kind: string, side: string, token: string) =>
      `${kind} ${side} ${quoteGitPatchPath(`${prefix}/${unquoteGitPatchPath(token)}`)}`,
  );
}

/** Puts `prefix` before every path of `git diff --numstat -z` output. */
export function prefixNumstat(numstat: string, prefix: string): string {
  const records = numstat.split("\0");
  for (let index = 0; index < records.length; index += 1) {
    const record = records[index]!;
    const counts = /^(\d+|-)\t(\d+|-)\t/.exec(record);
    if (!counts) continue;
    const path = record.slice(counts[0].length);
    if (path.length > 0) {
      records[index] = `${counts[0]}${prefix}/${path}`;
      continue;
    }
    // A rename leaves the path empty and names the old and new paths in the next two records.
    for (const offset of [1, 2]) {
      const renamed = records[index + offset];
      if (renamed !== undefined && renamed.length > 0) {
        records[index + offset] = `${prefix}/${renamed}`;
      }
    }
    index += 2;
  }
  return records.join("\0");
}
