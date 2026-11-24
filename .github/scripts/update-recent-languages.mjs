import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import { setTimeout as sleep } from 'node:timers/promises';

const run = promisify(execFile);
const START = '<!-- RECENT-LANGUAGES:START -->';
const END = '<!-- RECENT-LANGUAGES:END -->';
const EMPTY = 'No recent public coding activity.';
const unavailable = (error) => [404, 409, 410, 422].includes(error.status);

export async function githubRequest(route, { token, fetchImpl = fetch, sleepImpl = sleep } = {}) {
  const headers = { Accept: 'application/vnd.github+json' };
  if (token) headers.Authorization = `Bearer ${token}`;
  const maxAttempts = 4;
  const pause = async (delay, attempt, reason) => {
    console.warn(`GitHub request ${attempt}/${maxAttempts} failed for ${route}: ${reason}. Retrying in ${delay / 1000}s.`);
    await sleepImpl(delay);
  };

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    let response;
    let delay = 1000 * 2 ** (attempt - 1);
    try {
      response = await fetchImpl(`https://api.github.com${route}`, {
        headers,
        signal: AbortSignal.timeout(30_000),
      });
      if (response.ok) return await response.json();
    } catch (error) {
      const retryable = error instanceof TypeError || ['TimeoutError', 'AbortError'].includes(error.name);
      if (!retryable || attempt === maxAttempts) {
        const detail = error.cause?.code || error.message;
        throw new Error(`GitHub request failed for ${route} after ${attempt} attempts: ${detail}`, { cause: error });
      }
      await pause(delay, attempt, error.message);
      continue;
    }

    const error = Object.assign(new Error(`GitHub returned ${response.status} for ${route}`), {
      status: response.status,
    });
    const retryAfter = response.headers?.get('retry-after');
    const remaining = response.headers?.get('x-ratelimit-remaining');
    let retryAfterDelay;
    if (retryAfter) {
      const seconds = Number(retryAfter);
      retryAfterDelay = Number.isFinite(seconds)
        ? seconds * 1000
        : Date.parse(retryAfter) - Date.now();
    }
    const hasRetryAfter = Number.isFinite(retryAfterDelay) && retryAfterDelay >= 0;
    const rateLimited = response.status === 429 || (response.status === 403 && (hasRetryAfter || remaining === '0'));
    const retryable = rateLimited || response.status === 408 || (response.status >= 500 && response.status <= 599);
    if (!retryable || attempt === maxAttempts) throw error;

    if (hasRetryAfter) {
      delay = retryAfterDelay;
    } else if (rateLimited) {
      const reset = Number(response.headers?.get('x-ratelimit-reset')) * 1000;
      delay = remaining === '0' && reset > 0
        ? Math.max(0, reset - Date.now())
        : 60_000 * 2 ** (attempt - 1);
    }
    if (delay > 60_000) {
      error.message += '; required retry delay exceeds 60 seconds';
      throw error;
    }
    await pause(delay, attempt, `HTTP ${response.status}`);
  }
}

export async function fetchPushCommits(event, request) {
  const { before, head } = event.payload;
  if (!head || /^0+$/.test(head)) return [];
  if (!before || /^0+$/.test(before)) return [head];

  const commits = [];
  try {
    for (let page = 1; ; page++) {
      const comparison = await request(
        `/repos/${event.repo.name}/compare/${before}...${head}?per_page=100&page=${page}`,
      );
      commits.push(...comparison.commits.map((commit) => commit.sha));
      if (comparison.commits.length < 100) break;
    }
    return commits;
  } catch (error) {
    if (!unavailable(error)) throw error;
    console.warn(`Cannot compare a push in ${event.repo.name}; using its head commit.`);
    return [head];
  }
}

export async function fetchCommit(repo, sha, request) {
  let commit;
  const files = [];
  for (let page = 1; ; page++) {
    const result = await request(
      `/repos/${repo}/commits/${sha}?per_page=100&page=${page}`,
    );
    commit ??= result;
    files.push(...(result.files ?? []));
    if ((result.files?.length ?? 0) < 100) break;
  }
  return { ...commit, files };
}

