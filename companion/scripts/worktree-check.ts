// Times the worktree path for one PR without an agent:
//   node scripts/worktree-check.ts ProjetoParcas/mynah#14
import { loadConfig } from '../src/config.ts';
import { prDiff, resolvePr } from '../src/pr.ts';
import { findClone } from '../src/repo.ts';
import { acquireLock, prepareWorktree, worktreePath } from '../src/worktree.ts';

const m = (process.argv[2] ?? '').match(/^([^/]+)\/([^#]+)#(\d+)$/);
if (!m) throw new Error('usage: worktree-check.ts owner/repo#n');
const [owner, repo, n] = [m[1], m[2], Number(m[3])];
const t0 = Date.now();
const lap = (label: string) => console.log(`${String(Date.now() - t0).padStart(6)}ms  ${label}`);

const config = loadConfig();
const clone = await findClone(config, owner, repo);
lap(`clone: ${clone}`);
if (!clone) process.exit(1);
const ctx = await resolvePr(clone, { owner, repo, number: n });
lap(`resolved head ${ctx.headSha.slice(0, 12)} base ${ctx.baseSha.slice(0, 12)} "${ctx.title}"`);
const dir = worktreePath(config, owner, repo, n);
const release = await acquireLock(dir, new AbortController().signal);
const before = Date.now();
await prepareWorktree(clone, dir, ctx.headSha);
lap(`worktree ready at ${dir} (prepare took ${Date.now() - before}ms)`);
release();
const { diff, truncated } = await prDiff(clone, ctx.baseSha, ctx.headSha);
lap(`diff ${diff.length} chars${truncated ? ' (truncated)' : ''}`);
