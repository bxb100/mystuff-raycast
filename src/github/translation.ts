import { AI, environment } from "@raycast/api";

export type NormalizedQuery = {
  query: string;
  translated: boolean;
};

export async function normalizeSearchQuery(input: string): Promise<NormalizedQuery> {
  const query = input.trim();

  if (!query || !environment.canAccess(AI)) {
    return { query, translated: false };
  }

  try {
    const translatedQuery = sanitizeAiResponse(
      await AI.ask(
        [
          "Convert the user input into a concise English search query for finding GitHub repositories.",
          "If the input is already English, return it unchanged.",
          "Preserve programming language names, library names, framework names, and product names.",
          "Return plain text only.",
          "",
          `Input: ${query}`,
        ].join("\n"),
        { creativity: "none" },
      ),
    );

    return {
      query: translatedQuery || query,
      translated: translatedQuery.length > 0 && translatedQuery.toLowerCase() !== query.toLowerCase(),
    };
  } catch {
    return { query, translated: false };
  }
}

function sanitizeAiResponse(response: string) {
  return response
    .trim()
    .replace(/^```(?:text)?/i, "")
    .replace(/```$/i, "")
    .replace(/^["'`]+|["'`]+$/g, "")
    .trim();
}
