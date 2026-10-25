/**
 * specStore manages the current envelope (`parts[]`), one PartView per part,
 * history, and run-level status. Each part's own Spec/ViewModel is the source
 * of truth for that block; every surface is a projection of `parts[i]`.
 *
 * One action per transport call:
 *   - resolve(rawText)               new free-text query (raw_text path) — every part
 *   - runSpecId(specId)              hydrate one spec_id directly (share links) — one part
 *   - editSlot(partIndex, ...)       rebind a slot in parts[partIndex] (dataset_resubmit)
 *   - editDonor(partIndex, ...)      change the directional donor in parts[partIndex]
 *   - chooseSpec(partIndex, spec)    promote a candidate in parts[partIndex]
 *   - editShared(edit)               rebind a hoisted where/when/source/origin axis on every definite part, in one post
 *   - refineText(partIndex, text)    free-text phrase refine on parts[partIndex] (raw_text)
 *
 * The store is transport-agnostic: createSpecStore(transport) injects the adapter,
 * so tests use a stub transport and the app uses the singleton (the live engine).
 *
 * Request lifecycle: a raw-text/spec_id run is whole-store scoped — beginRunOp()
 * aborts the previous run AND any edit in flight (a fresh query supersedes
 * everything). Every edit that posts through the dataset door (editSlot,
 * editDonor, chooseSpec, editShared) shares ONE controller: a
 * dataset_resubmit always resubmits the whole envelope together, so nothing
 * needs fencing per part index. Starting a new dataset edit aborts whatever
 * dataset post is still in flight. While a post is in flight, the NEXT edit
 * builds its entries from the entries that post already carries (not from
 * the last-committed `parts`, which would silently drop the still-in-flight
 * edit — "concurrent edits carry the first forward"; see `buildEntries` and
 * `pendingEntries`). refineText is a raw_text re-resolve of one part's
 * phrase, not a dataset-door edit — a refine re-grounds the whole part
 * rather than editing it in place — so it keeps its own per-part fencing
 * (`editOps`): a refine on part i still aborts only i's own prior refine,
 * never a sibling's, and a dataset edit and a refine can be genuinely in
 * flight on different parts at once.
 *
 * A dataset edit never takes the whole run to the "loading"/"error" states:
 * the touched blocks' previous content stays on screen throughout
 * (editPending names the single part mid-edit, for the "Updating…"
 * affordance — null for a multi-part editShared fan-out, which has no
 * single target to name), and a transport/stream failure or a refusal sets
 * editError on the part(s) targeted (keyed to the refusal's pointer when it
 * names one) instead of a page-level error. An edit that RESOLVES (a 200
 * comes back) always commits, even when the touched part's own outcome is
 * candidates/no_data, since the rendering already shows those outcomes in
 * place — see commitDataset. cancel()/undo()/redo() remain whole-store actions: one
 * global undo stack of whole-envelope snapshots, not per-part stacks. Their
 * first call while any op is in flight cancels everything in place instead
 * of stepping the pointer, so a mid-flight undo can't skip past what's on
 * screen.
 *
 * Every dataset-door edit requires every part to have already settled
 * (`parts[i].part` non-null): buildDatasetEntries needs one entry per part,
 * and there is no half-settled entry to build from a part still loading.
 * This store never actually puts a `part: null` row into `parts` today (see
 * PartView.phase's doc), so the guard is defensive/type-narrowing rather
 * than a currently-reachable UI state; a future streamed-per-part loading
 * surface would make it load-bearing.
 *
 * resolve() keeps a small session-scoped cache keyed by trimmed rawText, so
 * retyping an identical query commits synchronously instead of re-running the
 * pipeline; dataset edits and refineText never read or write it.
 */

import { create } from "zustand";
import {
  normalizeResponse,
  normalizeSpec,
  type BaseIdentity,
  type DatasetIdentityEntry,
  type DatasetResubmitEntry,
  type FacetOptions,
  type Part,
  type PipelineStepName,
  type ResolveResponse,
  type SlotOption,
  type Spec,
  type SpecObservations,
  type Warning,
} from "@/lib/contract/types";
import type { Binding } from "@/lib/contract/types";
import {
  partSentence,
  patchPartSpec,
  spliceResponseParts,
} from "@/lib/contract/parts";
import {
  buildDatasetEntries,
  type BuildDatasetEntriesOverride,
} from "../datasetEntries";
import {
  keyRef,
  type SearchEvent,
  type SentenceToken as StreamSentenceToken,
} from "@/lib/client/searchClient";
import { httpTransport, type SearchTransport } from "../transport";
import {
  promoteFromSpec,
  whereEntityRole,
  withEntityEdit,
  withFacetEdit,
  withResolvedSlotEdit,
} from "@/lib/contract/promote";
import { buildViewModel } from "../viewModel";
import type { ViewModel } from "../viewModel";

/** Live detail captured from streaming events for one part, surfaced in that
 *  part's own loading skeleton. */
export interface StreamProgress {
  /** variable phrases the engine extracted for the WHOLE query (request-scoped,
   *  same value broadcast to every part — e.g. ["population", "GDP"]) */
  variables: string[];
  /** entity phrases, request-scoped, e.g. ["Brazil"] */
  entities: string[];
  /** formatted date expressions, request-scoped, e.g. ["2015–2020"] */
  dates: string[];
  /** this part's own chosen data-shape family label, once known */
  shapeLabel: string | null;
  /** this part's own real per-step latency (ms), as each of its stages completes */
  stepMs: Partial<Record<PipelineStepName, number>>;
}

/**
 * One variable's in-flight sentence, upgraded in place as the stream advances:
 * the `shape` event supplies a skeleton plan (empty-text placeholder tokens for
 * unbound slots), the `sentence` event replaces it with the bound plan. The
 * loading view renders these so the user watches the sentence resolve instead
 * of staring at a shimmer until everything lands at once.
 */
export interface LiveSentenceView {
  /** the stream-mirror token type: live plans come from SSE events, not the Spec */
  plan: StreamSentenceToken[];
  /** binding_ref ("axis:property_dcid") → slot label, to name placeholder tokens */
  labels: Record<string, string>;
  /** false while the plan is the pre-bind skeleton; true once bound */
  bound: boolean;
}

/** Telemetry captured at completion (from the SSE done event or buffered diagnostics). */
export interface StreamTelemetry {
  llm_usage?: Record<string, number> | null;
  elapsedMs?: number;
  timedOut?: boolean;
}

/** Run lifecycle only ("mixed"/"candidates"/"no_data"/etc. all live on each
 *  part's own `part.status`; see PartView). "error" is reserved for a
 *  transport/stream failure (no response at all, or a malformed one with no
 *  parts); an individual part's outcome (candidates, no_data, unsupported, or
 *  a rejected edit) never sets this. */
export type SpecStatus = "idle" | "loading" | "ready" | "error";

/**
 * One entry in `SpecState.parts`, in wire order. Holds the wire `part` plus
 * its hydrated spec/viewModel (definite only) and this part's own editError —
 * the block-local counterpart of a run-level `error`.
 */
export interface PartView {
  /** "done" once `part` is populated. "loading" only ever appears for a
   *  placeholder row seeded from the `interpretation` event, before the
   *  run's single `response` event lands (every part in one envelope commits
   *  atomically together — the engine has no per-part "response" event —
   *  so every row flips loading -> done in the same commit). "error" is
   *  reserved for a future non-atomic engine; no code path here produces it
   *  today (a whole-run transport/stream failure is SpecState.status, not a
   *  per-part phase, and a rejected edit is `editError`, not this). */
  phase: "loading" | "done" | "error";
  /** the asked variable text, in query order. Carried forward across an edit
   *  (the engine returns variable_text: null on every dataset_resubmit
   *  identity/candidates/placeholder entry, since those carry no phrase to
   *  restate) so a block's heading never blanks out mid-edit. Null for a
   *  placeholder row whose interpretation event carried no name for it. */
  variableText: string | null;
  /** the wire part, once known; null for a loading placeholder. */
  part: Part | null;
  /** part.spec when `part.status === "definite"`, else null — a convenience
   *  alias so callers don't have to narrow `part` themselves. */
  spec: Spec | null;
  /** buildViewModel(spec, sentence_plan) when definite, else null. */
  viewModel: ViewModel | null;
  /** Set when an edit targeting this part failed outright (a transport/
   *  stream error, or a refusal) — the block keeps its previous `part`/
   *  `spec`/`viewModel` and shows this message instead of losing the
   *  result. Cleared the moment a new edit starts on this part, or by that
   *  edit's own success. An edit that RESOLVES to candidates/no_data does
   *  not set this: that outcome commits and renders in place, same as any
   *  other part status. Never a page-level banner; see SpecState.error for
   *  the run-level (transport/stream) failure instead. */
  editError: string | null;
}

