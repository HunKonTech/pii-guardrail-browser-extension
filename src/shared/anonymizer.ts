import type { PiiSpan } from './message-types';
import { EntityMap } from './entity-map';
import { byteOffsetToStringIndex } from './text-offsets';
import { bareIdentifierPlaceholder, createIdentifierPositionCheck } from './code-identifiers';
import { aliasFor, IDENTIFIER_ALIAS_RE, planIdentifierRenames, type IdentifierRole } from './code-rename';
import type { IdentifierVerdict } from './identifier-classifier-constants';
import {
  type IdentityVaultData,
  type IdentityRecord,
  type ReplacementMode,
  upsertEntity,
  upsertIdentifierAlias,
  activeReplacement,
} from './identity-vault';

export interface AnonymizeOptions {
  /**
   * Also rename the identifiers pasted code declares (`alma` → `var1`,
   * `alma.nev` → `var1.field2`), the same way everywhere in the text.
   */
  renameIdentifiers?: boolean;
  /**
   * OWN/LIB verdicts from the identifier-classifier model for this paste's
   * undeclared names, fetched by the caller before calling `anonymize` /
   * `anonymizeWithVault`. Falls back to the hardcoded library-name list for
   * any name it doesn't cover (including when omitted entirely).
   */
  identifierClassifications?: ReadonlyMap<string, IdentifierVerdict>;
}

export interface AnonymizeResult {
  text: string;
  entityMap: EntityMap;
  /** Distinct code identifiers renamed (0 unless `renameIdentifiers`). */
  renamedIdentifiers: number;
}

/**
 * Vault-aware anonymisation result. In addition to the rendered text and
 * the conversation EntityMap (kept for backwards compatibility with the
 * de-anon banner), it returns the mutated vault data — the caller is
 * expected to persist it via `saveIdentityVault` — and the list of
 * records that were referenced. The latter is useful for telemetry /
 * "Items used in this paste" UI affordances.
 */
export interface VaultAnonymizeResult extends AnonymizeResult {
  vaultData: IdentityVaultData;
  recordsTouched: IdentityRecord[];
}

/** One substitution in UTF-16 indices of the original text. */
interface Replacement {
  start: number;
  end: number;
  text: string;
}

/** Chooses (and records) the alias for a name, or null to leave it alone. */
type AliasResolver = (name: string, role: IdentifierRole, taken: ReadonlySet<string>) => string | null;

/** Originals already renamed in this conversation's EntityMap. */
function entityMapAliasedNames(entityMap: EntityMap): string[] {
  return entityMap
    .entries()
    .filter(([key]) => IDENTIFIER_ALIAS_RE.test(key))
    .map(([, original]) => original);
}

/** Originals already renamed in the vault or this conversation's EntityMap. */
function vaultAliasedNames(vaultData: IdentityVaultData, entityMap: EntityMap): string[] {
  return [
    ...vaultData.records.filter((r) => r.entityType === 'IDENTIFIER').map((r) => r.originalText),
    ...entityMapAliasedNames(entityMap),
  ];
}

function applyReplacements(originalText: string, replacements: Replacement[]): string {
  const sorted = [...replacements].sort((a, b) => a.start - b.start);
  let result = '';
  let cursor = 0;
  for (const replacement of sorted) {
    result += originalText.slice(cursor, replacement.start) + replacement.text;
    cursor = replacement.end;
  }
  return result + originalText.slice(cursor);
}

/**
 * Replacements renaming every identifier the code declares. A name any of
 * whose occurrences overlaps a reviewed span is left to that span: the model
 * flagged something inside it (`getAnnaMuellerInvoice` → `getPERSON_1Invoice`),
 * and that replacement is already applied at every occurrence.
 */
function identifierReplacements(
  originalText: string,
  spanRanges: readonly Replacement[],
  resolveAlias: AliasResolver,
  knownNames: Iterable<string>,
  classifications?: ReadonlyMap<string, IdentifierVerdict>,
): { replacements: Replacement[]; renamed: number } {
  const plan = planIdentifierRenames(originalText, { knownNames, classifications });
  const blocked = new Set<string>();
  for (const occurrence of plan.occurrences) {
    if (spanRanges.some((span) => occurrence.start < span.end && occurrence.end > span.start)) {
      blocked.add(occurrence.name);
    }
  }

  const aliases = new Map<string, string>();
  for (const [name, role] of plan.roles) {
    if (blocked.has(name)) continue;
    const alias = resolveAlias(name, role, plan.identifiersInText);
    if (alias) aliases.set(name, alias);
  }

  const replacements = plan.occurrences
    .filter((occurrence) => aliases.has(occurrence.name))
    .map((occurrence) => ({ start: occurrence.start, end: occurrence.end, text: aliases.get(occurrence.name)! }));
  return { replacements, renamed: aliases.size };
}

