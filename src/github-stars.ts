const REPOSITORY_API_URL = 'https://api.github.com/repos/nickpeanutai/rpengine';
const CACHE_KEY = 'rpengine.github-stars.v1';
const CACHE_TTL_MS = 60 * 60 * 1_000;

interface CachedStars {
  count: number;
  expiresAt: number;
}

export async function initializeGitHubStars(): Promise<void> {
  const container = document.querySelector<HTMLElement>('#githubStars');
  const countLabel = document.querySelector<HTMLElement>('#githubStarCount');
  if (!container || !countLabel) return;

  const cached = readCache();
  if (cached) renderStars(container, countLabel, cached.count);
  if (cached && cached.expiresAt > Date.now()) return;

  try {
    const response = await fetch(REPOSITORY_API_URL, {
      headers: { Accept: 'application/vnd.github+json' },
    });
    if (!response.ok) return;
    const count = parseStarCount((await response.json()) as unknown);
    if (count === undefined) return;
    renderStars(container, countLabel, count);
    writeCache({ count, expiresAt: Date.now() + CACHE_TTL_MS });
  } catch {
    // The repository link remains available when GitHub or storage is blocked.
  }
}

export function parseStarCount(value: unknown): number | undefined {
  if (!value || typeof value !== 'object' || !('stargazers_count' in value)) return undefined;
  const count = (value as { stargazers_count?: unknown }).stargazers_count;
  return typeof count === 'number' && Number.isSafeInteger(count) && count >= 0 ? count : undefined;
}

export function formatStarCount(count: number): string {
  if (count < 1_000) return String(count);
  return new Intl.NumberFormat('en', { notation: 'compact', maximumFractionDigits: 1 }).format(count);
}

function renderStars(container: HTMLElement, countLabel: HTMLElement, count: number): void {
  const formatted = formatStarCount(count);
  const starLabel = `${count.toLocaleString('en')} GitHub ${count === 1 ? 'star' : 'stars'}`;
  countLabel.textContent = formatted;
  container.setAttribute('aria-label', starLabel);
  container.closest('a')?.setAttribute('aria-label', `View RPEngine source code on GitHub, ${starLabel}`);
  container.hidden = false;
}

function readCache(): CachedStars | undefined {
  try {
    const value = JSON.parse(localStorage.getItem(CACHE_KEY) ?? 'null') as Partial<CachedStars> | null;
    if (!value || !Number.isSafeInteger(value.count) || Number(value.count) < 0 || !Number.isFinite(value.expiresAt)) return undefined;
    return { count: Number(value.count), expiresAt: Number(value.expiresAt) };
  } catch {
    return undefined;
  }
}

function writeCache(value: CachedStars): void {
  try {
    localStorage.setItem(CACHE_KEY, JSON.stringify(value));
  } catch {
    // Storage can be unavailable in private or restricted browsing contexts.
  }
}
