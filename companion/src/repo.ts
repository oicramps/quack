import fs from 'node:fs';
import path from 'node:path';
import type { RepoOverrideCheck, RootCheck, WorkspacePrTarget, WorkspaceSaveRequest, WorkspaceStatus } from '@quacksteps/shared';
import { CONFIG_FILE, contractHome, expandHome } from './paths.ts';
import { type Config, hasConfigFile, loadConfig, saveWorkspaceConfig, setRepoPath } from './config.ts';
import { runGit } from './exec.ts';
import { log } from './log.ts';

/** Turns any GitHub remote URL (SSH, HTTPS, ssh://) into "owner/repo", lowercased. */
export function parseGitHubRemote(url: string): string | null {
  const m = url
    .trim()
    .match(/^(?:git@github\.com:|ssh:\/\/git@(?:ssh\.)?github\.com(?::\d+)?\/|https:\/\/(?:[^@/]+@)?github\.com\/|git:\/\/github\.com\/)([^/]+)\/([^/]+?)(?:\.git)?\/?$/i);
  return m ? `${m[1]}/${m[2]}`.toLowerCase() : null;
}

async function originOf(dir: string): Promise<string | null> {
  const res = await runGit(['-C', dir, 'remote', 'get-url', 'origin'], { timeoutMs: 5000 });
  return res.code === 0 ? parseGitHubRemote(res.stdout) : null;
}

function isPermissionError(err: unknown): boolean {
  const code = (err as NodeJS.ErrnoException | undefined)?.code;
  return code === 'EPERM' || code === 'EACCES';
}

function isGitDir(dir: string): boolean {
  try {
    return fs.existsSync(path.join(dir, '.git'));
  } catch {
    return false;
  }
}

function isDirectoryEntry(parent: string, entry: fs.Dirent): boolean {
  if (entry.isDirectory()) return true;
  if (!entry.isSymbolicLink()) return false;
  try {
    return fs.statSync(path.join(parent, entry.name)).isDirectory();
  } catch {
    return false;
  }
}

/** Collects git repository directories up to two levels beneath `roots`, noting any roots denied by OS permissions. */
function candidateDirs(roots: string[]): { dirs: string[]; blockedRoots: string[] } {
  const dirs: string[] = [];
  const blocked: string[] = [];
  const noteBlocked = (p: string) => {
    if (!blocked.includes(p)) blocked.push(p);
    log('permission denied scanning', p);
  };

  for (const root of roots) {
    if (isGitDir(root)) {
      dirs.push(root);
      continue;
    }
    let level1: fs.Dirent[];
    try {
      level1 = fs.readdirSync(root, { withFileTypes: true });
    } catch (err) {
      if (isPermissionError(err)) noteBlocked(root);
      continue;
    }
    for (const e1 of level1) {
      if (e1.name.startsWith('.') || e1.name === 'node_modules' || !isDirectoryEntry(root, e1)) continue;
      const d1 = path.join(root, e1.name);
      if (isGitDir(d1)) {
        dirs.push(d1);
        continue;
      }
      let level2: fs.Dirent[];
      try {
        level2 = fs.readdirSync(d1, { withFileTypes: true });
      } catch (err) {
        if (isPermissionError(err)) noteBlocked(d1);
        continue;
      }
      for (const e2 of level2) {
        if (e2.name.startsWith('.') || e2.name === 'node_modules' || !isDirectoryEntry(d1, e2)) continue;
        const d2 = path.join(d1, e2.name);
        if (isGitDir(d2)) dirs.push(d2);
      }
    }
  }
  return { dirs, blockedRoots: blocked };
}

function inspectRoot(root: string): { check: RootCheck; dirs: string[] } {
  const display = contractHome(root);
  try {
    const stat = fs.statSync(root);
    if (!stat.isDirectory()) return { check: { path: display, state: 'missing', repoCount: 0 }, dirs: [] };
  } catch (err) {
    return { check: { path: display, state: isPermissionError(err) ? 'blocked' : 'missing', repoCount: 0 }, dirs: [] };
  }
  const scan = candidateDirs([root]);
  if (scan.blockedRoots.length > 0 && scan.dirs.length === 0) {
    return { check: { path: display, state: 'blocked', repoCount: 0 }, dirs: [] };
  }
  return {
    check: {
      path: display,
      state: scan.dirs.length > 0 ? 'ok' : 'empty',
      repoCount: scan.dirs.length,
    },
    dirs: scan.dirs,
  };
}

export interface CloneSearchResult {
  clone: string | null;
  blockedRoots: string[];
  overrideIssue?: string;
}

const cache = new Map<string, string>();