/** Alias resolver backed by the conversation EntityMap (cross-session memory off). */
function entityMapAliases(entityMap: EntityMap): AliasResolver {
  let nextIndex = 1;
  for (const [key] of entityMap.entries()) {
    const match = IDENTIFIER_ALIAS_RE.exec(key);
    if (match) nextIndex = Math.max(nextIndex, parseInt(match[1], 10) + 1);
  }
  return (name, role, taken) => {
    const existing = entityMap.getPlaceholder(name);
    if (existing !== undefined) {
      // Reuse an alias from an earlier paste; never steal a PII mapping.
      return IDENTIFIER_ALIAS_RE.test(existing) && !taken.has(existing) ? existing : null;
    }
    let alias = aliasFor(name, role, nextIndex);
    while (taken.has(alias) || entityMap.getOriginal(alias) !== undefined) {
      nextIndex += 1;
      alias = aliasFor(name, role, nextIndex);
    }
    nextIndex += 1;
    entityMap.addExternal(alias, name);
    return alias;
  };
}

/** Alias resolver backed by the identity vault, so aliases survive reloads. */
function vaultAliases(
  vaultData: IdentityVaultData,
  entityMap: EntityMap,
  recordsTouched: IdentityRecord[],
): AliasResolver {
  return (name, role, taken) => {
    const existing = entityMap.getPlaceholder(name);
    if (existing !== undefined && !IDENTIFIER_ALIAS_RE.test(existing)) return null;
    const record = upsertIdentifierAlias(
      vaultData,
      name,
      (index) => aliasFor(name, role, index),
      (alias) => taken.has(alias),
    );
    if (!record) return null;
    recordsTouched.push(record);
    entityMap.addExternal(record.syntheticValue, name);
    return record.syntheticValue;
  };
}

/** One identifier rename, in UTF-16 indices of the original text. */
export interface IdentifierRename {
  start: number;
  end: number;
  alias: string;
}

/**
 * The identifier renames `anonymize` / `anonymizeWithVault` would apply next
 * to `spans`, without touching the caller's EntityMap or vault. Lets the
 * review overlay show the renamed code before anything is pasted.
 */
export function previewIdentifierRenames(
  originalText: string,
  spans: readonly PiiSpan[],
  context: { entityMap?: EntityMap; vaultData?: IdentityVaultData } = {},
): IdentifierRename[] {
  const entityMap = new EntityMap(context.entityMap?.toStored());
  const spanRanges = spans.map((span) => ({
    start: byteOffsetToStringIndex(originalText, span.start),
    end: byteOffsetToStringIndex(originalText, span.end),
    text: '',
  }));
  // The vault is plain JSON (it lives in chrome.storage), so this copy is exact.
  const vaultData: IdentityVaultData | null = context.vaultData
    ? JSON.parse(JSON.stringify(context.vaultData))
    : null;
  const { replacements } = vaultData
    ? identifierReplacements(
        originalText,
        spanRanges,
        vaultAliases(vaultData, entityMap, []),
        vaultAliasedNames(vaultData, entityMap),
      )
    : identifierReplacements(originalText, spanRanges, entityMapAliases(entityMap), entityMapAliasedNames(entityMap));
  // Preview is best-effort and stays synchronous (it re-runs on every span
  // toggle in the review overlay); it always uses the lexical LIBRARY_NAMES
  // fallback rather than awaiting the classifier. The actual paste (below)
  // uses the classifier when available.
  return replacements.map(({ start, end, text }) => ({ start, end, alias: text }));
}

/**
 * Anonymize text by replacing detected PII spans with typed placeholders.
 *
 * This is the simple, vault-less path retained for backwards compatibility
 * with tests and any caller that does not need cross-session memory.
 * Production code paths should prefer `anonymizeWithVault`.
 *
 * @param originalText - The original text
 * @param spans - Detected PII spans (must not overlap; run merger first)
 * @param existingMap - Optional existing EntityMap to extend (for multi-paste conversations)
 * @param options - `renameIdentifiers` also renames the identifiers code declares
 * @returns The anonymized text and the updated entity map
 */
