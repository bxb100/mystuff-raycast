import {
  Action,
  ActionPanel,
  Alert,
  Color,
  confirmAlert,
  getPreferenceValues,
  Icon,
  List,
  showToast,
  Toast,
} from "@raycast/api";
import { showFailureToast } from "@raycast/utils";
import { useCallback, useEffect, useRef, useState } from "react";
import type { Db9Database, Db9Preferences } from "./github/db";
import { getStoredDatabaseId, isUsableDatabase, listDatabases, storeDatabaseId } from "./github/db";
import {
  type GitHubRepositorySearchResult,
  rebuildAllRepositoryVectors,
  rebuildRepositoryVector,
  searchRepositories,
} from "./github/sql";
import { normalizeSearchQuery } from "./github/translation";

export default function Command() {
  const preferences = getPreferenceValues<Db9Preferences>();
  const db9Token = preferences["db9-client-token"];
  const [databases, setDatabases] = useState<Db9Database[]>([]);
  const [selectedDatabaseId, setSelectedDatabaseId] = useState<string>("");
  const [databaseError, setDatabaseError] = useState<string>();
  const [searchText, setSearchText] = useState("");
  const [resolvedQuery, setResolvedQuery] = useState<string>();
  const [results, setResults] = useState<GitHubRepositorySearchResult[]>([]);
  const [isLoadingDatabase, setIsLoadingDatabase] = useState(true);
  const [isSearching, setIsSearching] = useState(false);
  const searchRequestId = useRef(0);

  useEffect(() => {
    let cancelled = false;

    async function loadDatabases() {
      setIsLoadingDatabase(true);
      setDatabaseError(undefined);

      try {
        const [storedDatabaseId, availableDatabases] = await Promise.all([
          getStoredDatabaseId(),
          listDatabases(db9Token),
        ]);

        if (cancelled) {
          return;
        }

        const usableDatabases = availableDatabases.filter(isUsableDatabase);
        setDatabases(usableDatabases);

        const nextDatabaseId =
          storedDatabaseId && usableDatabases.some((database) => database.id === storedDatabaseId)
            ? storedDatabaseId
            : (usableDatabases[0]?.id ?? "");

        if (!nextDatabaseId) {
          setDatabaseError("No DB9 project is available for this token.");
          return;
        }

        setSelectedDatabaseId(nextDatabaseId);
      } catch (error) {
        if (!cancelled) {
          setDatabaseError(error instanceof Error ? error.message : String(error));
        }
      } finally {
        if (!cancelled) {
          setIsLoadingDatabase(false);
        }
      }
    }

    void loadDatabases();

    return () => {
      cancelled = true;
    };
  }, [db9Token]);

  const runSearch = useCallback(
    async (requestId: number) => {
      if (!selectedDatabaseId) {
        return;
      }

      setIsSearching(true);

      try {
        const normalized = await normalizeSearchQuery(searchText);

        if (requestId !== searchRequestId.current || !selectedDatabaseId) {
          return;
        }

        setResolvedQuery(normalized.translated ? normalized.query : undefined);

        const nextResults = await searchRepositories({
          db9Token,
          databaseId: selectedDatabaseId,
          query: normalized.query,
        });

        if (requestId === searchRequestId.current) {
          setResults(nextResults);
        }
      } catch (error) {
        if (requestId === searchRequestId.current) {
          setResults([]);
          void showFailureToast(error, { title: "GitHub Repository Search Failed" });
        }
      } finally {
        if (requestId === searchRequestId.current) {
          setIsSearching(false);
        }
      }
    },
    [db9Token, searchText, selectedDatabaseId],
  );

  const refreshSearch = useCallback(() => {
    if (!selectedDatabaseId) {
      return;
    }

    const currentRequestId = searchRequestId.current + 1;
    searchRequestId.current = currentRequestId;
    void runSearch(currentRequestId);
  }, [runSearch, selectedDatabaseId]);

  useEffect(() => {
    if (!selectedDatabaseId) {
      return;
    }

    const currentRequestId = searchRequestId.current + 1;
    searchRequestId.current = currentRequestId;

    const timer = setTimeout(() => {
      void runSearch(currentRequestId);
    }, 350);

    return () => {
      clearTimeout(timer);
    };
  }, [runSearch, searchText, selectedDatabaseId]);

  async function handleDatabaseChange(nextDatabaseId: string) {
    setSelectedDatabaseId(nextDatabaseId);
    setResults([]);
    setResolvedQuery(undefined);
    await storeDatabaseId(nextDatabaseId);
  }

  const emptyView = databaseError ? (
    <List.EmptyView title="DB9 Project Not Selected" description={databaseError} icon={Icon.Warning} />
  ) : (
    <List.EmptyView
      title={searchText ? "No Matching Repositories" : "No Synced Repositories"}
      description={searchText ? "Try another query." : "Run Sync GitHub Stars to DB9 first for this project."}
      icon={Icon.MagnifyingGlass}
    />
  );
  const resultItems = results.map((repository) => (
    <RepositoryItem
      key={repository.repoFullName}
      repository={repository}
      db9Token={db9Token}
      databaseId={selectedDatabaseId}
      onDidRebuild={refreshSearch}
    />
  ));

  return (
    <List
      isLoading={isLoadingDatabase || isSearching}
      onSearchTextChange={setSearchText}
      searchBarPlaceholder="Search synced GitHub repositories"
      searchBarAccessory={
        <List.Dropdown
          tooltip="DB9 Project"
          value={selectedDatabaseId}
          onChange={(nextDatabaseId) => {
            void handleDatabaseChange(nextDatabaseId);
          }}
        >
          {databases.length === 0 ? (
            <List.Dropdown.Item value="" title={isLoadingDatabase ? "Loading Projects..." : "No Project Found"} />
          ) : (
            databases.map((database) => (
              <List.Dropdown.Item
                key={database.id}
                value={database.id}
                title={database.name}
                keywords={[database.id, database.state ?? ""]}
              />
            ))
          )}
        </List.Dropdown>
      }
      throttle
    >
      {results.length === 0 ? (
        emptyView
      ) : resolvedQuery ? (
        <List.Section title={`English query: ${resolvedQuery}`}>{resultItems}</List.Section>
      ) : (
        resultItems
      )}
    </List>
  );
}