/** A restorable point in the history stack: the whole envelope, exactly as
 *  it was rendered. One global stack of whole-envelope snapshots, not
 *  per-part undo stacks: an edit to any one part still pushes a full new
 *  snapshot of every part, so undo/redo always lands on a self-consistent
 *  multi-part result. */
type Snapshot = Pick<
  SpecState,
  "status" | "response" | "parts" | "error" | "queryText"
>;

export interface SpecState {
  /** run lifecycle: idle -> loading -> ready, or -> error on a transport/
   *  stream failure. Never reflects any one part's own outcome — see
   *  PartView.phase/part.status for that, and PartView.editError for a
   *  rejected part edit. */
  status: SpecStatus;
  /** the last full envelope, whatever the outcome; null before the first result. */
  response: ResolveResponse | null;
  /** one entry per part in the current response, in wire order. Rendered
   *  position always equals array index — nothing filters this list. Stays
   *  whatever it was (the previous result) while a new run is `loading`;
   *  replaced wholesale by a raw-text/spec_id run's `response` event, by a
   *  dataset edit's own `response` event (commitDataset, below — every
   *  dataset_resubmit answers with the FULL envelope, so this is a straight
   *  replace, not a splice), or spliced at one index by a refineText's
   *  `response` event (spliceResponseParts, lib/contract/parts.ts). */
  parts: PartView[];
  /** named skeleton rows for the run currently loading, seeded from the
   *  `interpretation` event's `variables`/`expected_results` (query order,
   *  pre-sized and indexed before any shape/sentence/step event names a
   *  part, since a later index's `shape` event can arrive before an earlier
   *  index's). Empty outside an in-flight raw-text/spec_id run; a dataset
   *  edit never touches this, since a dataset_resubmit stream carries no
   *  `interpretation` event at all. */
  expectedParts: { index: number; variableText: string | null }[];
  /** human-readable failure reason when status === 'error' (transport/stream
   *  only — never a per-part outcome; see PartView.editError for that). */
  error: string | null;
  /** the raw text of the query that produced this committed result; null when
   *  the result came from an edit rather than typed free text. A dataset edit
   *  carries the pre-edit value forward (also echoed to the engine as the
   *  dataset_resubmit's own `raw_query`), since the typed query that started
   *  the session still describes every part. cancel() restores this alongside
   *  the rest of the snapshot, which is what lets the search bar snap back to
   *  the text that produced the result it's reverting to. */
  queryText: string | null;
  /** telemetry from the completed stream (from SSE 'done' event or response
   *  diagnostics) — request-scoped, not per-part. */
  telemetry: StreamTelemetry | null;
  /** warnings returned on the response or the SSE 'done' event — request-
   *  scoped (diagnostics.warnings); a part's OWN warnings (binding_folded,
   *  observations_omitted) live on `parts[i].part.warnings` instead. */
  warnings: Warning[];

  /** committed states (results + part edits), and the pointer into them */
  history: Snapshot[];
  index: number;
  canUndo: boolean;
  canRedo: boolean;
  /** the part + slot index changed by the last edit (drives the change
   *  highlight on that part's block); null after a fresh query, undo/redo
   *  past it, a step where zero or more than one part's spec differs (a
   *  donor edit, a pick, an editShared fan-out touching more than one part,
   *  or a step landing on/leaving a non-definite part), or reset. Computed
   *  generically from the before/after PartView arrays (changedPartSlot,
   *  below) for both undo/redo and every dataset-edit commit, so this is
   *  always "the one slot a single definite part's spec differs on", never
   *  hand-tracked per edit action. */
  lastEditedSlot: { partIndex: number; slotIndex: number } | null;
  /** pipeline steps completed during a streaming run, keyed by the part
   *  (variable_index) they belong to. Reset for every index at the start of
   *  a raw-text/spec_id run; untouched by a dataset edit (a dataset_resubmit
   *  stream emits no `step` events to record — see `expectedParts` doc). */
  loadingSteps: Record<number, PipelineStepName[]>;
  /** the once-per-request steps that carry `variable_index: null` (currently
   *  just `extract`), shared across every part, so kept separately rather
   *  than broadcast into each part's own `loadingSteps`. */
  sharedSteps: PipelineStepName[];
  sharedStepMs: Partial<Record<PipelineStepName, number>>;
  /** live detail from streaming events (extracted terms, shape, timings) per
   *  part; empty outside a streaming raw-text/spec_id run. */
  progress: Record<number, StreamProgress>;
  /** per-part in-flight sentences (skeleton → bound), keyed by variable_index;
   *  empty outside a streaming raw-text/spec_id run. */
  liveSentences: Record<number, LiveSentenceView>;
  /** the part index currently mid-edit, or null. Drives the "Updating…"
   *  affordance on that one block; editing focus/popover state itself stays
   *  local to each mounted block (not lifted into the store). Null while a
   *  multi-part editShared fan-out is in flight (no single target to name)
   *  or while a refineText is running on a part a dataset edit isn't also
   *  touching. */
  editPending: number | null;

  resolve: (rawText: string) => Promise<void>;
  runSpecId: (specId: string, queryHint?: string) => Promise<void>;
  /** rebind one slot (by its index in parts[partIndex].spec.slots) and
   *  re-resolve via the dataset door, replacing the whole envelope */
  editSlot: (
    partIndex: number,
    slotIndex: number,
    binding: Binding,
  ) => Promise<void>;
  /** change parts[partIndex]'s directional donor (dev-finance) and re-resolve;
   *  slots unchanged */
  editDonor: (partIndex: number, donorDcid: string) => Promise<void>;
  /**
   * Edit a qualifier the heading shows hoisted across every definite part
   * (a where/when/source token with no part_index on the envelope's own
   * sentence_plan): rewrite that axis on every definite part's own identity
   * in ONE dataset_resubmit post, rather than making the caller loop
   * editSlot per part. where/when/source/origin all live outside
   * `identity.slots` (in `entities`/`requested_window`/`facets`), so this
   * needs no per-part slot-index lookup the way editSlot does. `origin` is
   * the one axis with an eligibility check: a definite part whose identity
   * carries no donor entity role has nothing to rebind there and is left
   * untouched by the rewrite (mirrors the eligibility editDonor's own caller
   * checks by having a donor chip to click in the first place). A
   * non-definite part (candidates/no_data/unsupported) is never rewritten —
   * buildDatasetEntries's `editShared` override only touches identity-kind
   * entries.
   */
  editShared: (
    edit:
      | { axis: "where" | "source"; binding: Binding }
      | { axis: "when"; startYear: number; endYear: number }
      | { axis: "origin"; dcid: string },
  ) => Promise<void>;
  /** free-text phrase refine on parts[partIndex]: re-resolve `text` (the
   *  block's own sentence with the typed phrase spliced in) via the raw_text
   *  path and splice the result back into partIndex. A raw-text resolve can
   *  return more than one part, and spliceResponseParts grows the envelope
   *  in place when it does — refine stays a fresh whole re-ground, not a
   *  dataset-door edit. Fenced independently per part index (its own
   *  `editOps` map, distinct from the dataset door's single controller): a
   *  no_data/candidates outcome for a single returned part sets this part's
   *  editError rather than replacing it — a raw-text re-ground has no "the
   *  outcome renders in place" precedent the way a dataset-door edit's
   *  identity/candidates/placeholder entries do. */
  refineText: (partIndex: number, text: string) => Promise<void>;
  /** step back / forward through the (whole-envelope) history stack */
  undo: () => void;
  redo: () => void;
  /** abort every in-flight op (the run, any dataset edit, and any refine)
   *  and restore the last committed result (or idle) */
  cancel: () => void;
  /** replay the last resolve()/runSpecId(). The recovery path from the
   *  run-level error state — a rejected edit recovers by editing again,
   *  not by retry() (see PartView.editError). */
  retry: () => Promise<void>;
  chooseSpec: (partIndex: number, spec: Spec) => Promise<void>;
  reset: () => void;
}

