// scripts/resolve-author-handles.js
// Reads commits.json and emits { "<author email>": "<github login>" } for
// scripts/lib/render-changelog.js to credit contributors with.
//
// Git only knows the name the committing machine was configured with — "Alexander
// Logvinov" credits a person without pointing at an account. GitHub knows which
// account authored a commit, so the release job asks it once per commit and hands
// the answer to the renderer, instead of the renderer carrying a hardcoded map
// that goes stale the moment someone new contributes.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

// commits → { email: { login, name } }, one lookup per distinct sha. A lookup
// that fails or that GitHub cannot attribute to an account contributes nothing:
// the release notes then fall back to the plain git name, which is what they did
// before this existed. Losing the whole credits block to one 403 would be the
// worse trade.
export async function buildHandleMap(commits, lookupCommitAuthor) {
  const handles = {};
  const asked = new Set();
  for (const commit of commits) {
    if (!commit.hash || asked.has(commit.hash)) continue;
    asked.add(commit.hash);
    let author;
    try {
      author = await lookupCommitAuthor(commit.hash);
    } catch {
      continue;
    }
    if (!author?.email || !author.login) continue;
    handles[author.email.toLowerCase()] = { login: author.login, name: author.name ?? "" };
  }
  return handles;
}

// The GitHub REST lookup the release job injects. `.author` is the account
// GitHub matched the commit to (null for an unmatched email); `.commit.author`
// is what git itself recorded, which is the key the renderer joins on.
//
// The profile name needs its own call — the commit payload carries only the git
// name, and someone who commits as `artk0de` has "Arthur Korochansky" nowhere
// but their profile. Profiles are fetched once per login, since a release range
// is dozens of commits from a handful of people.
export function githubCommitAuthorLookup(repo, token) {
  const headers = { accept: "application/vnd.github+json", ...(token ? { authorization: `Bearer ${token}` } : {}) };
  const profileNames = new Map();

  const profileName = async (login) => {
    if (profileNames.has(login)) return profileNames.get(login);
    const response = await fetch(`https://api.github.com/users/${login}`, { headers });
    const name = response.ok ? ((await response.json()).name ?? "") : "";
    profileNames.set(login, name);
    return name;
  };

  return async (hash) => {
    const response = await fetch(`https://api.github.com/repos/${repo}/commits/${hash}`, { headers });
    if (!response.ok) return null;
    const body = await response.json();
    const login = body.author?.login;
    if (!login) return null;
    return { email: body.commit?.author?.email ?? "", login, name: await profileName(login) };
  };
}

// CLI entry only when run directly (importing for tests must not hit the network).
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const commits = JSON.parse(readFileSync(process.argv[2] ?? "commits.json", "utf8"));
  const lookup = githubCommitAuthorLookup(
    process.env.GITHUB_REPOSITORY,
    process.env.GH_TOKEN ?? process.env.GITHUB_TOKEN,
  );
  process.stdout.write(JSON.stringify(await buildHandleMap(commits, lookup), null, 2));
}
