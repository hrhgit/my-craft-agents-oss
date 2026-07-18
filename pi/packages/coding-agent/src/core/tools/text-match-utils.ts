const UNICODE_SPACES = /[\u00A0\u2002-\u200A\u202F\u205F\u3000]/g;
const TRAILING_DELIMITER_SUFFIX = /[\s,;`)\]}]+$/u;

export interface ApproximateNormalizationOptions {
	stripTrailingDelimiters?: boolean;
}

/**
 * Normalize text for exact/fuzzy matching. Applies progressive transformations:
 * - Unicode normalization (NFKC)
 * - Strip trailing whitespace from each line
 * - Normalize smart quotes to ASCII equivalents
 * - Normalize Unicode dashes/hyphens to ASCII hyphen
 * - Normalize special Unicode spaces to regular space
 */
export function normalizeForFuzzyMatch(text: string): string {
	return text
		.normalize("NFKC")
		.split("\n")
		.map((line) => line.trimEnd())
		.join("\n")
		.replace(/[\u2018\u2019\u201A\u201B]/g, "'")
		.replace(/[\u201C\u201D\u201E\u201F]/g, '"')
		.replace(/[\u2010\u2011\u2012\u2013\u2014\u2015\u2212]/g, "-")
		.replace(UNICODE_SPACES, " ");
}

/**
 * Strip low-risk trailing delimiters from a single line for tolerant approximate matching.
 * This intentionally does not strip ordinary quotes or periods.
 */
export function stripTrailingDelimiters(line: string): string {
	const trimmedEnd = line.trimEnd();
	const stripped = trimmedEnd.replace(TRAILING_DELIMITER_SUFFIX, "");
	return stripped.length > 0 ? stripped : trimmedEnd;
}

function normalizeApproximateLine(line: string, options?: ApproximateNormalizationOptions): string {
	const normalized = normalizeForFuzzyMatch(line).trim();
	if (!options?.stripTrailingDelimiters || normalized.length === 0) {
		return normalized;
	}
	return stripTrailingDelimiters(normalized);
}

/**
 * Normalize text for conservative approximate block matching.
 * In addition to fuzzy normalization, this strips leading indentation on each line
 * so code blocks with the same structure but different indentation can still match.
 * When requested, it also removes low-risk trailing delimiters from each line before
 * approximate comparison.
 */
export function normalizeForApproximateMatch(text: string, options?: ApproximateNormalizationOptions): string {
	return text
		.split("\n")
		.map((line) => normalizeApproximateLine(line, options))
		.join("\n")
		.replace(/\n{3,}/g, "\n\n")
		.trim();
}

export function splitApproximateLines(text: string, options?: ApproximateNormalizationOptions): string[] {
	const normalized = normalizeForApproximateMatch(text, options);
	return normalized.length > 0 ? normalized.split("\n") : [];
}

export function getNonEmptyApproximateLines(text: string, options?: ApproximateNormalizationOptions): string[] {
	return splitApproximateLines(text, options).filter((line) => line.length > 0);
}

/**
 * Compare two lines with tolerance for low-risk trailing delimiter differences.
 * Returns a score between 0 and 1.
 */
export function lineSimilarityWithDelimiterTolerance(a: string, b: string): number {
	if (a === b) return 1;
	const strippedA = stripTrailingDelimiters(a);
	const strippedB = stripTrailingDelimiters(b);
	if (strippedA.length >= 3 && strippedA === strippedB) return 1;
	return diceCoefficient(strippedA, strippedB);
}

export function diceCoefficient(a: string, b: string): number {
	if (a === b) return 1;
	if (a.length === 0 || b.length === 0) return 0;
	if (a.length === 1 || b.length === 1) {
		return a === b ? 1 : 0;
	}

	const pairsA = buildBigramCounts(a);
	const pairsB = buildBigramCounts(b);
	let overlap = 0;
	let totalA = 0;
	let totalB = 0;

	for (const count of pairsA.values()) {
		totalA += count;
	}
	for (const count of pairsB.values()) {
		totalB += count;
	}
	for (const [pair, countA] of pairsA.entries()) {
		const countB = pairsB.get(pair);
		if (countB !== undefined) {
			overlap += Math.min(countA, countB);
		}
	}

	return (2 * overlap) / (totalA + totalB);
}

export function lineDiceCoefficient(linesA: string[], linesB: string[]): number {
	if (linesA.length === 0 && linesB.length === 0) return 1;
	if (linesA.length === 0 || linesB.length === 0) return 0;

	let overlap = 0;
	const usedB = new Set<number>();
	const unmatchedA: string[] = [];

	for (const lineA of linesA) {
		let matched = false;
		for (let i = 0; i < linesB.length; i++) {
			if (usedB.has(i)) continue;
			if (lineA === linesB[i]) {
				overlap++;
				usedB.add(i);
				matched = true;
				break;
			}
		}
		if (!matched) {
			unmatchedA.push(lineA);
		}
	}

	for (const lineA of unmatchedA) {
		const strippedA = stripTrailingDelimiters(lineA);
		if (strippedA.length < 3) continue;
		for (let i = 0; i < linesB.length; i++) {
			if (usedB.has(i)) continue;
			const strippedB = stripTrailingDelimiters(linesB[i]);
			if (strippedB.length >= 3 && strippedA === strippedB) {
				overlap++;
				usedB.add(i);
				break;
			}
		}
	}

	return (2 * overlap) / (linesA.length + linesB.length);
}

function buildBigramCounts(text: string): Map<string, number> {
	const counts = new Map<string, number>();
	for (let i = 0; i < text.length - 1; i++) {
		const pair = text.slice(i, i + 2);
		counts.set(pair, (counts.get(pair) ?? 0) + 1);
	}
	return counts;
}
