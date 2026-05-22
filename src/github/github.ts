type GitHubRepositoryResponse = {
  full_name: string;
  default_branch: string;
  description: string | null;
  topics?: string[];
};

type GitHubTreesResponse = {
  tree?: GitHubTreeItem[];
};

type GitHubTreeItem = {
  path: string;
  type: string;
  url: string;
};

type GitHubBlobResponse = {
  content?: string;
  encoding?: string;
};

type FetchProgress = {
  pages: number;
  repositories: number;
};

export type GitHubRepository = {
  fullName: string;
  defaultBranch: string;
  description: string;
  topics: string[];
};

export type GitHubStarredRepository = GitHubRepository;

export async function fetchAllStarredRepositories(
  githubToken: string,
  onProgress?: (progress: FetchProgress) => void,
): Promise<GitHubStarredRepository[]> {
  const repositories: GitHubStarredRepository[] = [];
  let pages = 0;
  let nextUrl: string | undefined = "https://api.github.com/user/starred?per_page=100&sort=created&direction=desc";

  while (nextUrl) {
    const response = await fetchGitHub(nextUrl, githubToken);
    const page = (await response.json()) as GitHubRepositoryResponse[];

    repositories.push(...page.map(normalizeRepositoryResponse));
    pages += 1;
    onProgress?.({ pages, repositories: repositories.length });
    nextUrl = getNextPageUrl(response.headers.get("link"));
  }

  return repositories;
}

export async function fetchRepositoryByFullName(fullName: string, githubToken: string): Promise<GitHubRepository> {
  const { owner, name } = parseRepositoryFullName(fullName);
  const response = await fetchGitHub(
    `https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}`,
    githubToken,
  );

  return normalizeRepositoryResponse((await response.json()) as GitHubRepositoryResponse);
}

export async function getRepositoryReadmeContent(
  fullName: string,
  defaultBranch: string,
  githubToken: string,
): Promise<string> {
  const { owner, name } = parseRepositoryFullName(fullName);
  const treeResponse = await fetch(
    `https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}/git/trees/${encodeURIComponent(defaultBranch)}`,
    {
      headers: githubHeaders(githubToken),
    },
  );

  if (!treeResponse.ok) {
    return "";
  }

  const trees = (await treeResponse.json()) as GitHubTreesResponse;
  const readmeUrl = filterReadmeUrl(trees.tree ?? []);

  if (!readmeUrl) {
    return "";
  }

  const blobResponse = await fetch(readmeUrl, {
    headers: githubHeaders(githubToken),
  });

  if (!blobResponse.ok) {
    return "";
  }

  const blob = (await blobResponse.json()) as GitHubBlobResponse;

  if (blob.encoding !== "base64" || !blob.content) {
    return "";
  }

  return Buffer.from(blob.content, "base64").toString("utf8");
}

export function formatContent(description: string, topics: string[], readme?: string): string {
  return [topics.filter(Boolean).join(","), description.trim(), readme?.trim()].filter(Boolean).join("\n");
}

function normalizeRepositoryResponse(repository: GitHubRepositoryResponse): GitHubRepository {
  return {
    fullName: repository.full_name,
    defaultBranch: repository.default_branch,
    description: repository.description ?? "",
    topics: repository.topics ?? [],
  };
}

function parseRepositoryFullName(fullName: string): { owner: string; name: string } {
  const normalized = fullName.trim();
  const [owner, name, extra] = normalized.split("/");

  if (!owner || !name || extra) {
    throw new Error("Repository full name must use the owner/repo format.");
  }

  return { owner, name };
}

function filterReadmeUrl(trees: GitHubTreeItem[]): string | undefined {
  return trees.find((item) => item.type === "blob" && item.path.toLowerCase().startsWith("readme"))?.url;
}

function getNextPageUrl(linkHeader: string | null): string | undefined {
  if (!linkHeader) {
    return undefined;
  }

  const nextLink = linkHeader.split(",").find((part) => part.includes('rel="next"'));
  return nextLink?.match(/<([^>]+)>/)?.[1];
}

async function fetchGitHub(url: string, githubToken: string): Promise<Response> {
  const response = await fetch(url, {
    headers: githubHeaders(githubToken),
  });

  if (!response.ok) {
    throw new Error(await formatGitHubError(response));
  }

  return response;
}

function githubHeaders(githubToken: string): Record<string, string> {
  return {
    Accept: "application/vnd.github+json",
    Authorization: `Bearer ${githubToken}`,
    "X-GitHub-Api-Version": "2022-11-28",
  };
}

async function formatGitHubError(response: Response): Promise<string> {
  const responseText = await response.text();

  try {
    const payload = JSON.parse(responseText) as { message?: string };
    return `GitHub request failed (${response.status}): ${payload.message ?? response.statusText}`;
  } catch {
    return `GitHub request failed (${response.status}): ${responseText || response.statusText}`;
  }
}
