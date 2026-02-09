/**
 * Workspace bootstrap command.
 *
 * Run: bun run src/setup.ts
 */

import { ensureWorkspaceBootstrap, resolveWorkspacePaths } from "./workspace";

async function main(): Promise<void> {
  const paths = resolveWorkspacePaths();
  const result = await ensureWorkspaceBootstrap(paths, { logPrefix: "[setup]" });

  console.log("Workspace ready");
  console.log(`- workspace: ${paths.workspaceDir}`);
  console.log(`- agents: ${paths.agentsFile}`);
  console.log(`- heartbeat: ${paths.heartbeatFile}`);
  console.log(`- copied defaults: ${result.copiedFiles.length}`);
  console.log(`- created runtime files: ${result.createdFiles.length}`);
}

await main();

