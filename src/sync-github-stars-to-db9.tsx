import { Action, ActionPanel, Clipboard, Form, getPreferenceValues, Icon, showToast, Toast } from "@raycast/api";
import { showFailureToast, useCachedPromise } from "@raycast/utils";
import { useEffect, useState } from "react";
import {
  type Db9Database,
  type Db9Preferences,
  execSql,
  getStoredDatabaseId,
  isUsableDatabase,
  listDatabases,
  storeDatabaseId,
} from "./github/db";
import { enrichRepositoryContent } from "./github/content";
import { fetchAllStarredRepositories, fetchRepositoryByFullName, type GitHubStarredRepository } from "./github/github";
import {
  buildRebuildMissingRepositoryVectorSql,
  buildUpsertRepositorySql,
  getGitHubRepositoriesSyncStatus,
  getSyncedRepositoryFullNames,
  type GitHubRepositoriesSyncStatus,
} from "./github/sql";

type StarSyncFormValues = {
  databaseId: string;
};

type SingleRepositoryFormValues = {
  databaseId: string;
  repoFullName: string;
  defaultBranch: string;
};

export default function Command() {
  const preferences = getPreferenceValues<Db9Preferences>();
  const db9Token = preferences["db9-client-token"];
  const githubToken = preferences["github-token"];
  const [databases, setDatabases] = useState<Db9Database[]>([]);
  const [selectedDatabaseId, setSelectedDatabaseId] = useState<string>("");
  const [syncStatus, setSyncStatus] = useState<GitHubRepositoriesSyncStatus>();
  const [syncStatusError, setSyncStatusError] = useState<string>();
  const [isLoadingStatus, setIsLoadingStatus] = useState(false);
  const [isLoadingDatabases, setIsLoadingDatabases] = useState(true);
  const [isSyncing, setIsSyncing] = useState(false);
  const [starredRepositoriesLoadedAt, setStarredRepositoriesLoadedAt] = useState<string>();
  const {
    data: starredRepositories,
    error: starredRepositoriesError,
    isLoading: isLoadingStarredRepositories,
    revalidate: reloadStarredRepositories,
  } = useCachedPromise(fetchAllStarredRepositories, [githubToken], {
    initialData: [] as GitHubStarredRepository[],
    failureToastOptions: {
      title: "Failed to load GitHub stars",
    },
    onData() {
      setStarredRepositoriesLoadedAt(new Date().toISOString());
    },
  });

  useEffect(() => {
    let cancelled = false;

    async function loadDatabases() {
      setIsLoadingDatabases(true);

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
        setSelectedDatabaseId(storedDatabaseId ?? usableDatabases[0]?.id ?? "");
      } catch (error) {
        if (!cancelled) {
          void showFailureToast(error, { title: "Failed to load DB9 databases" });
        }
      } finally {
        if (!cancelled) {
          setIsLoadingDatabases(false);
        }
      }
    }

    void loadDatabases();

    return () => {
      cancelled = true;
    };
  }, [db9Token]);

  useEffect(() => {
    let cancelled = false;

    async function loadSyncStatus() {
      if (!selectedDatabaseId) {
        setSyncStatus(undefined);
        setSyncStatusError(undefined);
        return;
      }

      setIsLoadingStatus(true);
      setSyncStatusError(undefined);

      try {
        const nextSyncStatus = await getGitHubRepositoriesSyncStatus({
          db9Token,
          databaseId: selectedDatabaseId,
        });

        if (!cancelled) {
          setSyncStatus(nextSyncStatus);
        }
      } catch (error) {
        if (!cancelled) {
          setSyncStatus(undefined);
          setSyncStatusError(error instanceof Error ? error.message : String(error));
        }
      } finally {
        if (!cancelled) {
          setIsLoadingStatus(false);
        }
      }
    }

    void loadSyncStatus();

    return () => {
      cancelled = true;
    };
  }, [db9Token, selectedDatabaseId]);

  async function refreshSyncStatus(databaseId: string) {
    setSyncStatus(
      await getGitHubRepositoriesSyncStatus({
        db9Token,
        databaseId,
      }),
    );
  }

  async function handleSubmit(values: StarSyncFormValues) {
    const databaseId = values.databaseId || selectedDatabaseId;

    if (!databaseId) {
      await showToast({
        style: Toast.Style.Failure,
        title: "No DB9 Database Available",
        message: "Create a DB9 database or use a token scoped to one database.",
      });
      return;
    }

    if (isLoadingStarredRepositories && starredRepositories.length === 0) {
      await showToast({
        style: Toast.Style.Failure,
        title: "GitHub Stars Are Still Loading",
        message: "Wait for the cached GitHub star list to finish loading.",
      });
      return;
    }

    if (starredRepositoriesError && starredRepositories.length === 0) {
      await showFailureToast(starredRepositoriesError, { title: "GitHub stars are unavailable" });
      return;
    }

    setIsSyncing(true);
    await storeDatabaseId(databaseId);

    const toast = await showToast({
      style: Toast.Style.Animated,
      title: "Preparing Repository Content",
      message: `${starredRepositories.length} GitHub stars loaded from cache`,
    });

    try {
      toast.title = "Checking Synced Repositories";
      toast.message = `${starredRepositories.length} GitHub stars loaded from cache`;

      const syncedRepositoryFullNames = await getSyncedRepositoryFullNames({
        db9Token,
        databaseId,
        repoFullNames: starredRepositories.map((repository) => repository.fullName),
      });
      const repositoriesToSync = starredRepositories.filter(
        (repository) => !syncedRepositoryFullNames.has(repository.fullName),
      );
      const skipped = starredRepositories.length - repositoriesToSync.length;
      let readmeHits = 0;
      let metadataFallbacks = 0;
      let count = 0;

      if (repositoriesToSync.length === 0) {
        toast.style = Toast.Style.Success;
        toast.title = "GitHub Repositories Already Synced";
        toast.message = `${skipped} repositories skipped`;

        await refreshSyncStatus(databaseId);
        return;
      }

      for (const [index, repository] of repositoriesToSync.entries()) {
        toast.title = "Fetching Repository Content";
        toast.message = `${index + 1}/${repositoriesToSync.length} · ${repository.fullName} · ${skipped} skipped`;

        const enrichment = await enrichRepositoryContent({
          repository,
          githubToken,
        });

        try {
          toast.title = "Writing DB9 Vectors";
          await execSql(db9Token, databaseId, buildUpsertRepositorySql(enrichment.repository));
          await execSql(
            db9Token,
            databaseId,
            buildRebuildMissingRepositoryVectorSql(enrichment.repository.repoFullName),
          );
        } catch (e) {
          console.log(`Failed to sync ${repository.fullName}`);
          const options: Toast.Options = {
            style: Toast.Style.Failure,
            title: `Failed to sync ${repository.fullName}`,
            message: e instanceof Error ? e.message : String(e),
            primaryAction: {
              title: "Copy",
              onAction: async () => {
                await Clipboard.copy(buildUpsertRepositorySql(enrichment.repository));
              },
            },
          };
          await showToast(options).then(() => new Promise((resolve) => setTimeout(resolve, 1500)));
          continue;
        }

        count++;
        if (enrichment.source === "readme") {
          readmeHits += 1;
        } else {
          metadataFallbacks += 1;
        }
      }

      toast.style = Toast.Style.Success;
      toast.title = "GitHub Repositories Synced";
      toast.message = `${count} written, ${skipped} skipped, README ${readmeHits}, metadata ${metadataFallbacks}`;

      await refreshSyncStatus(databaseId);
    } catch (error) {
      await showFailureToast(error, { title: "GitHub Repository Sync Failed" });
    } finally {
      setIsSyncing(false);
    }
  }

  return (
    <Form
      isLoading={
        isLoadingDatabases ||
        isLoadingStatus ||
        isSyncing ||
        (isLoadingStarredRepositories && starredRepositories.length === 0)
      }
      actions={
        <ActionPanel>
          <Action.SubmitForm title="Sync Stars" onSubmit={handleSubmit} />
          <Action.Push
            title="Sync Repository"
            icon={Icon.Plus}
            shortcut={{ modifiers: ["cmd"], key: "n" }}
            target={
              <SingleRepositorySyncForm
                db9Token={db9Token}
                githubToken={githubToken}
                databases={databases}
                selectedDatabaseId={selectedDatabaseId}
                onSynced={refreshSyncStatus}
              />
            }
          />
          <Action
            title="Reload GitHub Stars"
            icon={Icon.ArrowClockwise}
            shortcut={{ modifiers: ["cmd"], key: "r" }}
            onAction={reloadStarredRepositories}
          />
        </ActionPanel>
      }
    >
      <Form.Dropdown id="databaseId" title="DB9 Project" value={selectedDatabaseId} onChange={setSelectedDatabaseId}>
        {databases.length === 0 ? (
          <Form.Dropdown.Item value="" title={isLoadingDatabases ? "Loading Projects..." : "No Project Found"} />
        ) : (
          databases.map((database) => (
            <Form.Dropdown.Item
              key={database.id}
              value={database.id}
              title={database.name}
              keywords={[database.id, database.state ?? ""]}
            />
          ))
        )}
      </Form.Dropdown>
      <Form.Description
        title="GitHub Stars"
        text={formatStarredRepositoriesStatus({
          count: starredRepositories.length,
          errorMessage: starredRepositoriesError?.message,
          isLoading: isLoadingStarredRepositories,
          loadedAt: starredRepositoriesLoadedAt,
        })}
      />
      <Form.Description title="Sync Status" text={formatSyncStatus(syncStatus, syncStatusError, isLoadingStatus)} />
    </Form>
  );
}

