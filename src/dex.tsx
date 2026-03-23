import { useState } from "react";
import { Action, ActionPanel, getPreferenceValues, Grid, List, showInFinder, showToast, Toast } from "@raycast/api";
import { access, mkdir, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, extname, join } from "node:path";
import { useFetch } from "@raycast/utils";

const DOWNLOADS_DIRECTORY = join(homedir(), "Downloads");

type ViewMode = "grid" | "list";
type SortOrder = "asc" | "desc";

type Character = {
  id: number;
  name: string;
  url: string;
  discoverer: string;
  discovered_date: string;
  tags: string[];
  created_at: string;
};

type CharactersApiResponse = {
  success: boolean;
  characters: Character[];
};

type CommandPreferences = {
  defaultView: ViewMode;
};

type BrowserProps = {
  characters: Character[];
  isLoading?: boolean;
  errorMessage?: string;
  discovererFilter?: string;
  initialSortOrder?: SortOrder;
  viewMode: ViewMode;
};

export default function Command() {
  const [errorMessage, setErrorMessage] = useState<string>();
  const preferences = getPreferenceValues<CommandPreferences>();

  const { isLoading, data } = useFetch<CharactersApiResponse, Character[], Character[]>(
    `https://api.makdulac.com/api/characters`,
    {
      mapResult(result: CharactersApiResponse) {
        return {
          data: result.characters,
        };
      },
      keepPreviousData: true,
      initialData: [],
      onError(error) {
        setErrorMessage(error.message);
      },
    },
  );

  return (
    <CharacterBrowser
      characters={data}
      isLoading={isLoading}
      errorMessage={errorMessage}
      viewMode={preferences.defaultView ?? "grid"}
    />
  );
}

function CharacterBrowser({
  characters,
  isLoading = false,
  errorMessage,
  discovererFilter,
  initialSortOrder = "asc",
  viewMode,
}: BrowserProps) {
  const [sortOrder, setSortOrder] = useState<SortOrder>(initialSortOrder);

  const scopedCharacters = discovererFilter
    ? characters.filter((character) => character.discoverer === discovererFilter)
    : characters;
  const sortedCharacters = [...scopedCharacters].sort((left, right) => compareCharacters(left, right, sortOrder));
  const emptyTitle = errorMessage
    ? "Couldn't load icons"
    : discovererFilter
      ? `No icons by ${discovererFilter}`
      : "No icons found";
  const emptyDescription = errorMessage
    ? errorMessage
    : discovererFilter
      ? "Try a different search term."
      : "Try again in a moment.";
  const navigationTitle = discovererFilter ? `${discovererFilter}'s Icons` : "DuckDuckGo Character Icons";
  const searchBarPlaceholder = discovererFilter
    ? `Search icons discovered by ${discovererFilter}`
    : "Search character icons";

  if (viewMode === "list") {
    return (
      <List
        isLoading={isLoading}
        navigationTitle={navigationTitle}
        searchBarPlaceholder={searchBarPlaceholder}
        searchBarAccessory={
          <List.Dropdown
            tooltip="Sort Order"
            value={sortOrder}
            onChange={(newValue) => updateSortOrder(newValue, setSortOrder)}
          >
            <List.Dropdown.Item title="A-Z" value="asc" />
            <List.Dropdown.Item title="Z-A" value="desc" />
          </List.Dropdown>
        }
      >
        {sortedCharacters.length === 0 ? (
          <List.EmptyView title={emptyTitle} description={emptyDescription} />
        ) : (
          sortedCharacters.map((character) => (
            <List.Item
              key={character.id}
              icon={{ source: character.url }}
              title={character.name}
              subtitle={`🧍 Discovered by ${character.discoverer}`}
              accessories={[{ text: character.discovered_date }]}
              keywords={[character.discoverer, character.discovered_date, ...character.tags]}
              actions={
                <CharacterActions
                  character={character}
                  characters={characters}
                  currentDiscovererFilter={discovererFilter}
                  sortOrder={sortOrder}
                  viewMode={viewMode}
                  onSortOrderChange={setSortOrder}
                />
              }
            />
          ))
        )}
      </List>
    );
  }

  return (
    <Grid
      columns={8}
      inset={Grid.Inset.Small}
      isLoading={isLoading}
      navigationTitle={navigationTitle}
      searchBarPlaceholder={searchBarPlaceholder}
      searchBarAccessory={
        <Grid.Dropdown
          tooltip="Sort Order"
          value={sortOrder}
          onChange={(newValue) => updateSortOrder(newValue, setSortOrder)}
        >
          <Grid.Dropdown.Item title="A-Z" value="asc" />
          <Grid.Dropdown.Item title="Z-A" value="desc" />
        </Grid.Dropdown>
      }
    >
      {sortedCharacters.length === 0 ? (
        <Grid.EmptyView title={emptyTitle} description={emptyDescription} />
      ) : (
        sortedCharacters.map((character) => (
          <Grid.Item
            key={character.id}
            content={{ value: { source: character.url }, tooltip: character.name }}
            title={character.name}
            subtitle={`${character.discoverer} · ${character.discovered_date}`}
            keywords={[character.discoverer, character.discovered_date, ...character.tags]}
            actions={
              <CharacterActions
                character={character}
                characters={characters}
                currentDiscovererFilter={discovererFilter}
                sortOrder={sortOrder}
                viewMode={viewMode}
                onSortOrderChange={setSortOrder}
              />
            }
          />
        ))
      )}
    </Grid>
  );
}

