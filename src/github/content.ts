import { formatContent, getRepositoryReadmeContent } from "./github";
import type { GitHubRepository } from "./github";

export type GitHubRepositoryContent = {
  repoFullName: string;
  defaultBranch: string;
  description: string;
  topic: string[];
  content: string;
};

export type RepositoryContentEnrichment = {
  repository: GitHubRepositoryContent;
  source: "readme" | "metadata";
};

export async function enrichRepositoryContent(options: {
  repository: GitHubRepository;
  githubToken: string;
  defaultBranch?: string;
}): Promise<RepositoryContentEnrichment> {
  const defaultBranch = options.defaultBranch?.trim() || options.repository.defaultBranch;
  const readme = await getRepositoryReadmeContent(options.repository.fullName, defaultBranch, options.githubToken);
  const description = [options.repository.fullName, options.repository.description].filter(Boolean).join(" ").trim();
  const content = formatContent(description, options.repository.topics, readme);

  return {
    repository: {
      repoFullName: options.repository.fullName,
      defaultBranch,
      description: options.repository.description.trim(),
      topic: options.repository.topics,
      content: content || options.repository.fullName,
    },
    source: readme ? "readme" : "metadata",
  };
}