function SingleRepositorySyncForm(props: {
  db9Token: string;
  githubToken: string;
  databases: Db9Database[];
  selectedDatabaseId: string;
  onSynced: (databaseId: string) => Promise<void>;
}) {
  const [selectedDatabaseId, setSelectedDatabaseId] = useState(props.selectedDatabaseId);
  const [isSyncing, setIsSyncing] = useState(false);

  async function handleSubmit(values: SingleRepositoryFormValues) {
    const databaseId = values.databaseId || selectedDatabaseId;
    const repoFullName = values.repoFullName.trim();
    const defaultBranch = values.defaultBranch.trim();

    if (!databaseId) {
      await showToast({
        style: Toast.Style.Failure,
        title: "No DB9 Database Available",
        message: "Create a DB9 database or use a token scoped to one database.",
      });
      return;
    }

    if (!repoFullName || !defaultBranch) {
      await showToast({
        style: Toast.Style.Failure,
        title: "Repository and Branch Are Required",
        message: "Use the owner/repo format and provide the branch used to fetch README content.",
      });
      return;
    }

    setIsSyncing(true);
    await storeDatabaseId(databaseId);

    const toast = await showToast({
      style: Toast.Style.Animated,
      title: "Fetching Repository",
      message: repoFullName,
    });

    try {
      const repository = await fetchRepositoryByFullName(repoFullName, props.githubToken);

      toast.title = "Fetching Repository Content";
      toast.message = `${repository.fullName} · ${defaultBranch}`;

      const enrichment = await enrichRepositoryContent({
        repository,
        githubToken: props.githubToken,
        defaultBranch,
      });

      await execSql(props.db9Token, databaseId, buildUpsertRepositorySql(enrichment.repository));
      await execSql(
        props.db9Token,
        databaseId,
        buildRebuildMissingRepositoryVectorSql(enrichment.repository.repoFullName),
      );

      toast.style = Toast.Style.Success;
      toast.title = "Repository Synced";
      toast.message = `${repository.fullName} · ${enrichment.source === "readme" ? "README" : "metadata"} content`;

      await props.onSynced(databaseId);
    } catch (error) {
      toast.style = Toast.Style.Failure;
      toast.title = "Repository Sync Failed";
      toast.message = error instanceof Error ? error.message : String(error);
    } finally {
      setIsSyncing(false);
    }
  }

  return (
    <Form
      isLoading={isSyncing}
      actions={
        <ActionPanel>
          <Action.SubmitForm title="Sync Repository" onSubmit={handleSubmit} />
        </ActionPanel>
      }
    >
      <Form.Dropdown id="databaseId" title="DB9 Project" value={selectedDatabaseId} onChange={setSelectedDatabaseId}>
        {props.databases.length === 0 ? (
          <Form.Dropdown.Item value="" title="No Project Found" />
        ) : (
          props.databases.map((database) => (
            <Form.Dropdown.Item
              key={database.id}
              value={database.id}
              title={database.name}
              keywords={[database.id, database.state ?? ""]}
            />
          ))
        )}
      </Form.Dropdown>
      <Form.TextField id="repoFullName" title="Repository Full Name" placeholder="owner/repo" />
      <Form.TextField id="defaultBranch" title="Default Branch" defaultValue="main" placeholder="main" />
    </Form>
  );
}