const initial = {
  status: "idle" as SpecStatus,
  response: null as ResolveResponse | null,
  parts: [] as PartView[],
  expectedParts: [] as { index: number; variableText: string | null }[],
  error: null as string | null,
  queryText: null as string | null,
  telemetry: null as StreamTelemetry | null,
  warnings: [] as Warning[],
  history: [] as Snapshot[],
  index: -1,
  canUndo: false,
  canRedo: false,
  lastEditedSlot: null as { partIndex: number; slotIndex: number } | null,
  loadingSteps: {} as Record<number, PipelineStepName[]>,
  sharedSteps: [] as PipelineStepName[],
  sharedStepMs: {} as Partial<Record<PipelineStepName, number>>,
  progress: {} as Record<number, StreamProgress>,
  liveSentences: {} as Record<number, LiveSentenceView>,
  editPending: null as number | null,
};

/** Loading-surface fields, reset together at the start of every raw-text/
 *  spec_id run. Not used by an edit: an edit only ever touches its own
 *  target part(s), never the loading detail of a sibling. */
const noLoadingDetail = {
  expectedParts: [] as { index: number; variableText: string | null }[],
  loadingSteps: {} as Record<number, PipelineStepName[]>,
  sharedSteps: [] as PipelineStepName[],
  sharedStepMs: {} as Partial<Record<PipelineStepName, number>>,
  progress: {} as Record<number, StreamProgress>,
  liveSentences: {} as Record<number, LiveSentenceView>,
};

const EMPTY_PROGRESS: StreamProgress = {
  variables: [],
  entities: [],
  dates: [],
  shapeLabel: null,
  stepMs: {},
};

/**
 * The single slot that differs between two specs, or null if they differ in
 * zero or more than one slot (or aren't comparable). Used to flash the
 * phrase that changed when stepping through history, or after a dataset
 * edit commits.
 */
function specSlotDiff(from: Spec | null, to: Spec | null): number | null {
  if (!from || !to) return null;
  if (
    from.shape?.shape_id !== to.shape?.shape_id ||
    (from.slots?.length ?? 0) !== (to.slots?.length ?? 0)
  )
    return null;
  let changed: number | null = null;
  const toSlots = to.slots ?? [];
  const fromSlots = from.slots ?? [];
  for (let i = 0; i < toSlots.length; i += 1) {
    if (
      JSON.stringify(fromSlots[i]?.binding) !==
      JSON.stringify(toSlots[i]?.binding)
    ) {
      if (changed !== null) return null; // more than one slot differs
      changed = i;
    }
  }
  return changed;
}

/** The single {partIndex, slotIndex} that changed between two whole-envelope
 *  PartView arrays (a step through history, or a dataset edit's commit), or
 *  null if zero, more than one part changed, or the part counts differ (a
 *  different query entirely). */
function changedPartSlot(
  from: PartView[],
  to: PartView[],
): { partIndex: number; slotIndex: number } | null {
  if (from.length !== to.length) return null;
  let result: { partIndex: number; slotIndex: number } | null = null;
  for (let i = 0; i < to.length; i += 1) {
    const slotIndex = specSlotDiff(from[i]?.spec ?? null, to[i]?.spec ?? null);
    if (slotIndex !== null) {
      if (result !== null) return null; // more than one part changed
      result = { partIndex: i, slotIndex };
    }
  }
  return result;
}

/** Hydrate one wire Part into its PartView: spec/viewModel for a definite
 *  part, both null otherwise. `editError` always starts null — callers that
 *  need to preserve a live one do so explicitly (see applyPatchedResponse). */
function buildPartView(part: Part): PartView {
  if (part.status === "definite") {
    const { sentence_plan } = partSentence(part);
    return {
      phase: "done",
      variableText: part.variable_text ?? null,
      part,
      spec: part.spec,
      viewModel: buildViewModel(part.spec, sentence_plan),
      editError: null,
    };
  }
  return {
    phase: "done",
    variableText: part.variable_text ?? null,
    part,
    spec: null,
    viewModel: null,
    editError: null,
  };
}

/** Reduce a whole ResolveResponse into a snapshot: one PartView per part, in
 *  order. An empty `parts[]` (a malformed response; the wire contract
 *  guarantees at least one) is the one case that still maps to the run-level
 *  `error` status, same class of failure as a transport error. Every real
 *  per-part outcome (definite, candidates, no_data, unsupported) maps to
 *  "ready", including an `unsupported` part: it does not drive the whole
 *  store to `error`. */
function fromResponse(
  rawResponse: ResolveResponse,
  queryText: string | null,
): Snapshot {
  const response = normalizeResponse(rawResponse);
  if (response.parts.length === 0) {
    return {
      status: "error",
      response,
      parts: [],
      error: "The response carried no parts.",
      queryText,
    };
  }
  return {
    status: "ready",
    response,
    parts: response.parts.map(buildPartView),
    error: null,
    queryText,
  };
}

/** Format an engine ExtractedDate ({kind, start?, end?}) for display. */
function formatExtractedDate(d: {
  kind?: string;
  start?: string | null;
  end?: string | null;
}): string {
  if (!d) return "";
  if (d.kind === "latest") return "latest";
  if (d.start && d.end)
    return d.start === d.end ? d.start : `${d.start}–${d.end}`;
  return d.start ?? d.end ?? "";
}

function isAbort(e: unknown): boolean {
  return (
    (e instanceof DOMException || e instanceof Error) && e.name === "AbortError"
  );
}

function errorMessage(e: unknown): string {
  return e instanceof Error ? e.message : "request failed";
}

/** The RFC 9457 `pointer` an error/refusal carries, when the transport
 *  attached one (see lib/client/searchClient.ts's parseErrorPayload and the
 *  SearchEvent 'error' arm) — null for a plain Error or an event with none. */
function errorPointer(e: unknown): string | null {
  return (e as { pointer?: string | null } | null | undefined)?.pointer ?? null;
}

/**
 * Overlay a trailing slot_options/entity_options/facet_options event onto the
 * Spec it belongs to. On the SSE path with include_option_coverage, the
 * response event's own options ship coverage=null and the real counts stream
 * in afterwards. Without this merge the edit popovers silently lose their "N
 * obs" consequence counts (a parity break with the buffered path). Returns
 * the same object when the event doesn't target this spec, so callers can
 * no-op on identity.
 */
function mergeTrailingOptions(
  spec: Spec,
  ev: Extract<
    SearchEvent,
    { kind: "slot_options" | "entity_options" | "facet_options" }
  >,
): Spec {
  if (spec.spec_id !== ev.spec_id) return spec;
  if (ev.kind === "slot_options") {
    const ref = keyRef(ev.key);
    const existing = spec.slot_options ?? [];
    const at = existing.findIndex((so) => keyRef(so.key) === ref);
    const entry = {
      // The event's key mirrors the contract SlotKey; the baseline entry (when
      // present) is authoritative for `source`, which the event doesn't carry.
      key:
        at >= 0 ? existing[at].key : (ev.key as Spec["slots"][number]["key"]),
      options: ev.options as SlotOption[],
      complete: ev.complete,
      source: existing[at]?.source ?? ("observed" as const),
    };
    return {
      ...spec,
      slot_options:
        at >= 0
          ? existing.map((so, i) => (i === at ? entry : so))
          : [...existing, entry],
    };
  }
  if (ev.kind === "facet_options") {
    const existing = spec.facet_options ?? [];
    const at = existing.findIndex((fo) => fo.axis === ev.axis);
    const entry: FacetOptions = {
      axis: ev.axis,
      options: ev.options as SlotOption[],
      truncated: ev.truncated,
      source: existing[at]?.source ?? ("observed" as const),
    };
    return {
      ...spec,
      facet_options:
        at >= 0
          ? existing.map((fo, i) => (i === at ? entry : fo))
          : [...existing, entry],
    };
  }
  const existing = spec.entity_options ?? [];
  const at = existing.findIndex((eo) => eo.entity_ref === ev.entity_ref);
  const entry = {
    entity_ref: ev.entity_ref,
    role: ev.role,
    options: ev.options as SlotOption[],
    complete: ev.complete,
    source: existing[at]?.source ?? ("observed" as const),
  };
  return {
    ...spec,
    entity_options:
      at >= 0
        ? existing.map((eo, i) => (i === at ? entry : eo))
        : [...existing, entry],
  };
}

/** Trailing SSE events that overlay onto an already-committed result: coverage
 *  counts (slot_options/entity_options/facet_options) or the deferred
 *  observation values. Buffered pre-commit and replayed in order once the
 *  response event lands (see runWholeResponseStream's `pendingTrailing`). */
type TrailingEvent = Extract<
  SearchEvent,
  { kind: "slot_options" | "entity_options" | "facet_options" | "observations" }
>;

/** `/input/entries/{i}/...` -> i, or null when the pointer names no entry (a
 *  whole-request refusal, e.g. entries.length out of 1..6, or no pointer at
 *  all). */
