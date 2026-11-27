import crypto from 'node:crypto';

const PLACEHOLDER_REGEX = /\{\{\s*([^{}]+?)\s*\}\}/g;
const VARIANT_SEPARATOR_REGEX = /^\s*---\s*$/m;

export const TEMPLATE_VARIANT_SEPARATOR = '\n---\n';

export interface RenderResult {
  renderedText: string;
  missingKeys: string[];
}

export interface DuplicateAnalysis {
  total: number;
  uniqueCount: number;
  allIdentical: boolean;
}

export function splitTemplateVariants(template: string): string[] {
  const parts = template
    .split(VARIANT_SEPARATOR_REGEX)
    .map((part) => part.trim())
    .filter((part) => part.length > 0);
  return parts;
}

export function pickRandomTemplateVariant(
  variants: string[],
  lastIndex: number | null = null,
  randomIntFn: (min: number, maxExclusive: number) => number = (min, max) =>
    crypto.randomInt(min, max)
): { variant: string; index: number } {
  if (variants.length === 0) {
    return { variant: '', index: -1 };
  }
  if (variants.length === 1) {
    return { variant: variants[0], index: 0 };
  }
  if (lastIndex !== null && lastIndex >= 0 && lastIndex < variants.length) {
    const raw = randomIntFn(0, variants.length - 1);
    const index = raw >= lastIndex ? raw + 1 : raw;
    return { variant: variants[index], index };
  }
  const index = randomIntFn(0, variants.length);
  return { variant: variants[index], index };
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