function formatStarredRepositoriesStatus(options: {
  count: number;
  errorMessage?: string;
  isLoading: boolean;
  loadedAt?: string;
}) {
  if (options.isLoading && options.count === 0) {
    return "Loading GitHub stars...";
  }

  const loadedAt = options.loadedAt ? new Date(options.loadedAt).toLocaleString() : "From cache";
  const lines = [`Repositories: ${options.count}`, `Loaded: ${loadedAt}`];

  if (options.isLoading) {
    lines.push("Status: Refreshing GitHub cache...");
  }

  if (options.errorMessage) {
    lines.push(`Refresh failed: ${options.errorMessage}`);
  }

  return lines.join("\n");
}

function formatSyncStatus(
  syncStatus: GitHubRepositoriesSyncStatus | undefined,
  errorMessage: string | undefined,
  isLoading: boolean,
) {
  if (isLoading) {
    return "Loading sync status...";
  }

  if (errorMessage) {
    return `Failed to load sync status: ${errorMessage}`;
  }

  if (!syncStatus) {
    return "Choose a DB9 project to inspect sync status.";
  }

  const latestSyncedAt = syncStatus.latestSyncedAt ? new Date(syncStatus.latestSyncedAt).toLocaleString() : "Never";

  return [
    `Repositories: ${syncStatus.total}`,
    `Searchable: ${syncStatus.searchable}`,
    `Missing vectors: ${syncStatus.missingVectors}`,
    `Last synced: ${latestSyncedAt}`,
  ].join("\n");
}