function pointerPartIndex(pointer: string | null): number | null {
  const m = pointer?.match(/^\/input\/entries\/(\d+)(?:\/|$)/);
  return m ? Number(m[1]) : null;
}

/** Does this part carry the info warning a dataset_resubmit `placeholder`
 *  entry's stub answer is marked with — the client keeps its own richer copy
 *  of that part rather than the stub. */
function isPartRestated(part: Part): boolean {
  return (part.warnings ?? []).some((w) => w.code === "part_restated");
}

/** The bound dcid a resolved Binding carries (a `value` kind with an entity
 *  ref), or null for unbound/absent/set — editShared's where/source edits
 *  always post a single chosen entity, never a multi-select set or a clear. */
function bindingDcid(binding: Binding): string | null {
  return binding.kind === "value" ? (binding.value.ref?.dcid ?? null) : null;
}

/**
 * editShared's per-identity rewrite: apply the SAME edit to every definite
 * entry's own identity (buildDatasetEntries's `editShared` override already
 * restricts this to identity-kind entries). where/when/source/origin live
 * outside `identity.slots` (in `entities`/`requested_window`/`facets`), so
 * this needs no per-part slot-index lookup the way editSlot does — it reads
 * and rewrites the identity's own structure directly. `origin` is left
 * untouched on an identity with no donor role already bound (a plain
 * subject-only identity has nothing to rebind there), matching the
 * eligibility the class doc describes.
 */
function sharedRewrite(
  edit:
    | { axis: "where" | "source"; binding: Binding }
    | { axis: "when"; startYear: number; endYear: number }
    | { axis: "origin"; dcid: string },
): (identity: BaseIdentity) => BaseIdentity {
  return (identity) => {
    switch (edit.axis) {
      case "where": {
        const dcid = bindingDcid(edit.binding);
        return withEntityEdit(
          identity,
          whereEntityRole(identity),
          dcid ? [dcid] : null,
        ).identity;
      }
      case "source": {
        const dcid = bindingDcid(edit.binding);
        return withFacetEdit(
          identity,
          "provenance",
          dcid ? { state: "value", ref: dcid } : null,
        ).identity;
      }
      case "when":
        return {
          ...identity,
          requested_window: {
            kind: "range",
            start_year: edit.startYear,
            end_year: edit.endYear,
          },
        };
      case "origin":
        return "origin" in identity.entities
          ? withEntityEdit(identity, "origin", [edit.dcid]).identity
          : identity;
    }
  };
}

/**
 * The "edit" override case of buildDatasetEntries, applied directly to an
 * existing entries list (as opposed to Part[]): swaps entries[index] for a
 * freshly-identitied entry, carrying its base fields (base_spec_id/
 * base_identity/removed/resolved_stat_var_dcids) forward from whatever
 * entries[index] already held, unless `asBase` supplies its own (a pick,
 * which has no prior state to carry forward). Used both to build a fresh
 * edit's entries (baseline = buildDatasetEntries(parts)) and to build a
 * second edit's entries on top of a still-in-flight first edit's own posted
 * entries (baseline = pendingEntries) — see buildEntries.
 */
function withEditedEntry(
  entries: DatasetResubmitEntry[],
  override: Extract<BuildDatasetEntriesOverride, { kind: "edit" }>,
): DatasetResubmitEntry[] {
  const prior = entries[override.index];
  const priorIdentity = prior?.entry_kind === "identity" ? prior : null;
  const next: DatasetIdentityEntry = {
    entry_kind: "identity",
    variable_text: prior?.variable_text ?? "",
    identity: override.identity,
    base_spec_id: override.asBase
      ? override.asBase.spec_id
      : priorIdentity?.base_spec_id,
    base_identity: override.asBase
      ? override.identity
      : priorIdentity?.base_identity,
    removed: override.removed ?? priorIdentity?.removed,
    resolved_stat_var_dcids:
      override.resolved_stat_var_dcids ??
      priorIdentity?.resolved_stat_var_dcids,
  };
  return entries.map((e, i) => (i === override.index ? next : e));
}

