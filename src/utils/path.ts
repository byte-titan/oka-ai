import { isAbsolute, join } from "path";

export function resolvePath(pathValue: string, relativeTo = process.cwd()): string {
  if (isAbsolute(pathValue)) return pathValue;
  if (pathValue.startsWith("~/")) {
    const home = process.env.HOME || "";
    return join(home, pathValue.slice(2));
  }
  return join(relativeTo, pathValue);
}
