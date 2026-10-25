import type { Workspace } from '../../domain/types';
import type { PersistenceAdapter } from './db';

export type WorkspaceWriteOutcome =
  /** The stored revision was not newer and the record was written. */
  | 'saved'
  /** Another tab committed a strictly newer revision; this write was dropped. */
  | 'conflict'
  /** The stored record is gone, so another tab deleted the workspace. */
  | 'deleted'
  /** The caller had already removed it locally; there was nothing to write. */
  | 'skipped';

/**
 * Persists an update to an existing workspace.
 *
 * The stored record is authoritative. A missing record means another tab
 * deleted the workspace, so an update must not recreate it; only the explicit
 * create/import paths may insert a workspace. A newer stored revision wins.
 */
export async function persistWorkspaceUpdate(
  adapter: PersistenceAdapter,
  workspace: Workspace,
): Promise<Exclude<WorkspaceWriteOutcome, 'skipped'>> {
  return adapter.transaction(['workspaces'], async (tx) => {
    const stored = await tx.get<Workspace>('workspaces', workspace.id);
    if (!stored) return 'deleted';
    if (stored.updatedAt > workspace.updatedAt) return 'conflict';
    await tx.put('workspaces', workspace);
    return 'saved';
  });
}