/** Finds the local clone for owner/repo and explains why discovery failed when none matches. */
export async function findCloneWithDiagnostics(config: Config, owner: string, repo: string): Promise<CloneSearchResult> {
  const key = `${owner}/${repo}`.toLowerCase();
  const blockedRoots: string[] = [];
  let overrideIssue: string | undefined;

  const override = config.repoPaths[key];
  if (override) {
    let readable = false;
    try {
      fs.statSync(override);
      readable = true;
    } catch (err) {
      if (isPermissionError(err)) {
        blockedRoots.push(override);
        overrideIssue = `Your browser does not have permission to read "${contractHome(override)}" from "repoPaths".`;
      } else {
        overrideIssue = `Configured path "${contractHome(override)}" in ~/.quack/config.json was not found.`;
      }
    }
    if (readable) {
      if (!isGitDir(override)) {
        overrideIssue = `Configured path "${contractHome(override)}" in ~/.quack/config.json is not a git repository.`;
      } else {
        const origin = await originOf(override);
        if (origin === key) return { clone: override, blockedRoots };
        if (origin === null) {
          // Allow custom SSH host aliases or differently named remotes when explicitly mapped in repoPaths.
          log('using repoPaths override with non-github.com origin:', key, override);
          return { clone: override, blockedRoots };
        }
        overrideIssue = `Configured path "${contractHome(override)}" in ~/.quack/config.json has origin "${origin}", not "${key}".`;
      }
    }
    log('repoPaths override rejected:', key, override, overrideIssue);
  }

  const cached = cache.get(key);
  if (cached && isGitDir(cached)) return { clone: cached, blockedRoots };

  const scan = candidateDirs(config.scanRoots);
  for (const r of scan.blockedRoots) {
    if (!blockedRoots.includes(r)) blockedRoots.push(r);
  }

  for (const dir of scan.dirs) {
    const origin = await originOf(dir);
    if (origin) cache.set(origin, dir);
    if (origin === key) return { clone: dir, blockedRoots };
  }
  return { clone: null, blockedRoots, overrideIssue };
}

/** Finds the local clone for owner/repo: config override first, then a scan of scanRoots. */
export async function findClone(config: Config, owner: string, repo: string): Promise<string | null> {
  return (await findCloneWithDiagnostics(config, owner, repo)).clone;
}

/** Inspects configured scanRoots, repoPaths, git availability, and optional PR match without modifying config. */
export async function inspectWorkspace(opts: { pr?: WorkspacePrTarget; configFile?: string } = {}): Promise<WorkspaceStatus> {
  const configFile = opts.configFile ?? CONFIG_FILE;
  const configured = hasConfigFile(configFile);
  const config = loadConfig(configFile);
  const gitRes = await runGit(['--version'], { timeoutMs: 5000 });
  const gitAvailable = gitRes.code === 0;

  const uniqueRepos = new Set<string>();
  const roots: RootCheck[] = [];
  for (const root of config.scanRoots) {
    const { check, dirs } = inspectRoot(root);
    roots.push(check);
    for (const d of dirs) {
      try {
        uniqueRepos.add(fs.realpathSync(d));
      } catch {
        uniqueRepos.add(path.resolve(d));
      }
    }
  }

  const overrides: RepoOverrideCheck[] = [];
  for (const [repoKey, override] of Object.entries(config.repoPaths)) {
    const display = contractHome(override);
    let readable = false;
    try {
      fs.statSync(override);
      readable = true;
    } catch (err) {
      overrides.push({ repo: repoKey, path: display, state: isPermissionError(err) ? 'blocked' : 'missing' });
    }
    if (!readable) continue;
    if (!isGitDir(override)) {
      overrides.push({ repo: repoKey, path: display, state: 'not_git' });
      continue;
    }
    const origin = await originOf(override);
    if (origin && origin !== repoKey) {
      overrides.push({ repo: repoKey, path: display, state: 'mismatch', detail: `Origin is ${origin}` });
      continue;
    }
    overrides.push({ repo: repoKey, path: display, state: 'ok' });
    try {
      uniqueRepos.add(fs.realpathSync(override));
    } catch {
      uniqueRepos.add(path.resolve(override));
    }
  }

  let prMatch: WorkspaceStatus['prMatch'];
  if (opts.pr) {
    const prKey = `${opts.pr.owner}/${opts.pr.repo}`.toLowerCase();
    const { clone, blockedRoots, overrideIssue } = await findCloneWithDiagnostics(config, opts.pr.owner, opts.pr.repo);
    const detail = clone
      ? undefined
      : overrideIssue
        ? overrideIssue
        : blockedRoots.length
          ? `Permission blocked for ${blockedRoots.map(contractHome).join(', ')}`
          : undefined;
    prMatch = {
      repo: prKey,
      found: Boolean(clone),
      ...(clone && { path: contractHome(clone) }),
      ...(detail && { detail }),
    };
  }

  return {
    configured,
    gitAvailable,
    roots,
    overrides,
    totalRepos: uniqueRepos.size,
    ...(prMatch && { prMatch }),
  };
}