function RepositoryItem(props: {
  repository: GitHubRepositorySearchResult;
  db9Token: string;
  databaseId: string;
  onDidRebuild: () => void;
}) {
  const repositoryUrl = buildRepositoryUrl(props.repository.repoFullName);

  return (
    <List.Item
      icon={Icon.Code}
      title={props.repository.repoFullName}
      subtitle={buildDescriptionSummary(props.repository)}
      keywords={[props.repository.repoFullName, props.repository.defaultBranch, ...props.repository.topic]}
      accessories={buildAccessories(props.repository)}
      actions={
        <RepositoryActions
          repository={props.repository}
          repositoryUrl={repositoryUrl}
          db9Token={props.db9Token}
          databaseId={props.databaseId}
          onDidRebuild={props.onDidRebuild}
        />
      }
    />
  );
}

function RepositoryActions(props: {
  repository: GitHubRepositorySearchResult;
  repositoryUrl: string;
  db9Token: string;
  databaseId: string;
  onDidRebuild: () => void;
}) {
  return (
    <ActionPanel>
      <Action.OpenInBrowser title="Open Repository" url={props.repositoryUrl} />
      <Action.CopyToClipboard title="Copy Repository URL" content={props.repositoryUrl} />
      <Action.CopyToClipboard title="Copy Clone Command" content={`git clone ${props.repositoryUrl}.git`} />
      <Action
        title="Show Search Score"
        icon={Icon.BarChart}
        shortcut={{ modifiers: ["cmd", "shift"], key: "c" }}
        onAction={() => copyScore(props.repository)}
      />
      <Action
        title="Rebuild Vector for Repository"
        icon={Icon.ArrowClockwise}
        shortcut={{ modifiers: ["cmd"], key: "r" }}
        onAction={() =>
          rebuildVectorForRepository({
            db9Token: props.db9Token,
            databaseId: props.databaseId,
            repoFullName: props.repository.repoFullName,
            onDidRebuild: props.onDidRebuild,
          })
        }
      />
      <Action
        title="Rebuild All Vectors"
        icon={Icon.RotateClockwise}
        shortcut={{ modifiers: ["cmd", "shift"], key: "r" }}
        onAction={() =>
          rebuildAllVectors({
            db9Token: props.db9Token,
            databaseId: props.databaseId,
            onDidRebuild: props.onDidRebuild,
          })
        }
      />
    </ActionPanel>
  );
}

