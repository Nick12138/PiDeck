import {
  createHostError,
  type HostError,
  type PackageCatalog,
  type PackageCatalogItem,
} from "@pideck/protocol";

/**
 * pi.dev has no public JSON API yet ("API routes are reserved for future
 * features"), but the catalog page embeds machine-readable data- attributes
 * that its own client-side filter consumes. This module parses that
 * semi-stable contract tolerantly: a malformed card is skipped, and a page
 * without any cards is treated as CATALOG_UNAVAILABLE rather than an empty
 * market.
 */
const CATALOG_URL = "https://pi.dev/packages";
const CATALOG_TTL_MS = 10 * 60_000;
const FETCH_TIMEOUT_MS = 15_000;
const MAX_CATALOG_ITEMS = 2000;

type CatalogFetcher = (
  url: string,
  init: { signal: AbortSignal; headers: Record<string, string> },
) => Promise<{ ok: boolean; status: number; text: () => Promise<string> }>;

let cache: { atMs: number; catalog: PackageCatalog } | null = null;

/** Test hook. */
export function resetPackageCatalogCache(): void {
  cache = null;
}

function decodeHtmlEntities(text: string): string {
  return text
    .replace(/&#x([0-9a-f]+);/gi, (_, hex: string) => String.fromCodePoint(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, dec: string) => String.fromCodePoint(Number(dec)))
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&");
}

function stripTags(html: string): string {
  return html.replace(/<[^>]*>/g, "");
}

function tagAttribute(tag: string, name: string): string | undefined {
  const match = tag.match(new RegExp(`${name}="([^"]*)"`));
  return match?.[1] !== undefined ? decodeHtmlEntities(match[1]) : undefined;
}

function finiteNonNegative(value: string | undefined): number | undefined {
  if (value === undefined) return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : undefined;
}

export function parsePackageCatalogHtml(html: string): PackageCatalogItem[] {
  const items: PackageCatalogItem[] = [];
  const cardTags = [...html.matchAll(/<article[^>]*data-package-card="true"[^>]*>/g)];
  for (let index = 0; index < cardTags.length && items.length < MAX_CATALOG_ITEMS; index += 1) {
    const card = cardTags[index]!;
    const tag = card[0];
    const bodyStart = (card.index ?? 0) + tag.length;
    const bodyEnd =
      index + 1 < cardTags.length ? (cardTags[index + 1]!.index ?? html.length) : html.length;
    const body = html.slice(bodyStart, bodyEnd);

    const name = tagAttribute(tag, "data-package-name");
    if (!name) continue;

    const descriptionMatch = body.match(/<p class="packages-desc">([\s\S]*?)<\/p>/);
    const authorMatch = body.match(/<div class="packages-meta"><span>([\s\S]*?)<\/span>/);
    const npmMatch = body.match(/href="(https:\/\/www\.npmjs\.com\/package\/[^"]+)"/);
    const githubMatch = body.match(/href="(https:\/\/github\.com\/[^"]+)"/);
    const pageMatch = body.match(/class="packages-name"><a href="([^"]+)"/);

    const author = authorMatch ? decodeHtmlEntities(stripTags(authorMatch[1] ?? "")).trim() : "";
    const downloadsPerMonth = finiteNonNegative(tagAttribute(tag, "data-package-downloads"));
    const publishedAt = finiteNonNegative(tagAttribute(tag, "data-package-date"));
    let pageUrl = `${CATALOG_URL}/${name}`;
    if (pageMatch?.[1]) {
      try {
        pageUrl = new URL(decodeHtmlEntities(pageMatch[1]), "https://pi.dev").toString();
      } catch {
        /* keep constructed fallback */
      }
    }

    items.push({
      name,
      description: descriptionMatch
        ? decodeHtmlEntities(stripTags(descriptionMatch[1] ?? "")).trim()
        : "",
      ...(author ? { author } : {}),
      types: (tagAttribute(tag, "data-package-types") ?? "").split(/\s+/).filter(Boolean),
      ...(downloadsPerMonth !== undefined ? { downloadsPerMonth } : {}),
      ...(publishedAt !== undefined && publishedAt > 0 ? { publishedAt } : {}),
      ...(npmMatch ? { npmUrl: decodeHtmlEntities(npmMatch[1] ?? "") } : {}),
      ...(githubMatch ? { githubUrl: decodeHtmlEntities(githubMatch[1] ?? "") } : {}),
      searchText: tagAttribute(tag, "data-package-search") ?? "",
      installSource: `npm:${name}`,
      pageUrl,
    });
  }
  return items;
}

export async function getPackageCatalog(
  args: { refresh?: boolean; fetchImpl?: CatalogFetcher; now?: () => number } = {},
): Promise<{ catalog: PackageCatalog } | { error: HostError }> {
  const now = args.now ?? Date.now;
  const fetchImpl: CatalogFetcher = args.fetchImpl ?? fetch;

  if (args.refresh !== true && cache && now() - cache.atMs <= CATALOG_TTL_MS) {
    return { catalog: { ...cache.catalog, fromCache: true } };
  }

  try {
    const response = await fetchImpl(CATALOG_URL, {
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      headers: { accept: "text/html" },
    });
    if (!response.ok) {
      throw new Error(`Package catalog request failed with status ${response.status}`);
    }
    const items = parsePackageCatalogHtml(await response.text());
    if (items.length === 0) {
      throw new Error("Package catalog page contained no packages");
    }
    const catalog: PackageCatalog = { generatedAt: now(), fromCache: false, items };
    cache = { atMs: now(), catalog };
    return { catalog };
  } catch (error) {
    // A stale catalog beats an empty market page when the site is unreachable.
    if (cache) return { catalog: { ...cache.catalog, fromCache: true } };
    return {
      error: createHostError(
        "CATALOG_UNAVAILABLE",
        error instanceof Error ? error.message : "Package catalog unavailable",
        { retryable: true },
      ),
    };
  }
}
