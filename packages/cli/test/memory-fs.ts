import type { FileSystem } from '../src/console/console';

/** An in-memory file system for console tests. */
export function memoryFs(
  files: Record<string, string> = {},
): FileSystem & { files: Map<string, string> } {
  const map = new Map(Object.entries(files));
  return {
    files: map,
    readFile(path) {
      const text = map.get(path);
      if (text === undefined) throw new Error(`ENOENT: ${path}`);
      return text;
    },
    writeFile(path, text) {
      map.set(path, text);
    },
  };
}