export function anonymize(
  originalText: string,
  spans: PiiSpan[],
  existingMap?: EntityMap,
  options: AnonymizeOptions = {},
): AnonymizeResult {
  const entityMap = existingMap || new EntityMap();

  if (spans.length === 0 && !options.renameIdentifiers) {
    return { text: originalText, entityMap, renamedIdentifiers: 0 };
  }

  // Sort spans by start position (should already be sorted from merger)
  const sorted = [...spans].sort((a, b) => a.start - b.start);
  const inIdentifierPosition = createIdentifierPositionCheck(originalText);
  const replacements: Replacement[] = [];

  for (const span of sorted) {
    const start = byteOffsetToStringIndex(originalText, span.start);
    const end = byteOffsetToStringIndex(originalText, span.end);
    // Replace span with placeholder; in code, drop the brackets so the
    // identifier it sits in stays valid.
    const ph = entityMap.add(span);
    replacements.push({ start, end, text: inIdentifierPosition(start, end) ? bareIdentifierPlaceholder(ph) : ph });
  }

  let renamedIdentifiers = 0;
  if (options.renameIdentifiers) {
    const renames = identifierReplacements(
      originalText,
      replacements,
      entityMapAliases(entityMap),
      entityMapAliasedNames(entityMap),
      options.identifierClassifications,
    );
    replacements.push(...renames.replacements);
    renamedIdentifiers = renames.renamed;
  }

  return { text: applyReplacements(originalText, replacements), entityMap, renamedIdentifiers };
}

/**
 * Vault-aware anonymisation. Looks up each detected span in the vault
 * (creating a new record on miss) and emits the canonical replacement —
 * either the typed placeholder or a realistic synthetic value, depending
 * on the record's per-record `replacementMode` (with `defaultMode` as
 * fallback).
 *
 * Cross-session/cross-provider consistency is achieved naturally: the
 * vault is shared across all conversations and providers in
 * `chrome.storage.local`, so re-pasting the same identity always yields
 * the same replacement. Renamed code identifiers are vault records too
 * (`IDENTIFIER`, alias as the synthetic value), so `alma` is `var1` in
 * every paste.
 *
 * The returned `entityMap` mirrors the chosen replacements so the
 * de-anonymisation banner can still operate without re-loading the
 * vault, and so the WASM-side merger view remains unaware of the vault.
 *
 * @param originalText — text to anonymise.
 * @param spans — detected PII spans, non-overlapping, sorted or unsorted.
 * @param vaultData — current vault state. Mutated in place; caller saves.
 * @param defaultMode — replacement mode to use for records that don't
 *   have an explicit `replacementMode` (effectively "global default").
 * @param existingMap — conversation-scoped EntityMap to extend.
 * @param options — `renameIdentifiers` also renames the identifiers code declares.
 */
export function anonymizeWithVault(
  originalText: string,
  spans: PiiSpan[],
  vaultData: IdentityVaultData,
  defaultMode: ReplacementMode,
  existingMap?: EntityMap,
  options: AnonymizeOptions = {},
): VaultAnonymizeResult {
  const entityMap = existingMap || new EntityMap();
  const recordsTouched: IdentityRecord[] = [];

  if (spans.length === 0 && !options.renameIdentifiers) {
    return { text: originalText, entityMap, vaultData, recordsTouched, renamedIdentifiers: 0 };
  }

  const sorted = [...spans].sort((a, b) => a.start - b.start);
  const inIdentifierPosition = createIdentifierPositionCheck(originalText);
  const replacements: Replacement[] = [];

  for (const span of sorted) {
    const start = byteOffsetToStringIndex(originalText, span.start);
    const end = byteOffsetToStringIndex(originalText, span.end);

    const { record } = upsertEntity(vaultData, span, Date.now(), defaultMode);
    recordsTouched.push(record);

    if (inIdentifierPosition(start, end)) {
      // A synthetic value ("Jordan Park") or a bracketed placeholder would
      // break the identifier, so code always gets the bare placeholder.
      entityMap.addExternal(record.placeholder, record.originalText);
      replacements.push({ start, end, text: bareIdentifierPlaceholder(record.placeholder) });
    } else {
      const replacement = activeReplacement(record, defaultMode);
      entityMap.addExternal(replacement, record.originalText);
      replacements.push({ start, end, text: replacement });
    }
  }

  let renamedIdentifiers = 0;
  if (options.renameIdentifiers) {
    const renames = identifierReplacements(
      originalText,
      replacements,
      vaultAliases(vaultData, entityMap, recordsTouched),
      vaultAliasedNames(vaultData, entityMap),
      options.identifierClassifications,
    );
    replacements.push(...renames.replacements);
    renamedIdentifiers = renames.renamed;
  }

  return {
    text: applyReplacements(originalText, replacements),
    entityMap,
    vaultData,
    recordsTouched,
    renamedIdentifiers,
  };
}
