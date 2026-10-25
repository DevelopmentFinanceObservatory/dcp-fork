/**
 * refineQuery — free-text phrase refinement.
 *
 * A phrase popover normally commits a pick from its own option list, but the
 * user can also type something the list doesn't offer at all (e.g. typing
 * "droughts" over a "Floods" phrase). spliceSentence below turns that into a
 * brand-new raw-text query: it walks the already-rendered sentence, swaps ONE
 * phrase's text for what the user typed, and hands back the resulting
 * plain-language string for a fresh resolve().
 *
 * WHY raw text and not a dataset-door edit: a dataset_resubmit binding must
 * be a grounded ref (dcid/enum value from the taxonomy), and typed text is
 * neither — it
 * hasn't been matched against anything yet, and swapping it in can change the
 * shape family entirely (a replacement variable may not even belong to the
 * same shape as the one it replaced). The rendered sentence is already a
 * faithful natural-language reading of the spec, so splicing the one phrase
 * and re-running the FULL raw_text pipeline is what lets the engine re-ground
 * everything — including a shape change — while every other typed part of
 * the sentence (place, window, ...) carries over unchanged.
 *
 * EXCEPTION — switching the what phrase (the variable/measure itself, real
 * slot or shape-label fallback alike) also drops every how/source phrase
 * (and its connective): those qualifiers are owned by the OLD shape (a
 * purpose, a channel, a named source) and over-constrain a cross-domain
 * re-ground onto a new measure — e.g. keeping "for Malaria control" once the
 * measure becomes "total population" either conjoins two unrelated measures
 * or resolves to nothing. Place and time are what the user actually means to
 * keep across a variable swap, so where/when (and any other what phrase)
 * still carry over unchanged.
 */

import type { Direction } from '@/lib/contract/types';
import type { SentencePart, ViewModel } from './types';

/**
 * Addresses a rendered phrase that carries neither a real Spec.slots index nor
 * a directional entity role — a shape-label fallback token (buildViewModel's
 * "no confirmable sibling to construct a real edit from" case, e.g. "Floods",
 * "Total population"). Targeted by its position in the SAME rendered parts
 * array toParts() below produces (tokens when present, else the
 * sentence-fallback with inserted connective spaces) — the same array
 * SentenceRenderer's own `parts.map((part, i) => ...)` walks, so an index
 * SentenceRenderer hands back via onEditPhrase always lands on the same phrase
 * here.
 */
export interface PhraseTarget {
  kind: 'phrase';
  index: number;
}

/**
 * Identifies the phrase to replace: a slot's index in Spec.slots, a
 * directional entity role ('from'/'to') for a read-back phrase with no
 * Spec.slots entry (the donor), or a PhraseTarget for a phrase with neither —
 * the three addressing schemes SentenceRenderer's onEdit/onEditEntity/
 * onEditPhrase use to open a phrase's editor.
 */
export type RefineTarget = number | Direction | PhraseTarget;

/**
 * The same tokens-else-sentence unification SentenceRenderer renders from
 * (see its local `parts`) — reproduced here rather than imported, since it's
 * a private render-time computation, not a shared export. Engine sentence_plan
 * tokens carry NO paired connective spacing: a text token carries a TRAILING
 * space only ("in ", "to "), and adjacent slot tokens carry none at all — so
 * naive concatenation runs words together. The plain `sentence` fallback
 * carries no spacing either, so single spaces are inserted between phrases,
 * the same way the renderer does; either way, spliceSentence's join(' ') +
 * whitespace collapse below is what actually keeps every boundary readable.
 */
function toParts(viewModel?: Pick<ViewModel, 'sentence' | 'sentenceTokens'> | null): SentencePart[] {
  if (!viewModel) return [];
  if (viewModel.sentenceTokens && viewModel.sentenceTokens.length) return viewModel.sentenceTokens;
  return (viewModel.sentence ?? []).flatMap((p, i) =>
    i === 0
      ? [{ kind: 'slot', ...p } as SentencePart]
      : [{ kind: 'text', text: ' ' } as SentencePart, { kind: 'slot', ...p } as SentencePart],
  );
}

function matchesTarget(part: SentencePart, index: number, target: RefineTarget): boolean {
  if (target && typeof target === 'object') return part?.kind === 'slot' && index === target.index;
  if (!part || part.kind !== 'slot') return false;
  return typeof target === 'number' ? part.slotIndex === target : part.slotIndex < 0 && part.role === target;
}

/**
 * Replace the phrase identified by `target` with `newText` (trimmed) and
 * return the whole sentence as one plain string, whitespace-normalized
 * (joined with single spaces, runs collapsed, ends trimmed — see toParts'
 * spacing note above) so neither a missing nor a doubled-up connective can
 * ever run words together or leave a double space behind. Returns the
 * unmodified rendered sentence when no phrase matches `target`.
 */
export function spliceSentence(
  viewModel: Pick<ViewModel, 'sentence' | 'sentenceTokens'>,
  target: RefineTarget,
  newText: string,
): string {
  const trimmed = (newText ?? '').trim();
  const parts = toParts(viewModel);
  const matchIndex = parts.findIndex((part, index) => matchesTarget(part, index, target));
  const matched = matchIndex >= 0 ? parts[matchIndex] : null;

  // Switching the what phrase re-grounds the measure entirely, so its
  // shape-owned how/source qualifiers (and their connectives) are dropped
  // along with it — see the file-header WHY comment. where/when and any
  // other what phrase are the parameters the user means to keep, so they
  // carry over untouched.
  const isWhatSwitch = matched?.kind === 'slot' && matched.axis === 'what';
  const toDrop = new Set<number>();
  if (isWhatSwitch) {
    parts.forEach((part, index) => {
      if (index === matchIndex || part.kind !== 'slot') return;
      if (part.axis !== 'how' && part.axis !== 'source') return;
      toDrop.add(index);
      if (index > 0 && parts[index - 1].kind === 'text') toDrop.add(index - 1);
    });
  }

  return parts
    .map((part, index) => (index === matchIndex ? { ...part, text: trimmed } : part))
    .filter((_, index) => !toDrop.has(index))
    .map((p) => p.text)
    .join(' ')
    .replace(/\s+/g, ' ')
    .trim();
}
