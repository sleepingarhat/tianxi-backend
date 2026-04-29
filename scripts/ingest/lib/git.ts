/**
 * Git helpers — read source commit SHA from hkjc-data clone for audit trail
 */
import { execSync } from 'node:child_process';

export function getRepoHeadCommit(repoDir: string): string | null {
  try {
    const out = execSync('git rev-parse HEAD', { cwd: repoDir, stdio: ['ignore', 'pipe', 'ignore'] });
    return out.toString().trim();
  } catch {
    return null;
  }
}

export function getRepoHeadCommitShort(repoDir: string): string | null {
  const full = getRepoHeadCommit(repoDir);
  return full ? full.slice(0, 12) : null;
}
