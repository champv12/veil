import { constants } from "node:fs";
import { lstat, open, readdir, realpath } from "node:fs/promises";
import path from "node:path";

const RESERVED = [".git", ".veil", ".veil-private", ".veil-state", ".veil-runs"];

/** Validate every path that will cross into an evaluator sandbox. */
export async function validateEvaluationTree(rootDirectory: string, exclusions: string[] = []): Promise<string> {
  const requested = path.resolve(rootDirectory);
  const rootStatus = await lstat(requested);
  if (!rootStatus.isDirectory() || rootStatus.isSymbolicLink()) throw new Error("Evaluation source must be a real directory");
  const root = await realpath(requested);
  const seen = new Map<string, string>();
  const excluded = [...RESERVED, ...exclusions];
  const visit = async (directory: string, relativeDirectory = ""): Promise<void> => {
    const canonical = await realpath(directory);
    if (canonical !== root && !canonical.startsWith(`${root}${path.sep}`)) throw new Error("Evaluation directory escapes its root");
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const relative = relativeDirectory ? path.posix.join(relativeDirectory, entry.name) : entry.name;
      if (excluded.some((item) => relative === item || relative.startsWith(`${item}/`))) continue;
      const portable = relative.normalize("NFC").toLocaleLowerCase("en-US");
      const prior = seen.get(portable);
      if (prior !== undefined) throw new Error(`Evaluation paths collide across supported filesystems: ${prior} and ${relative}`);
      seen.set(portable, relative);
      const absolute = path.join(directory, entry.name);
      const status = await lstat(absolute);
      if (status.isSymbolicLink()) throw new Error(`Evaluation source contains a symbolic link: ${relative}`);
      if (status.isDirectory()) await visit(absolute, relative);
      else if (status.isFile()) {
        const handle = await open(absolute, constants.O_RDONLY | constants.O_NOFOLLOW);
        try {
          const opened = await handle.stat();
          if (!opened.isFile() || opened.nlink !== 1) throw new Error(`Evaluation source contains a hard-linked file: ${relative}`);
        } finally { await handle.close(); }
      } else throw new Error(`Evaluation source contains a special file: ${relative}`);
    }
  };
  await visit(root);
  return root;
}