export function createSpecStore(transport: SearchTransport = httpTransport) {
  // The last resolve()/runSpecId(), captured so the run-level error state can
  // offer "try again". A rejected edit is not retried this way; see
  // SpecState.retry's doc.
  let lastRun: (() => Promise<void>) | null = null;

  // Session-scoped resolve() cache: a byte-identical repeat query (same trimmed
  // rawText) skips the full LLM pipeline and commits synchronously. Small and
  // insertion-ordered (oldest entry evicts first). Populated only by a whole
  // run's own commits (incl. trailing merges); dataset edits and refineText
  // do not write it.
  const RESOLVE_CACHE_MAX = 20;
  const resolveCache = new Map<string, ResolveResponse>();
  const cacheKey = (rawText: string) => rawText.trim();
  function cacheSet(key: string, response: ResolveResponse): void {
    if (!resolveCache.has(key) && resolveCache.size >= RESOLVE_CACHE_MAX) {
      const oldest = resolveCache.keys().next().value;
      if (oldest !== undefined) resolveCache.delete(oldest);
    }
    resolveCache.set(key, response);
  }

  // Operation fencing. A raw-text/spec_id run is whole-store scoped: it
  // supersedes the previous run AND any dataset edit or refine in flight (a
  // fresh query makes every part's prior edit moot). A dataset-door edit
  // (editSlot/editDonor/chooseSpec/editShared) shares ONE
  // controller: every such edit resubmits the whole envelope, so there is
  // nothing left to fence per part index. refineText keeps its OWN, older
  // per-part fencing (editOps below) since it's a raw_text re-resolve of one
  // part, unrelated to the dataset door and still independent per index.
  let runOpSeq = 0;
  let runController: AbortController | null = null;
  const editOps = new Map<
    number,
    { op: number; controller: AbortController }
  >();
  let editOpSeq = 0;

  let datasetOpSeq = 0;
  let datasetController: AbortController | null = null;
  // The entries[] most recently POSTED through the dataset door, while that
  // post is still in flight; null once it settles (success or failure) or is
  // superseded and its outcome has been applied. A second edit starting
  // before the first lands builds from THIS, not from committed `parts` —
  // "concurrent edits carry the first forward" (see buildEntries).
  let pendingEntries: DatasetResubmitEntry[] | null = null;

  function abortAllEdits(): void {
    for (const { controller } of editOps.values()) controller.abort();
    editOps.clear();
  }
  function beginRunOp(): { op: number; signal: AbortSignal } {
    runController?.abort();
    abortAllEdits();
    datasetController?.abort();
    datasetController = null;
    datasetOpSeq += 1;
    pendingEntries = null;
    runController = new AbortController();
    runOpSeq += 1;
    return { op: runOpSeq, signal: runController.signal };
  }
  const isCurrentRun = (op: number) => op === runOpSeq;
  function beginEditOp(partIndex: number): { op: number; signal: AbortSignal } {
    editOps.get(partIndex)?.controller.abort(); // only THIS part's previous refine
    const controller = new AbortController();
    editOpSeq += 1;
    const op = editOpSeq;
    editOps.set(partIndex, { op, controller });
    return { op, signal: controller.signal };
  }
  const isCurrentEdit = (partIndex: number, op: number) =>
    editOps.get(partIndex)?.op === op;
  function beginDatasetOp(): { op: number; signal: AbortSignal } {
    datasetController?.abort(); // the previous dataset-door edit, whichever part(s) it targeted
    datasetController = new AbortController();
    datasetOpSeq += 1;
    return { op: datasetOpSeq, signal: datasetController.signal };
  }
  const isCurrentDatasetOp = (op: number) => op === datasetOpSeq;
  /** Abort everything without starting a new request (undo/redo/cancel/reset
   *  are whole-store actions). */
  function invalidateAllOps(): void {
    runController?.abort();
    runController = null;
    runOpSeq += 1;
    abortAllEdits();
    datasetController?.abort();
    datasetController = null;
    datasetOpSeq += 1;
    pendingEntries = null;
  }

  return create<SpecState>((set, get) => {
    // Commit a new whole-envelope snapshot: drop any redo future, append, and
    // point at it. The live-sentence surface is over, since the real
    // sentences render now, but loadingSteps/progress stay: they describe
    // the run that produced this result and feed the debug panel. Does NOT
    // touch editPending: a whole-run commit already has it null by the time
    // it gets here (beginRunOp aborted every edit first), and a dataset/
    // refine commit must only clear ITS OWN target(s) -- each such caller
    // does that itself right after calling commit() (clearEditPendingIfMine/
    // clearEditPendingIfAmong), so a sibling lane still in flight on a
    // different part isn't stripped of its own "Updating…" affordance.
    function commit(snap: Snapshot): void {
      const { history, index } = get();
      const next = history.slice(0, index + 1);
      next.push(snap);
      const i = next.length - 1;
      set({
        ...snap,
        history: next,
        index: i,
        canUndo: i > 0,
        canRedo: false,
        liveSentences: {},
      });
    }

    // Move the pointer without committing (undo / redo). Flash the part+slot
    // that differs from the state we're leaving, if it's a single-slot change
    // in a single part.
    function applyIndex(i: number): void {
      const { history, parts } = get();
      const snap = history[i];
      if (!snap) return;
      set({
        ...snap,
        index: i,
        canUndo: i > 0,
        canRedo: i < history.length - 1,
        lastEditedSlot: changedPartSlot(parts, snap.parts),
        ...noLoadingDetail,
      });
    }

    // Abort every in-flight op and restore history[index] (or initial when
    // there's no snapshot yet) without moving the pointer. Shared shape
    // behind cancel(), and behind undo()/redo()'s first call while anything
    // is in flight.
    function cancelInPlace(): void {
      invalidateAllOps();
      const { history, index } = get();
      const snap = history[index];
      if (snap) {
        set({
          ...snap,
          lastEditedSlot: null,
          editPending: null,
          ...noLoadingDetail,
        });
      } else {
        set({ ...initial });
      }
    }

    function setPartEditError(partIndex: number, message: string): void {
      set({
        parts: get().parts.map((pv, i) =>
          i === partIndex ? { ...pv, editError: message } : pv,
        ),
      });
    }

    /** Refusal/failure handling for a dataset-door edit: `pointer` names
     *  `/input/entries/{i}/...` when the engine can point at one entry, and
     *  that part alone gets the message; otherwise every part `updating`
     *  named (the edit's own targets) gets it — there is no run-level
     *  surface for an edit here, only per-part editError. */
    function setDatasetEditError(
      updating: number[],
      message: string,
      pointer: string | null,
    ): void {
      const at = pointerPartIndex(pointer);
      const targets = at != null ? [at] : updating;
      set({
        parts: get().parts.map((pv, i) =>
          targets.includes(i) ? { ...pv, editError: message } : pv,
        ),
      });
    }

    function clearEditPendingIfMine(partIndex: number): void {
      if (get().editPending === partIndex) set({ editPending: null });
    }

    /** Same guard as clearEditPendingIfMine, but for a dataset-door op, which
     *  can target more than one part at once (editShared fans across every
     *  definite part): only clear editPending when its value is one of THIS
     *  op's own targets, never a sibling lane's -- e.g. a refineText still
     *  running on a part this dataset op never touched owns that part's own
     *  editPending, and a dataset op settling must not steal it. */
    function clearEditPendingIfAmong(indices: number[]): void {
      const pending = get().editPending;
      if (pending !== null && indices.includes(pending)) {
        set({ editPending: null });
      }
    }

    // Merge a patched part back into `parts`/`response`/the committed history
    // snapshot it lives in, preserving whatever editError that part already
    // carried (a trailing merge is never itself an edit outcome). Shared tail
    // of applyTrailingOptions/applyObservations.
    function applyPatchedResponse(
      partIndex: number,
      nextResponse: ResolveResponse,
    ): void {
      const { history, index, parts } = get();
      const nextPart = nextResponse.parts[partIndex];
      if (!nextPart) return;
      const nextParts = parts.slice();
      nextParts[partIndex] = {
        ...buildPartView(nextPart),
        editError: nextParts[partIndex]?.editError ?? null,
      };
      const nextHistory = history.slice();
      if (index >= 0 && nextHistory[index]) {
        nextHistory[index] = {
          ...nextHistory[index],
          response: nextResponse,
          parts: nextParts,
        };
      }
      set({ response: nextResponse, parts: nextParts, history: nextHistory });
    }

    /** Apply a trailing slot_options/entity_options/facet_options event to
     *  the spec it belongs to, wherever that spec lives. `targetIndex` when
     *  known: a single index or a span of indices (a refine's raw-text
     *  resolve can return more than one part, replacing a single index with
     *  several; see refineText). When omitted, every part index in wire
     *  order — a whole-run OR a dataset-door edit's trailing event can
     *  belong to any part, since every part gets a fresh spec_id on a
     *  dataset_resubmit, including a candidate spec inside a candidates
     *  part (patchPartSpec already searches candidates.specs). */
    function applyTrailingOptions(
      ev: Extract<
        SearchEvent,
        { kind: "slot_options" | "entity_options" | "facet_options" }
      >,
      targetIndex?: number | number[],
    ): void {
      const { response, parts } = get();
      if (!response) return;
      const indices =
        targetIndex != null
          ? Array.isArray(targetIndex)
            ? targetIndex
            : [targetIndex]
          : parts.map((_, i) => i);
      for (const i of indices) {
        const nextResponse = patchPartSpec(response, i, ev.spec_id, (s) =>
          mergeTrailingOptions(s, ev),
        );
        if (nextResponse === response) continue;
        applyPatchedResponse(i, nextResponse);
        return;
      }
    }

    /** Apply a trailing 'observations' event: the observation values behind a
     *  definite part, deferred off the SSE `response` event so it isn't
     *  blocked on the observation fetch (see SpecObservations's doc).
     *  Definite-only: a candidates/no_data part has no single spec of record
     *  to attach observations to. Same targetIndex-or-span-or-search-every-
     *  part shape as applyTrailingOptions. */
    function applyObservations(
      ev: Extract<SearchEvent, { kind: "observations" }>,
      targetIndex?: number | number[],
    ): void {
      const { response, parts } = get();
      if (!response) return;
      const indices =
        targetIndex != null
          ? Array.isArray(targetIndex)
            ? targetIndex
            : [targetIndex]
          : parts.map((_, i) => i);
      for (const i of indices) {
        const part = response.parts[i];
        if (part?.status !== "definite" || part.spec.spec_id !== ev.spec_id)
          continue;
        const nextResponse = patchPartSpec(response, i, ev.spec_id, (s) =>
          normalizeSpec({
            ...s,
            observations: ev.observations as SpecObservations,
          }),
        );
        applyPatchedResponse(i, nextResponse);
        return;
      }
    }

    // ---- Streaming detail shared by the initial run (raw_text/spec_id) ----

    function patchProgressAt(
      index: number,
      patch: Partial<StreamProgress>,
    ): void {
      const progress = get().progress;
      set({
        progress: {
          ...progress,
          [index]: { ...(progress[index] ?? EMPTY_PROGRESS), ...patch },
        },
      });
    }

    /** Seed expectedParts + a placeholder progress/loadingSteps bucket per
     *  named variable: the initial run's skeleton list, pre-sized and
     *  indexed before any shape/sentence/step event names a part, since a
     *  later index's `shape` can arrive before an earlier index's. */
    function seedExpectedParts(
      ev: Extract<SearchEvent, { kind: "interpretation" }>,
    ): void {
      const variables = ev.variables ?? [];
      const entities = ev.entities ?? [];
      const dates = (ev.dates ?? []).map(formatExtractedDate).filter(Boolean);
      const expectedParts = variables.map((variableText, index) => ({
        index,
        variableText: variableText || null,
      }));
      const progress: Record<number, StreamProgress> = {};
      const loadingSteps: Record<number, PipelineStepName[]> = {};
      for (const { index } of expectedParts) {
        progress[index] = { ...EMPTY_PROGRESS, variables, entities, dates };
        loadingSteps[index] = [];
      }
      set({ expectedParts, progress, loadingSteps });
    }

    function applyShapeEvent(
      ev: Extract<SearchEvent, { kind: "shape" }>,
    ): void {
      patchProgressAt(ev.variable_index, { shapeLabel: ev.label });
      const live = get().liveSentences;
      // Per-variable order is shape → sentence. Never downgrade a bound
      // sentence back to its skeleton.
      if (live[ev.variable_index]?.bound) return;
      const labels: Record<string, string> = {};
      for (const k of ev.slot_keys ?? []) labels[keyRef(k)] = k.label;
      set({
        liveSentences: {
          ...live,
          [ev.variable_index]: {
            plan: ev.sentence_plan ?? [],
            labels,
            bound: false,
          },
        },
      });
    }

    function applySentenceEvent(
      ev: Extract<SearchEvent, { kind: "sentence" }>,
    ): void {
      const live = get().liveSentences;
      const labels = { ...(live[ev.variable_index]?.labels ?? {}) };
      for (const s of ev.slots ?? []) {
        if (s?.key) labels[keyRef(s.key)] = s.key.label;
      }
      set({
        liveSentences: {
          ...live,
          [ev.variable_index]: {
            plan: ev.sentence_plan ?? [],
            labels,
            bound: true,
          },
        },
      });
    }

    function applyStepEvent(ev: Extract<SearchEvent, { kind: "step" }>): void {
      if (!ev.ran) return;
      const step = ev.step as PipelineStepName;
      if (ev.variable_index == null) {
        // The shared, once-per-request step (today just "extract").
        set({ sharedSteps: [...get().sharedSteps, step] });
        if (ev.ms != null) {
          set({ sharedStepMs: { ...get().sharedStepMs, [step]: ev.ms } });
        }
        return;
      }
      const i = ev.variable_index;
      const steps = get().loadingSteps;
      set({ loadingSteps: { ...steps, [i]: [...(steps[i] ?? []), step] } });
      if (ev.ms != null) {
        patchProgressAt(i, {
          stepMs: { ...(get().progress[i]?.stepMs ?? {}), [step]: ev.ms },
        });
      }
    }

    /** The shared event switch for a whole-run stream (raw_text or spec_id):
     *  seeds skeletons from `interpretation`, updates per-part loading detail,
     *  and commits the whole envelope the instant `response` arrives, since a
     *  raw-text/spec_id run replaces everything. Trailing events search every
     *  part (no target index; see applyTrailingOptions). */
    async function runWholeResponseStream(
      op: number,
      signal: AbortSignal,
      streamCall: (
        onEvent: (ev: SearchEvent) => void,
        signal: AbortSignal,
      ) => Promise<void>,
      queryTextFor: (response: ResolveResponse) => string | null,
      refreshCacheKey: string,
    ): Promise<void> {
      let committed = false;
      let streamError: string | null = null;
      const pendingTrailing: TrailingEvent[] = [];
      const applyTrailing = (pending: TrailingEvent) =>
        pending.kind === "observations"
          ? applyObservations(pending)
          : applyTrailingOptions(pending);
      const refreshCache = () => {
        const r = get().response;
        if (r) cacheSet(refreshCacheKey, r);
      };
      try {
        await streamCall((ev) => {
          if (!isCurrentRun(op)) return;
          switch (ev.kind) {
            case "interpretation":
              seedExpectedParts(ev);
              break;
            case "shape":
              applyShapeEvent(ev);
              break;
            case "sentence":
              applySentenceEvent(ev);
              break;
            case "step":
              applyStepEvent(ev);
              break;
            case "response": {
              const resp = ev.response as ResolveResponse;
              commit(fromResponse(resp, queryTextFor(resp)));
              committed = true;
              for (const pending of pendingTrailing) applyTrailing(pending);
              pendingTrailing.length = 0;
              refreshCache();
              break;
            }
            case "slot_options":
            case "entity_options":
            case "facet_options":
            case "observations":
              if (committed) {
                applyTrailing(ev);
                refreshCache();
              } else {
                pendingTrailing.push(ev);
              }
              break;
            case "error":
              streamError = ev.detail;
              break;
            case "done":
              set({
                telemetry: {
                  llm_usage: ev.telemetry?.llm_usage,
                  elapsedMs: ev.elapsed_ms,
                  timedOut: ev.timed_out,
                },
                warnings: ev.warnings ?? get().warnings,
              });
              break;
          }
        }, signal);
      } catch (e) {
        if (!isCurrentRun(op) || isAbort(e)) return;
        streamError = streamError ?? errorMessage(e);
      }
      if (!isCurrentRun(op)) return;
      if (committed) {
        // The user already has the result; a late stream failure is diagnostic.
        if (streamError)
          console.warn("search stream error after response:", streamError);
        return;
      }
      set({
        status: "error",
        error: streamError ?? "The stream ended without a result.",
      });
    }

    // New free-text query. Streams when the transport supports it (so the
    // loading view reflects real pipeline progress), else falls back to a
    // buffered call. Whole-store scoped: replaces every part.
    async function runResolve(rawText: string): Promise<void> {
      const key = cacheKey(rawText);
      const cached = resolveCache.get(key);
      if (cached) {
        beginRunOp();
        set({
          error: null,
          lastEditedSlot: null,
          editPending: null,
          ...noLoadingDetail,
        });
        commit(fromResponse(cached, rawText));
        return;
      }

      const { op, signal } = beginRunOp();
      set({
        status: "loading",
        error: null,
        lastEditedSlot: null,
        editPending: null,
        telemetry: null,
        warnings: [],
        ...noLoadingDetail,
      });
      if (!transport.resolveStream) {
        try {
          const response = await transport.resolve(rawText, signal);
          if (!isCurrentRun(op)) return;
          commit(fromResponse(response, rawText));
          set({
            telemetry:
              response.diagnostics?.timing_ms || response.diagnostics?.llm_usage
                ? {
                    llm_usage: response.diagnostics?.llm_usage,
                    elapsedMs: response.diagnostics?.timing_ms?.total,
                    timedOut: response.diagnostics?.timed_out ?? undefined,
                  }
                : null,
            warnings: response.diagnostics?.warnings ?? [],
          });
          cacheSet(key, response);
        } catch (e) {
          if (!isCurrentRun(op) || isAbort(e)) return;
          set({ status: "error", error: errorMessage(e) });
        }
        return;
      }

      await runWholeResponseStream(
        op,
        signal,
        (onEvent, sig) => transport.resolveStream!(rawText, onEvent, sig),
        () => rawText,
        key,
      );
    }

    // Spec ID resolution (share links): always a single-part response.
    // Streams when the transport supports it, else falls back to buffered
    // resolveSpecId.
    async function runResolveSpecId(
      specId: string,
      queryHint?: string,
    ): Promise<void> {
      const key = `spec:${specId}`;
      const cached = resolveCache.get(key);
      const effectiveQueryText = queryHint ?? null;

      if (cached) {
        beginRunOp();
        set({
          error: null,
          lastEditedSlot: null,
          editPending: null,
          ...noLoadingDetail,
        });
        commit(
          fromResponse(
            cached,
            effectiveQueryText ?? cached.query_echo?.raw_query ?? null,
          ),
        );
        return;
      }

      const { op, signal } = beginRunOp();
      set({
        status: "loading",
        error: null,
        lastEditedSlot: null,
        editPending: null,
        telemetry: null,
        warnings: [],
        ...noLoadingDetail,
      });

      if (!transport.resolveSpecIdStream) {
        try {
          if (!transport.resolveSpecId) {
            throw new Error(
              "This transport does not support spec_id resolution.",
            );
          }
          const response = await transport.resolveSpecId(specId, signal);
          if (!isCurrentRun(op)) return;
          const qText =
            effectiveQueryText ?? response.query_echo?.raw_query ?? null;
          commit(fromResponse(response, qText));
          set({
            telemetry:
              response.diagnostics?.timing_ms || response.diagnostics?.llm_usage
                ? {
                    llm_usage: response.diagnostics?.llm_usage,
                    elapsedMs: response.diagnostics?.timing_ms?.total,
                    timedOut: response.diagnostics?.timed_out ?? undefined,
                  }
                : null,
            warnings: response.diagnostics?.warnings ?? [],
          });
          cacheSet(key, response);
        } catch (e) {
          if (!isCurrentRun(op) || isAbort(e)) return;
          set({ status: "error", error: errorMessage(e) });
        }
        return;
      }

      await runWholeResponseStream(
        op,
        signal,
        (onEvent, sig) => transport.resolveSpecIdStream!(specId, onEvent, sig),
        (resp) => effectiveQueryText ?? resp.query_echo?.raw_query ?? null,
        key,
      );
    }

    /** Every part in `parts`, as a plain Part[], or null when at least one
     *  hasn't settled yet (a loading placeholder with no `part`) —
     *  buildDatasetEntries needs a real Part for every index. A dataset-door
     *  edit no-ops rather than throwing when this returns null: edits are
     *  unavailable until every part settles; see the class doc. */
    function settledParts(): Part[] | null {
      const parts = get().parts;
      const out: Part[] = [];
      for (const pv of parts) {
        if (!pv.part) return null;
        out.push(pv.part);
      }
      return out;
    }

    /** Build one dataset edit's entries: from the committed `parts` when
     *  nothing is in flight, else by re-applying `override` onto the entries
     *  a still-in-flight post already carries (pendingEntries) — building
     *  fresh from `parts` here would silently drop that earlier, not-yet-
     *  landed edit (the lost-update bug the class doc's "carries the first
     *  forward" note exists to prevent). */
    function buildEntries(
      settled: Part[],
      override?: BuildDatasetEntriesOverride,
    ): DatasetResubmitEntry[] {
      // Nothing in flight: build straight from the committed parts, passing
      // `override` INTO buildDatasetEntries so it short-circuits the edited
      // index before entryForPart ever has to make sense of that part's OWN
      // current (possibly non-definite, possibly identity-less) status --
      // e.g. promoting a candidate whose sibling specs carry no identity of
      // their own must never require one, since the override replaces that
      // entry outright.
      if (!pendingEntries) return buildDatasetEntries(settled, override);
      // A post is still in flight: build on top of what it already posted
      // (see the class doc, "concurrent edits carry the first forward"),
      // applying the SAME override semantics directly to the entries list
      // rather than re-deriving from `settled`, which is still last-
      // committed and would silently drop the in-flight edit.
      if (!override) return pendingEntries;
      if (override.kind === "editShared") {
        return pendingEntries.map((e) =>
          e.entry_kind === "identity"
            ? { ...e, identity: override.rewrite(e.identity) }
            : e,
        );
      }
      return withEditedEntry(pendingEntries, override);
    }

    /** Swap the whole envelope in from a dataset_resubmit response. A part
     *  count mismatch (a candidate collapsing/expanding the fold, etc.) means
     *  the response can't be aligned back to the entries[] indices the
     *  client posted — take it whole rather than guessing (swap-back keys on
     *  index, with a length assert). Otherwise, any part
     *  the response marks `part_restated` (a placeholder entry's stub
     *  answer) is swapped back for the client's own richer stored copy of
     *  that part, since the stub carries no data of its own — only the
     *  envelope's own composed sentence and the siblings come from the
     *  response for that index. Also recomputes lastEditedSlot the same way
     *  undo/redo does (changedPartSlot), so every edit action shares one
     *  "what changed" computation instead of each hand-tracking its own
     *  flash target. */
    function commitDataset(rawResponse: ResolveResponse): void {
      const priorParts = get().parts;
      const queryText = get().queryText;
      const response = normalizeResponse(rawResponse);
      const restatedParts =
        response.parts.length === priorParts.length
          ? response.parts.map((p, i) =>
              isPartRestated(p) ? (priorParts[i]?.part ?? p) : p,
            )
          : response.parts;
      const finalResponse: ResolveResponse = {
        ...response,
        parts: restatedParts,
      };
      commit(fromResponse(finalResponse, queryText));
      set({ lastEditedSlot: changedPartSlot(priorParts, get().parts) });
    }

    /** Post `entries` through the dataset door: one controller for the whole
     *  dataset-edit lane (see class doc); starting a new dataset edit aborts
     *  whatever dataset post is still in flight. `updating` names the
     *  indices this edit's own override touched, for the editError-clearing-
     *  on-start and refusal-fallback-target behavior (see
     *  setDatasetEditError) and the single-target "Updating…" affordance
     *  (editPending stays null for a multi-part editShared fan-out, which
     *  has no single target to name). Streams when the transport supports
     *  resubmitDatasetStream, else falls back to a single buffered
     *  resubmitDataset() call. */
    async function runDataset(
      entries: DatasetResubmitEntry[],
      updating: number[],
    ): Promise<void> {
      const { op, signal } = beginDatasetOp();
      pendingEntries = entries;
      set({
        editPending: updating.length === 1 ? updating[0] : null,
        parts: get().parts.map((pv, i) =>
          updating.includes(i) ? { ...pv, editError: null } : pv,
        ),
      });
      const rawQuery = get().queryText ?? undefined;

      if (!transport.resubmitDatasetStream) {
        try {
          if (!transport.resubmitDataset) {
            throw new Error("This transport does not support dataset edits.");
          }
          const response = await transport.resubmitDataset(
            entries,
            rawQuery,
            signal,
          );
          if (!isCurrentDatasetOp(op)) return;
          commitDataset(response);
        } catch (e) {
          if (!isCurrentDatasetOp(op) || isAbort(e)) return;
          setDatasetEditError(updating, errorMessage(e), errorPointer(e));
        } finally {
          if (isCurrentDatasetOp(op)) {
            pendingEntries = null;
            clearEditPendingIfAmong(updating);
          }
        }
        return;
      }

      // Streaming path: interpretation/shape/sentence/step never arrive on a
      // dataset_resubmit stream (just response, trailing slot_options/
      // entity_options/facet_options/observations by spec_id, then done).
      // commitDataset fires the instant 'response' arrives; trailing events
      // that race ahead of it buffer and replay right after, exactly like
      // runWholeResponseStream's pendingTrailing. Never touches the resolve
      // cache: an edited result must not poison a later byte-identical
      // resolve().
      let committed = false;
      let streamError: string | null = null;
      let streamPointer: string | null = null;
      const pendingTrailing: TrailingEvent[] = [];
      const applyTrailing = (pending: TrailingEvent) =>
        pending.kind === "observations"
          ? applyObservations(pending)
          : applyTrailingOptions(pending);
      try {
        await transport.resubmitDatasetStream(
          entries,
          rawQuery,
          (ev) => {
            if (!isCurrentDatasetOp(op)) return;
            switch (ev.kind) {
              case "response":
                commitDataset(ev.response as ResolveResponse);
                committed = true;
                pendingEntries = null;
                clearEditPendingIfAmong(updating);
                for (const pending of pendingTrailing) applyTrailing(pending);
                pendingTrailing.length = 0;
                break;
              case "slot_options":
              case "entity_options":
              case "facet_options":
              case "observations":
                if (committed) applyTrailing(ev);
                else pendingTrailing.push(ev);
                break;
              case "error":
                streamError = ev.detail;
                streamPointer =
                  (ev as { pointer?: string | null }).pointer ?? null;
                break;
              case "done":
                set({
                  telemetry: {
                    llm_usage: ev.telemetry?.llm_usage,
                    elapsedMs: ev.elapsed_ms,
                    timedOut: ev.timed_out,
                  },
                  warnings: ev.warnings ?? get().warnings,
                });
                break;
            }
          },
          signal,
        );
      } catch (e) {
        if (!isCurrentDatasetOp(op) || isAbort(e)) return;
        streamError = streamError ?? errorMessage(e);
      }
      if (!isCurrentDatasetOp(op)) return;
      if (committed) {
        // The user already has the (possibly candidates/no_data) outcome; a
        // late stream failure is diagnostic only.
        if (streamError)
          console.warn(
            "search dataset edit stream error after response:",
            streamError,
          );
        return;
      }
      // Pre-commit failure: automatic rollback. The current result is untouched.
      setDatasetEditError(
        updating,
        streamError ?? "The stream ended without a result.",
        streamPointer,
      );
      pendingEntries = null;
      clearEditPendingIfAmong(updating);
    }

    /** Splice a refine's returned parts into parts[partIndex] and commit
     *  (spliceResponseParts, lib/contract/parts.ts): one or more parts, a
     *  raw-text resolve can grow the envelope. Only when exactly one part
     *  came back is a no_data/candidates outcome rejected; a dataset-door
     *  edit's outcome always commits instead. With more than one, the query
     *  itself changed shape (it now names more than one variable),
     *  so every returned part is spliced in as-is and rendered per its own
     *  status, rather than rejected as a whole. An empty parts[] (malformed)
     *  is treated the same as a single non-definite part, never spliced,
     *  since an empty splice would desync `response.parts` from the
     *  PartView array built beside it. */
    function commitRefineText(
      partIndex: number,
      rawResponse: ResolveResponse,
    ): void {
      const { response, parts, queryText } = get();
      if (!response) return; // unreachable: a refine only ever targets an already-committed part
      const returned = normalizeResponse(rawResponse).parts;
      if (
        returned.length === 0 ||
        (returned.length === 1 && returned[0].status !== "definite")
      ) {
        setPartEditError(
          partIndex,
          returned[0]?.status === "no_data"
            ? "No data for that change. Keeping the previous result."
            : "That change did not resolve. Keeping the previous result.",
        );
        return;
      }
      const spliced = spliceResponseParts(response, partIndex, returned);
      const nextParts = [
        ...parts.slice(0, partIndex),
        ...returned.map(buildPartView),
        ...parts.slice(partIndex + 1),
      ];
      commit({
        status: "ready",
        response: spliced,
        parts: nextParts,
        error: null,
        queryText,
      });
      set({ lastEditedSlot: null });
    }

    /** Free-text phrase refine on parts[partIndex]: re-resolve `text` via the
     *  raw_text path (transport.resolve/resolveStream), fenced through this
     *  part's own refine slot (beginEditOp), independent of the dataset
     *  door's single controller. The current result stays in place
     *  throughout, and any failure mode sets this part's own editError.
     *  Streams when the transport supports resolveStream. A raw-text stream
     *  can carry interpretation/shape/sentence/step events (a dataset_resubmit
     *  stream carries none of these), but a refine never seeds expectedParts
     *  or touches a sibling's loading detail, so those are ignored here.
     *  Trailing events (slot_options/entity_options/facet_options/
     *  observations) are scoped to the span of indices this refine actually
     *  produced, known only once the `response` event names how many parts
     *  landed, buffered until then, same pendingTrailing shape as
     *  runWholeResponseStream/runDataset. */
    async function runRefineText(
      partIndex: number,
      text: string,
    ): Promise<void> {
      const { op, signal } = beginEditOp(partIndex);
      set({
        editPending: partIndex,
        parts: get().parts.map((pv, i) =>
          i === partIndex ? { ...pv, editError: null } : pv,
        ),
      });

      if (!transport.resolveStream) {
        try {
          const response = await transport.resolve(text, signal);
          if (!isCurrentEdit(partIndex, op)) return;
          commitRefineText(partIndex, response);
        } catch (e) {
          if (!isCurrentEdit(partIndex, op) || isAbort(e)) return;
          setPartEditError(partIndex, errorMessage(e));
        } finally {
          if (isCurrentEdit(partIndex, op)) clearEditPendingIfMine(partIndex);
        }
        return;
      }

      let committed = false;
      let streamError: string | null = null;
      const pendingTrailing: TrailingEvent[] = [];
      // The span of indices this refine's own returned parts landed at, once
      // known (defaults to just partIndex, for a trailing event that somehow
      // races ahead of the response — vanishingly unlikely, but a safe
      // fallback rather than a crash).
      let targetIndices: number[] = [partIndex];
      const applyTrailing = (pending: TrailingEvent) =>
        pending.kind === "observations"
          ? applyObservations(pending, targetIndices)
          : applyTrailingOptions(pending, targetIndices);
      try {
        await transport.resolveStream(
          text,
          (ev) => {
            if (!isCurrentEdit(partIndex, op)) return;
            switch (ev.kind) {
              case "response": {
                const resp = ev.response as ResolveResponse;
                const landed = normalizeResponse(resp).parts.length;
                targetIndices = Array.from(
                  { length: Math.max(landed, 1) },
                  (_, k) => partIndex + k,
                );
                commitRefineText(partIndex, resp);
                committed = true;
                clearEditPendingIfMine(partIndex);
                for (const pending of pendingTrailing) applyTrailing(pending);
                pendingTrailing.length = 0;
                break;
              }
              case "slot_options":
              case "entity_options":
              case "facet_options":
              case "observations":
                if (committed) applyTrailing(ev);
                else pendingTrailing.push(ev);
                break;
              case "error":
                streamError = ev.detail;
                break;
              case "done":
                set({
                  telemetry: {
                    llm_usage: ev.telemetry?.llm_usage,
                    elapsedMs: ev.elapsed_ms,
                    timedOut: ev.timed_out,
                  },
                  warnings: ev.warnings ?? get().warnings,
                });
                break;
              // interpretation/shape/sentence/step: ignored, see doc above.
            }
          },
          signal,
        );
      } catch (e) {
        if (!isCurrentEdit(partIndex, op) || isAbort(e)) return;
        streamError = streamError ?? errorMessage(e);
      }
      if (!isCurrentEdit(partIndex, op)) return;
      if (committed) {
        if (streamError)
          console.warn(
            "search refine stream error after response:",
            streamError,
          );
        return;
      }
      setPartEditError(
        partIndex,
        streamError ?? "The stream ended without a result.",
      );
      clearEditPendingIfMine(partIndex);
    }

    return {
      ...initial,

      resolve: (rawText) => {
        lastRun = () => runResolve(rawText);
        return lastRun();
      },

      runSpecId: (specId, queryHint) => {
        lastRun = () => runResolveSpecId(specId, queryHint);
        return lastRun();
      },

      retry: () => (lastRun ? lastRun() : Promise.resolve()),

      editSlot: async (partIndex, slotIndex, binding) => {
        const settled = settledParts();
        if (!settled) return;
        const spec = get().parts[partIndex]?.spec;
        if (!spec || !spec.slots || !spec.definition?.identity) return;
        // No 'loading' on an edit: keep the current result in place, and
        // don't mutate it until the new one commits. A failure is an
        // automatic rollback (we never left the current state).
        //
        // withResolvedSlotEdit routes the edit to the right member of the
        // spec's own identity: a what/how slot by property dcid, the
        // where-axis to the entity role, the when-axis to requested_window,
        // source to facets.provenance. `removed` (when the edit drops a
        // base-bound entity role or facet axis) rides alongside `identity`,
        // never inside it.
        const { identity, removed } = withResolvedSlotEdit(
          spec,
          slotIndex,
          binding,
        );
        const entries = buildEntries(settled, {
          kind: "edit",
          index: partIndex,
          identity,
          removed,
        });
        await runDataset(entries, [partIndex]);
      },

      editDonor: async (partIndex, donorDcid) => {
        const settled = settledParts();
        if (!settled) return;
        const spec = get().parts[partIndex]?.spec;
        if (!spec || !spec.slots || !spec.definition?.identity) return;
        // The directional 'from' entity role lives at identity.entities.origin;
        // there is no separate donor_dcid field on the wire. Same
        // keep-result-in-place shape as editSlot; the donor isn't a slot
        // phrase, so there's no index to flash.
        const { identity } = withEntityEdit(
          spec.definition.identity,
          "origin",
          [donorDcid],
        );
        const entries = buildEntries(settled, {
          kind: "edit",
          index: partIndex,
          identity,
        });
        await runDataset(entries, [partIndex]);
      },

      editShared: async (edit) => {
        const settled = settledParts();
        if (!settled) return;
        const rewrite = sharedRewrite(edit);
        const entries = buildEntries(settled, { kind: "editShared", rewrite });
        const updating = get().parts.reduce<number[]>(
          (acc, pv, i) => (pv.part?.status === "definite" ? [...acc, i] : acc),
          [],
        );
        if (updating.length === 0) return;
        await runDataset(entries, updating);
      },

      refineText: (partIndex, text) => runRefineText(partIndex, text),

      undo: () => {
        const { status, editPending, index, canUndo } = get();
        // An op in flight means the pointer hasn't moved past the on-screen
        // result yet. Stepping it now would skip over that result entirely.
        // The first undo() just cancels every in-flight op in place; only a
        // second call (once nothing is in flight) actually steps the pointer.
        if (status === "loading" || editPending != null) {
          cancelInPlace();
          return;
        }
        if (!canUndo) return;
        invalidateAllOps();
        applyIndex(index - 1);
      },

      redo: () => {
        const { status, editPending, index, canRedo } = get();
        if (status === "loading" || editPending != null) {
          cancelInPlace();
          return;
        }
        if (!canRedo) return;
        invalidateAllOps();
        applyIndex(index + 1);
      },

      cancel: () => {
        const { status, editPending } = get();
        // editPending edits keep status at its committed value (no 'loading'),
        // so a stuck edit needs its own guard here too, or cancel() could
        // never bail the user out of one.
        if (status !== "loading" && editPending == null) return;
        cancelInPlace();
      },

      chooseSpec: async (partIndex, chosenSpec) => {
        // Candidate promote: post the candidate's own identity verbatim as
        // both `identity` and `base_identity` (via asBase), byte-for-byte, so
        // the shapes trivially match (the engine refuses a shape mismatch
        // when a base is attached) and the promote reads as a no-op resubmit
        // that simply confirms this candidate as the answer.
        const settled = settledParts();
        if (!settled) return;
        const identity = chosenSpec?.definition?.identity;
        if (!identity) return;
        const promote = promoteFromSpec(chosenSpec);
        const entries = buildEntries(settled, {
          kind: "edit",
          index: partIndex,
          identity,
          asBase: { spec_id: chosenSpec.spec_id },
          removed: promote.removed,
          resolved_stat_var_dcids: promote.resolved_stat_var_dcids,
        });
        await runDataset(entries, [partIndex]);
      },

      reset: () => {
        invalidateAllOps();
        resolveCache.clear();
        set(initial);
      },
    };
  });
}

/** App singleton, always talking to the live search engine (createSpecStore's default). */
export const useSpecStore = createSpecStore();