/** Updates workspace config (adding a root/clone, or replacing scanRoots/repoPaths) and re-tests it. */
export async function saveWorkspace(
  req: Pick<WorkspaceSaveRequest, 'scanRoots' | 'addPath' | 'repoPaths' | 'pr'>,
  configFile = CONFIG_FILE,
): Promise<{ workspace: WorkspaceStatus; error?: string; notice?: string }> {
  cache.clear();
  let notice: string | undefined;

  if (req.scanRoots !== undefined || req.repoPaths !== undefined) {
    saveWorkspaceConfig({ scanRoots: req.scanRoots, repoPaths: req.repoPaths }, configFile);
  }

  if (req.addPath !== undefined) {
    const cleaned = req.addPath.trim().replace(/^(['"])(.*)\1$/, '$2').trim();
    if (!cleaned) {
      return { workspace: await inspectWorkspace({ pr: req.pr, configFile }), error: 'Enter a folder path.' };
    }
    const abs = path.resolve(expandHome(cleaned));
    const display = contractHome(abs);
    let stat: fs.Stats;
    try {
      stat = fs.statSync(abs);
    } catch (err) {
      const error = isPermissionError(err)
        ? `Your browser does not have permission to read "${display}". Allow it in System Settings → Privacy & Security → Files and Folders, restart the browser, and try again.`
        : `Folder not found: ${display}`;
      return { workspace: await inspectWorkspace({ pr: req.pr, configFile }), error };
    }
    if (!stat.isDirectory()) {
      return { workspace: await inspectWorkspace({ pr: req.pr, configFile }), error: `"${display}" is not a directory.` };
    }

    const hadConfig = hasConfigFile(configFile);
    const current = loadConfig(configFile);
    const defaultActiveRoots = () =>
      hadConfig ? undefined : current.scanRoots.filter((r) => inspectRoot(r).check.state === 'ok');

    if (isGitDir(abs)) {
      const origin = await originOf(abs);
      if (req.pr) {
        const prKey = `${req.pr.owner}/${req.pr.repo}`.toLowerCase();
        if (origin && origin !== prKey) {
          return {
            workspace: await inspectWorkspace({ pr: req.pr, configFile }),
            error: `"${display}" has origin "${origin}", not "${prKey}".`,
          };
        }
        saveWorkspaceConfig({ scanRoots: defaultActiveRoots(), repoPaths: { [prKey]: abs } }, configFile);
        notice = `Linked ${prKey} → ${display}`;
      } else if (origin) {
        saveWorkspaceConfig({ scanRoots: defaultActiveRoots(), repoPaths: { [origin]: abs } }, configFile);
        notice = `Linked ${origin} → ${display}`;
      } else {
        return {
          workspace: await inspectWorkspace({ pr: req.pr, configFile }),
          error: `"${display}" doesn’t have a github.com origin. Open a PR for it first, or run: ~/.quack/bin/quack-companion link "${display}" owner/repo`,
        };
      }
    } else {
      const probed = inspectRoot(abs);
      if (probed.check.state === 'blocked') {
        return {
          workspace: await inspectWorkspace({ pr: req.pr, configFile }),
          error: `Your browser does not have permission to read "${display}". Allow it in System Settings → Privacy & Security → Files and Folders, restart the browser, and try again.`,
        };
      }
      const baseRoots = hadConfig ? current.scanRoots : defaultActiveRoots()!;
      saveWorkspaceConfig({ scanRoots: [...baseRoots, abs] }, configFile);
      notice =
        probed.check.repoCount > 0
          ? `Added ${display} (${probed.check.repoCount} ${probed.check.repoCount === 1 ? 'repo' : 'repos'} found)`
          : `Saved ${display}, but 0 git repositories were found inside (searched 2 levels deep).`;
    }
  }

  return {
    workspace: await inspectWorkspace({ pr: req.pr, configFile }),
    ...(notice && { notice }),
  };
}

/** Links a local git clone to `"owner/repo"` in config.json (auto-detecting `origin` when omitted). */
export async function linkClone(targetPath: string, ownerRepo?: string, configFile?: string): Promise<{ key: string; path: string }> {
  const abs = path.resolve(expandHome(targetPath));
  if (!isGitDir(abs)) throw new Error(`"${abs}" is not a git repository.`);

  let key: string;
  if (ownerRepo) {
    if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(ownerRepo)) {
      throw new Error(`Invalid repository "${ownerRepo}". Expected "owner/repo".`);
    }
    key = ownerRepo.toLowerCase();
  } else {
    const detected = await originOf(abs);
    if (!detected) {
      throw new Error('Could not detect "owner/repo" from origin. Pass it explicitly: quack-companion link <path> <owner/repo>');
    }
    key = detected;
  }

  setRepoPath(key, abs, configFile);
  cache.set(key, abs);
  return { key, path: abs };
}