export async function collectRecentFiles(username, request, now = Date.now()) {
  const cutoff = new Date(now).getTime() - 14 * 24 * 60 * 60 * 1000;
  const eventsSeen = new Set();
  const commitsSeen = new Set();
  const files = [];

  for (let page = 1; page <= 3; page++) {
    const events = await request(
      `/users/${encodeURIComponent(username)}/events/public?per_page=100&page=${page}`,
    );
    for (const event of events) {
      if (new Date(event.created_at).getTime() < cutoff) continue;
      if (event.type !== 'PushEvent' || event.actor.login.toLowerCase() !== username.toLowerCase()) continue;
      const eventKey = event.id ?? `${event.repo.name}:${event.payload.push_id}`;
      if (eventsSeen.has(eventKey)) continue;
      eventsSeen.add(eventKey);

      for (const sha of await fetchPushCommits(event, request)) {
        const commitKey = `${event.repo.name}:${sha}`;
        if (commitsSeen.has(commitKey)) continue;
        commitsSeen.add(commitKey);
        let commit;
        try {
          commit = await fetchCommit(event.repo.name, sha, request);
        } catch (error) {
          if (!unavailable(error)) throw error;
          console.warn(`Skipping an unavailable public commit in ${event.repo.name}.`);
          continue;
        }
        if (commit.author?.login?.toLowerCase() !== username.toLowerCase()) continue;
        if (commit.parents.length > 1) continue;
        files.push(...commit.files.map(({ filename, additions, deletions, changes, status, patch }) => ({
          path: filename,
          additions,
          deletions,
          changes,
          status,
          patch,
        })));
      }
    }
    if (events.length < 100 || events.some((event) => new Date(event.created_at).getTime() < cutoff)) break;
  }
  return files;
}

export async function analyzeFiles(files, source) {
  const originalDirectory = process.cwd();
  const sandbox = await mkdtemp(join(tmpdir(), 'recent-languages-'));
  const engine = join(sandbox, 'engine');
  try {
    await run('git', ['clone', '--local', '--no-hardlinks', '--quiet', resolve(source), engine]);
    await run('git', ['remote', 'remove', 'origin'], { cwd: engine });
    const { runLinguist } = await import(pathToFileURL(join(engine, 'src/linguist-analyzer.ts')).href);
    const { createLanguageStats } = await import(pathToFileURL(join(engine, 'src/language-stats.ts')).href);
    // Upstream clears its working tree, so execute it only in this disposable clone.
    process.chdir(engine);
    const languages = await runLinguist(files);
    return languages.length ? createLanguageStats(languages) : EMPTY;
  } finally {
    process.chdir(originalDirectory);
    await rm(sandbox, { recursive: true, force: true });
  }
}

export function replaceReadmeSection(readme, content) {
  const start = readme.indexOf(START);
  const end = readme.indexOf(END);
  if (start < 0 || end < start || readme.indexOf(START, start + START.length) >= 0 || readme.indexOf(END, end + END.length) >= 0) {
    throw new Error('README must contain one matching pair of recent-language markers.');
  }
  const escapedContent = content.trimEnd().replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
  return `${readme.slice(0, start + START.length)}\n<table align="center">\n<tr><td>\n<pre>${escapedContent}</pre>\n</td></tr>\n</table>\n${readme.slice(end)}`;
}

export async function updateReadme(readmePath, content) {
  const current = await readFile(readmePath, 'utf8');
  const updated = replaceReadmeSection(current, content);
  if (updated === current) return false;
  await writeFile(readmePath, updated);
  return true;
}

export async function main(env = process.env) {
  const username = env.USERNAME || env.GITHUB_REPOSITORY_OWNER;
  if (!username) throw new Error('USERNAME or GITHUB_REPOSITORY_OWNER is required.');
  const readmePath = resolve(env.README_PATH || 'README.md');
  const request = (route) => githubRequest(route, { token: env.GH_TOKEN });
  const files = await collectRecentFiles(username, request);
  if (files.length && !env.RECENT_LANGUAGES_SOURCE) {
    throw new Error('RECENT_LANGUAGES_SOURCE must point to the pinned upstream checkout.');
  }
  const content = files.length ? await analyzeFiles(files, env.RECENT_LANGUAGES_SOURCE) : EMPTY;
  const changed = await updateReadme(readmePath, content);
  console.log(changed ? 'Updated recent languages in README.' : 'Recent languages are unchanged.');
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