function buildAccessories(repository: GitHubRepositorySearchResult): List.Item.Accessory[] {
  const accessories: List.Item.Accessory[] = [{ tag: { value: repository.defaultBranch, color: Color.SecondaryText } }];

  for (const topic of repository.topic.slice(0, 2)) {
    accessories.push({ tag: { value: topic, color: Color.Blue } });
  }

  if (repository.score !== undefined) {
    accessories.push({ text: `Score ${repository.score.toFixed(2)}` });
  }

  if (repository.syncedAt) {
    accessories.push({ date: new Date(repository.syncedAt) });
  }

  return accessories;
}

async function rebuildVectorForRepository(options: {
  db9Token: string;
  databaseId: string;
  repoFullName: string;
  onDidRebuild: () => void;
}) {
  const toast = await showToast({
    style: Toast.Style.Animated,
    title: "Rebuilding Vector",
    message: options.repoFullName,
  });

  try {
    const updated = await rebuildRepositoryVector(options);
    toast.style = Toast.Style.Success;
    toast.title = "Vector Rebuilt";
    toast.message = `${updated} repository updated`;
    options.onDidRebuild();
  } catch (error) {
    toast.style = Toast.Style.Failure;
    toast.title = "Vector Rebuild Failed";
    toast.message = error instanceof Error ? error.message : String(error);
  }
}

async function rebuildAllVectors(options: { db9Token: string; databaseId: string; onDidRebuild: () => void }) {
  const confirmed = await confirmAlert({
    title: "Rebuild All Vectors?",
    message: "This recalculates DB9 embeddings for every synced repository and can consume embedding quota.",
    primaryAction: {
      title: "Rebuild All Vectors",
      style: Alert.ActionStyle.Default,
    },
  });

  if (!confirmed) {
    return;
  }

  const toast = await showToast({
    style: Toast.Style.Animated,
    title: "Rebuilding All Vectors",
  });

  try {
    const updated = await rebuildAllRepositoryVectors(options);
    toast.style = Toast.Style.Success;
    toast.title = "Vectors Rebuilt";
    toast.message = `${updated} repositories updated`;
    options.onDidRebuild();
  } catch (error) {
    toast.style = Toast.Style.Failure;
    toast.title = "Vector Rebuild Failed";
    toast.message = error instanceof Error ? error.message : String(error);
  }
}

async function copyScore(repository: GitHubRepositorySearchResult) {
  await showToast({
    style: Toast.Style.Success,
    title: "Search Score",
    message:
      repository.score === undefined
        ? "No score for recent repository listing"
        : `Score ${repository.score.toFixed(4)}, vector ${repository.vectorDistance?.toFixed(4) ?? "n/a"}, text ${
            repository.ftsRank?.toFixed(4) ?? "n/a"
          }`,
  });
}

function buildRepositoryUrl(repoFullName: string): string {
  return `https://github.com/${repoFullName}`;
}

function buildDescriptionSummary(repository: GitHubRepositorySearchResult): string {
  const summary = repository.description || repository.topic.join(", ");
  return summary.replace(/\s+/g, " ").trim().slice(0, 180);
}