type CharacterActionsProps = {
  character: Character;
  characters: Character[];
  currentDiscovererFilter?: string;
  sortOrder: SortOrder;
  viewMode: ViewMode;
  onSortOrderChange: (value: SortOrder) => void;
};

function CharacterActions({
  character,
  characters,
  currentDiscovererFilter,
  sortOrder,
  viewMode,
  onSortOrderChange,
}: CharacterActionsProps) {
  const nextSortOrder = sortOrder === "asc" ? "desc" : "asc";
  const isFilteredByCurrentDiscoverer = currentDiscovererFilter === character.discoverer;

  return (
    <ActionPanel>
      <ActionPanel.Section>
        {!isFilteredByCurrentDiscoverer ? (
          <Action.Push
            title="Show Discoverer Icons"
            target={
              <CharacterBrowser
                characters={characters}
                discovererFilter={character.discoverer}
                initialSortOrder={sortOrder}
                viewMode={viewMode}
              />
            }
          />
        ) : null}
        <Action
          title="Download Image"
          shortcut={{ modifiers: ["cmd"], key: "d" }}
          onAction={() => {
            void downloadCharacterImage(character);
          }}
        />
      </ActionPanel.Section>
      <ActionPanel.Section>
        <Action
          title={nextSortOrder === "asc" ? "Sort Alphabetically" : "Reverse Alphabetical Sort"}
          shortcut={{ modifiers: ["cmd", "shift"], key: "s" }}
          onAction={() => onSortOrderChange(nextSortOrder)}
        />
      </ActionPanel.Section>
    </ActionPanel>
  );
}

async function downloadCharacterImage(character: Character) {
  const toast = await showToast({
    style: Toast.Style.Animated,
    title: `Downloading ${character.name}`,
  });

  try {
    const response = await fetch(character.url);

    if (!response.ok) {
      throw new Error(`Image request failed with status ${response.status}`);
    }

    await mkdir(DOWNLOADS_DIRECTORY, { recursive: true });

    const targetFilePath = await nextAvailablePath(DOWNLOADS_DIRECTORY, buildFileName(character.name, character.url));

    const imageBuffer = Buffer.from(await response.arrayBuffer());
    await writeFile(targetFilePath, imageBuffer);

    toast.style = Toast.Style.Success;
    toast.title = `Downloaded ${character.name}`;
    toast.message = targetFilePath;

    await showInFinder(targetFilePath);
  } catch (error) {
    toast.style = Toast.Style.Failure;
    toast.title = `Couldn't download ${character.name}`;
    toast.message = error instanceof Error ? error.message : "Download failed.";
  }
}

function updateSortOrder(newValue: string, setSortOrder: (value: SortOrder) => void) {
  if (newValue === "asc" || newValue === "desc") {
    setSortOrder(newValue);
  }
}

function compareCharacters(left: Character, right: Character, sortOrder: SortOrder) {
  if (sortOrder === "asc") {
    return left.name.localeCompare(right.name, undefined, { numeric: true, sensitivity: "base" });
  }

  return right.name.localeCompare(left.name, undefined, { numeric: true, sensitivity: "base" });
}

function buildFileName(name: string, url: string) {
  try {
    const pathname = new URL(url).pathname;
    const extension = extname(pathname) || ".png";
    const fileBaseName = basename(pathname, extension) || sanitizeFileName(name);

    return `${sanitizeFileName(fileBaseName)}${extension}`;
  } catch {
    return `${sanitizeFileName(name)}.png`;
  }
}

function sanitizeFileName(value: string) {
  const sanitized = Array.from(value, (character) => {
    const code = character.charCodeAt(0);

    if (code < 32 || /[<>:"/\\|?*]/.test(character)) {
      return "_";
    }

    return character;
  })
    .join("")
    .trim();

  return sanitized.length > 0 ? sanitized : "character-icon";
}

async function nextAvailablePath(directory: string, fileName: string) {
  const extension = extname(fileName);
  const baseName = basename(fileName, extension);
  let candidatePath = join(directory, fileName);
  let suffix = 1;

  while (true) {
    try {
      await access(candidatePath);
      candidatePath = join(directory, `${baseName}-${suffix}${extension}`);
      suffix += 1;
    } catch {
      return candidatePath;
    }
  }
}
