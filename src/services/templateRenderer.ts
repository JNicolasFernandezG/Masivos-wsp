const PLACEHOLDER_REGEX = /\{\{\s*([^{}]+?)\s*\}\}/g;

export interface RenderResult {
  renderedText: string;
  missingKeys: string[];
}

export interface DuplicateAnalysis {
  total: number;
  uniqueCount: number;
  allIdentical: boolean;
}

export function extractTemplateVariables(template: string): string[] {
  const seen = new Set<string>();
  const matches = template.matchAll(PLACEHOLDER_REGEX);
  for (const match of matches) {
    const key = match[1].trim();
    if (key) {
      seen.add(key);
    }
  }
  return Array.from(seen);
}

export function renderTemplate(
  template: string,
  variables: Record<string, string>
): RenderResult {
  const normalizedLookup = new Map<string, string>();
  for (const [k, v] of Object.entries(variables)) {
    normalizedLookup.set(k.trim().toLowerCase(), v ?? '');
  }

  const missingSet = new Set<string>();
  const renderedText = template.replace(PLACEHOLDER_REGEX, (_full, rawKey: string) => {
    const trimmedKey = rawKey.trim();
    const lookupKey = trimmedKey.toLowerCase();
    if (normalizedLookup.has(lookupKey)) {
      return normalizedLookup.get(lookupKey) ?? '';
    }
    missingSet.add(trimmedKey);
    return '';
  });

  return {
    renderedText: renderedText.trim(),
    missingKeys: Array.from(missingSet),
  };
}

export function analyzeMessageVariety(texts: string[]): DuplicateAnalysis {
  if (texts.length === 0) {
    return { total: 0, uniqueCount: 0, allIdentical: false };
  }
  const unique = new Set(texts.map((t) => t.trim()));
  return {
    total: texts.length,
    uniqueCount: unique.size,
    allIdentical: texts.length > 1 && unique.size === 1,
  };
}
