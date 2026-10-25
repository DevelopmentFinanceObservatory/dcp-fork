/**
 * Search engine contract: TypeScript mirror.
 *
 * Single source of truth for every consumer. These types mirror the shipped
 * engine contract in the apis repo's `src/search/models/` (the authoritative
 * pydantic models; live schema at `GET /api/search/schema`). The engine owns the
 * contract; we consume it. When the models and these types diverge, the models
 * win and these types must be updated (and the schema_version bumped if MAJOR).
 *
 * MIRROR: A second, deliberately-shallow mirror lives at `lib/client/searchClient.ts`
 * (gut-check page event types). Keep both aligned with models.py; this file is the fuller one.
 */

// ---------------------------------------------------------------------------
// Primitives
// ---------------------------------------------------------------------------

/** semver "MAJOR.MINOR", e.g. "1.0", or integer schema version e.g. 1. */
export type SchemaVersion = string | number;

/** The only three outcomes the envelope can carry. Kept for store use; the
 * envelope's own status is PartStatus | "mixed" (see below). */
export type ResolveStatus = "definite" | "candidates" | "no_data";

/** The four outcomes a single Part can carry. */
export type PartStatus = "definite" | "candidates" | "no_data" | "unsupported";

/** A directional flow endpoint (donor/recipient read-back). */
export type Direction = "from" | "to";

/** Candidate ordering; constant in v1 but named so the contract self-describes. */
export type Ordering = "broadest_first";

/** Why a no_data outcome was returned (closed enum). */
export type NoDataReason =
  | "no_observations"
  | "entity_not_resolved"
  | "variable_not_resolved"
  | "no_matching_slice"
  | "denominator_not_available"
  | "role_unresolved";

/** Warning severity levels. */
export type WarningSeverity = "info" | "warn" | "degraded";

/** Qualitative retrieval confidence for an interpretation. */
export type Confidence = "high" | "medium" | "low";

/** Where a slot's option set came from. */
export type SlotOptionsSource = "observed" | "seed";

/** A {dcid, label} pair. Every identifier in the contract is a GraphRef. */
export interface GraphRef {
  /** the graph identifier */
  dcid: string;
  /** plain-language display name, read from the graph */
  label: string;
}

// ---------------------------------------------------------------------------
// Slots
// ---------------------------------------------------------------------------

/** The fixed slot-grammar axes the engine defines. */
export type SlotAxis = "what" | "how" | "where" | "when" | "source";

export interface SlotKey {
  axis: SlotAxis;
  /**
   * The constraint property that defines this slot when one exists; non-null on
   * how/what/where when a specific property drives the axis; null for when,
   * source, and the where-axis slot that binds the subject/recipient entity
   * directly (no constraint property backs it).
   */
  property: GraphRef | null;
  /** human label, e.g. "purpose", "donor" */
  label: string;
}

export interface TimeWindow {
  /** absent => open-ended start */
  start_year?: number;
  /** absent => open-ended end ("to latest") */
  end_year?: number;
}

/**
 * A requested when-axis signal for identity purposes: either a concrete
 * TimeWindow, or the literal "latest" for a query that explicitly asked for
 * the most-recent/current value. Distinct from `undefined` (no date signal at
 * all): a resubmit carrying "latest" re-resolves to whatever year is currently
 * latest, instead of pinning to the year the original request resolved to.
 */
export type RequestedWindow = TimeWindow | "latest";

export type SlotValueKind =
  "entity" | "enum_value" | "time_window" | "source" | "literal";

export interface SlotValue {
  /** the graph object bound, when the value is a graph object */
  ref?: GraphRef;
  value_kind: SlotValueKind;
  /** present iff value_kind === "time_window" */
  time_window?: TimeWindow;
  /** present iff value_kind === "literal" */
  literal?: string;
}

/** Exactly one taxonomy member. */
export interface BindingValue {
  kind: "value";
  value: SlotValue;
}

/** Two or more members, all in scope (union). A length-1 set is illegal. */
export interface BindingSet {
  kind: "set";
  values: SlotValue[];
  /** the group the set was drawn from, when one exists (e.g. "DAC donors") */
  set_ref?: GraphRef;
}

/** Explicit "whole slot in scope" (not null/missing). */
export interface BindingUnbound {
  kind: "unbound";
}

/** The slot's constraint property is not present on the resolved SVs (un-decomposed series). */
export interface BindingAbsent {
  kind: "absent";
}

export type Binding =
  BindingValue | BindingSet | BindingUnbound | BindingAbsent;
export type BindingKind = Binding["kind"];

export interface Slot {
  key: SlotKey;
  /** exactly one of the four binding states */
  binding: Binding;
}

// ---------------------------------------------------------------------------
// Shape
// ---------------------------------------------------------------------------

export interface Shape {
  shape_id: string;
  /** plain-language family name, e.g. "development finance flows" */
  label: string;
  // The five structural anchors. All nullable: a custom-DC import may omit any
  // five-tuple arc, so the StatVar doesn't assert it.
  population_type: GraphRef | null;
  measured_property: GraphRef | null;
  stat_type: GraphRef | null;
  /** structural anchor; present only when the measured property is qualified */
  measurement_qualifier?: GraphRef | null;
  /** structural anchor; present only on a ratio or per-capita measure */
  measurement_denominator?: GraphRef | null;
  /** the constraint + facet slots this family exposes, in display order */
  slot_keys: SlotKey[];
  /** how many candidate StatVars fell into this family */
  member_count: number;
  /**
   * Whether this shape's slots can be edited/refined via construct-and-confirm:
   * the engine builds sibling StatVar candidates for the edited slot and confirms
   * them against the graph before answering, never a guess. True for both named
   * families (e.g. dev_finance_crs_dac, via construct_sv_dcid) and standard/
   * catch-all shapes (via construct_standard_sibling_candidates). False only for
   * a ratio-backed _AsAFractionOf_ standard shape, where no sibling StatVar can
   * be constructed for an edited slot. Gate editability on this rather than
   * treating every slot as freely editable. For family-dependent resubmit field
   * logic (which fields a dataset_resubmit entry must carry), see promote.ts's
   * hasDirectionalEntity / whereSlotHasEntity instead. Defaults to false.
   */
  refine_supported?: boolean;
}

// ---------------------------------------------------------------------------
// StatVar / Entity
// ---------------------------------------------------------------------------

/** Earliest and latest confirmed dates across observed facets for a StatVar. */
export interface DateRange {
  /** earliest confirmed date, e.g. "2012" */
  start?: string | null;
  /** latest confirmed date, e.g. "2022" */
  end?: string | null;
}

export interface StatVar {
  ref: GraphRef;
  /** back-reference to its Shape family */
  shape_id: string;
  /** the slot members THIS StatVar realises, one per bound slot */
  slot_values: { key: SlotKey; value: SlotValue }[];
  /** earliest and latest confirmed dates across observed facets */
  data_date_range?: DateRange | null;
  /** true=confirmed at recipient directly, false=via donor only, null=not checked */
  data_confirmed_at_recipient?: boolean | null;
}

export type EntityRole =
  | { kind: "subject" }
  | { kind: "directional"; role: GraphRef; direction: "from" | "to" };

export interface Entity {
  ref: GraphRef;
  /** e.g. Country, AdministrativeArea1, ContinentalUnion, Organization */
  entity_type?: GraphRef;
  /** Always present. Defaults to {kind:"subject"} when the seam is off. */
  role: EntityRole;
}

// ---------------------------------------------------------------------------
// Coverage
// ---------------------------------------------------------------------------

export interface BreadthDim {
  /** the dimension, e.g. "donors", "years", "methods", "sources" */
  label: string;
  count: number;
}

export type Coverage =
  | {
      kind: "exact";
      has_data: boolean;
      observation_count: number;
      dimensions?: BreadthDim[];
      window?: TimeWindow;
    }
  | {
      kind: "breadth";
      has_data: boolean;
      dimensions: BreadthDim[];
      window?: TimeWindow;
    }
  | { kind: "bare"; has_data: boolean; window?: TimeWindow };

export type CoverageKind = Coverage["kind"];

// ---------------------------------------------------------------------------
// Resolution trace
// ---------------------------------------------------------------------------

export interface ResolvedFilter {
  key: SlotKey;
  binding_kind: BindingKind;
  /** the bound graph objects (empty for unbound) */
  refs: GraphRef[];
}

export type PipelineStepName =
  "extract" | "recall" | "shape" | "bind" | "materialise" | "answer";

export interface PipelineStep {
  step: PipelineStepName;
  /** false for extract on the parsed / dataset_resubmit paths */
  ran: boolean;
  /** step latency, when measured */
  ms?: number;
}

export interface ResolutionTrace {
  resolved_stat_vars: GraphRef[];
  resolved_entities: GraphRef[];
  resolved_sources: GraphRef[];
  slot_filters: ResolvedFilter[];
  applied_window?: TimeWindow;
  date_source?: "query" | "default" | "coverage_clamp";
  /** the six steps, in order, with skip/timing */
  pipeline_trace: PipelineStep[];
  /** SVs passing the relevance threshold before the grounding/confirm cap */
  n_recalled?: number | null;
  /**
   * The date window originally requested (query intent), independent of
   * applied_window's coverage narrowing; absent when no date was requested.
   * The literal string "latest" means the query explicitly asked for the
   * most-recent/current value; distinct from absent (no date signal at all).
   * spec_id is anchored on this value. Round-trip it verbatim as
   * BaseIdentity.requested_window on a later dataset_resubmit entry to keep
   * identity stable across promote.
   */
  requested_window?: RequestedWindow;
}

// ---------------------------------------------------------------------------
// Slot / entity options (the taxonomy a slot was bound against)
// ---------------------------------------------------------------------------

/** One candidate value the binder had available for a slot. */
export interface SlotOption {
  /** one taxonomy member or observed facet value */
  value: SlotValue;
  /**
   * This option's observation footprint if bound instead of the current value,
   * representing the "consequence before commit" count. Populated only when the request set
   * include_option_coverage; null otherwise.
   */
  coverage?: Coverage | null;
}

/**
 * The full candidate set one slot was bound against. `key` joins to the matching
 * `Spec.slots` entry on axis + property.dcid (see SlotKey ref form "axis:dcid").
 */
export interface SlotOptions {
  key: SlotKey;
  options: SlotOption[];
  /** true when this is the full known set (a curated seed), false when observed-only */
  complete: boolean;
  source: SlotOptionsSource;
}

/**
 * One facet axis (e.g. provenance, unit, measurementMethod) the binder observed
 * alternatives for. Keyed by a free-form facet axis name, since facets aren't
 * part of the shape's slot grammar. A read-only passthrough; nothing renders
 * it yet.
 */
export interface FacetOptions {
  axis: string;
  options: SlotOption[];
  truncated: boolean;
  source: SlotOptionsSource;
}

/**
 * The candidate set a directional *entity* slot was bound against (dev-finance
 * donor "from" only in v1; the recipient "to" rides on Spec.slot_options).
 */
export interface EntityOptions {
  /** dcid of the currently-bound directional entity; joins an entry in SentenceToken.entity_refs */
  entity_ref: string;
  role: Direction;
  options: SlotOption[];
  complete: boolean;
  source: SlotOptionsSource;
}

// ---------------------------------------------------------------------------
// SpecObservations: the observation values behind a Spec's coverage
// ---------------------------------------------------------------------------

/** One (date, value) pair from a resolved StatVar's observation series. */
export interface ObservationPoint {
  /** the observation date, e.g. "2018" */
  date: string;
  /** null when the graph reports a date with no value */
  value: number | null;
}

/** One (stat_var, entity) pair's observation points, in chronological order. */
export interface ObservationSeries {
  stat_var_dcid: string;
  entity_dcid: string;
  /**
   * Display label for entity_dcid, when the engine can supply one directly.
   * Needed because a dev-finance bilateral StatVar's series is keyed by the
   * DONOR entity, which may not appear anywhere else in the response (Spec.entities
   * holds only the recipient) -- so the client can't always resolve a label by
   * joining entity_dcid elsewhere. Absent/null when the engine has no label handy;
   * consumers fall back to Spec.entities / resolution.resolved_entities / the
   * dcid tail.
   */
  entity_label?: string | null;
  /** the full series when SpecObservations.complete is true, else latest points only */
  points: ObservationPoint[];
  /** provenance of the observation facet(s) these points were read from */
  source_refs: GraphRef[];
}

/**
 * The observation values behind a Spec's coverage: an always-on bounded preview,
 * or the full series when the resolved answer is small enough to ship in full.
 * Describes the SAME (stat_var, entity) selection Spec.coverage already reports.
 */
export interface SpecObservations {
  /** one entry per (stat_var, entity) pair with observations */
  series: ObservationSeries[];
  /** total observation count across every series; known even when truncated */
  total_obs: number;
  /** true when every series carries its full point set; false when truncated to latest points */
  complete: boolean;
}

// ---------------------------------------------------------------------------
// Spec
// ---------------------------------------------------------------------------

export interface Spec {
  /**
   * Deterministic hash of (shape_id + canonical slot bindings). Permalink-safe;
   * dedup key; golden-comparison handle; cache key. Same spec_id implies same
   * Spec.entities GraphRef set. Does not depend on slot_options/entity_options.
   */
  spec_id: string;
  shape: Shape;
  /** one entry per slot the shape defines, each in a binding state */
  slots: Slot[];
  /**
   * The candidate set each bound slot was chosen from, one entry per slot with a
   * non-empty taxonomy (omits when/source and empty slots). Rides on the response;
   * replaces the hand-built FixtureOptions taxonomy once the engine is wired.
   */
  slot_options?: SlotOptions[];
  /** the candidate set each bound directional entity was chosen from (dev-finance donor) */
  entity_options?: EntityOptions[];
  /** slot axes this shape defines that don't apply to this spec, excluded from resubmit editing */
  inapplicable_slots?: string[];
  /** slot axes this shape defines that the binder could not resolve a value for */
  unresolved_slots?: string[];
  /** facet-level (e.g. provenance/unit/measurementMethod) option sets the binder observed */
  facet_options?: FacetOptions[];
  /** resolved StatVar(s) inside the region; >= 1 when grounded */
  stat_vars: StatVar[];
  /** resolved entities the data is about; may be empty if "where" is unbound */
  entities: Entity[];
  coverage: Coverage;
  resolution: ResolutionTrace;
  /** the variable text this Spec answers (populated for every resolved variable) */
  variable_text?: string | null;
  /**
   * Whether this spec's representative stat var has observations at the resolved
   * place. true=confirmed; false=matched but no data here (flagged_match); null=not
   * assessed (no place, or a named family).
   */
  available_at_place?: boolean | null;
  /** qualitative, relative retrieval confidence; null when not assessed */
  confidence?: Confidence | null;
  /**
   * The observation values behind coverage above; absent when not resolved for this
   * Spec (no entity to probe, options.include_observations is false, deferred to a
   * trailing SSE `observations` event, or a candidates/nearest_real/flagged_match spec).
   * Populated only on a primary definite answer.
   */
  observations?: SpecObservations | null;
  /** canonical SpecDefinition from dfo-apis */
  definition?: {
    identity?: BaseIdentity;
    [key: string]: unknown;
  } | null;
  /**
   * Confirmation sentence for this spec (definite spec, or one candidate
   * among several), lifted by normalizeSpec from `resolved.rendered_sentence`
   * like every other resolved field. Use `partSentence()` (lib/contract/parts)
   * rather than reading this directly on a candidates/no_data part, since
   * those carry their own summary sentence at the part level instead.
   */
  rendered_sentence?: string | null;
  /** Token form of rendered_sentence, same lift, same caveat. */
  sentence_plan?: SentenceToken[] | null;
  /** raw nested resolved payload from dfo-apis; provenance only, everything
   * useful off it is already lifted onto this Spec's own top-level fields */
  resolved?: {
    sentence_plan?: SentenceToken[];
    rendered_sentence?: string;
    [key: string]: unknown;
  } | null;
}

// ---------------------------------------------------------------------------
// Sentence plan (the engine's rendered, tokenised confirmation sentence)
// ---------------------------------------------------------------------------

/**
 * One token in the ordered sentence plan: connective text, or a bound phrase.
 * `rendered_sentence` is the flat join of every token's `text`. A "slot" token
 * with nothing bound still appears, with text="".
 */
export interface SentenceToken {
  /** "note" is an aside the composer attaches after the terminal "." (e.g.
   *  "This is a loose match for your query.") — never a chip, always rendered
   *  as muted plain text, and never part of a phrase or qualifier group. */
  kind: "text" | "slot" | "note";
  /** rendered text for this token; empty string for a slot with nothing bound */
  text: string;
  /** the grammatical axis this token fills, when kind==="slot" */
  axis?: SlotAxis | null;
  /** the constraint property dcid this token renders, when one exists */
  property_dcid?: string | null;
  /** "from"/"to" when this token renders a directional entity role */
  role?: Direction | null;
  /** join key to Spec.slots / SlotOptions: "axis:property_dcid" (SlotKey ref form) */
  binding_ref?: string | null;
  /**
   * entity dcids this token renders, one per entity in the token's group (e.g. a
   * multi-recipient "to" token carries every recipient's dcid, in the same order
   * as the entities joined into `text`); absent/[] when this isn't a directional
   * role token
   */
  entity_refs?: string[];
  /**
   * Which part (index into ResolveResponse.parts) this token belongs to, on a
   * composed envelope plan. Absent (not null) on a token shared across every
   * part — a connective, a hoisted qualifier, or the terminal "." — so compare
   * with `== null` rather than `=== null`. Unused on a part's own
   * rendered_sentence/sentence_plan (definite Spec, or a candidates/no_data
   * Part's summary sentence), which describe one part already.
   */
  part_index?: number | null;
}

// ---------------------------------------------------------------------------
// Envelope sub-objects
// ---------------------------------------------------------------------------

/**
 * A set of 2..N competing Specs, ordered broadest-first. There is no
 * candidates-level sentence array on the wire: each candidate spec carries
 * its own confirmation sentence at `spec.rendered_sentence`/`sentence_plan`
 * (lifted by normalizeSpec), read via `partSentence` per spec.
 */
export interface CandidateSet {
  /** constant "broadest_first" in v1 */
  ordering: Ordering;
  /** the maximum number of candidates applied */
  max_candidates: number;
  /** 2..N competing Specs, broadest to narrowest */
  specs: Spec[];
  /** true when max_candidates clamped the full competing set */
  truncated?: boolean;
}

/** Outcome when no grounded result can be returned. */
export interface NoData {
  /** why nothing could be returned (closed enum) */
  reason: NoDataReason;
  /** optional; real, grounded specs with data adjacent to the request */
  nearest_real?: Spec[] | null;
  /**
   * optional; the single best-matched variable that exists but has no observation
   * at the resolved place (available_at_place=false). Distinct from nearest_real:
   * same variable + same place with no data here, vs. constraint-relaxed specs
   * that do have data nearby.
   */
  flagged_match?: Spec | null;
}

/** A run-health signal. */
export interface Warning {
  /** stable machine code, e.g. DATE_COVERAGE_PARTIAL, COUNT_UNAVAILABLE */
  code: string;
  severity: WarningSeverity;
  message: string;
}

/**
 * The engine cannot answer this variable at all because the ask falls
 * outside what the taxonomy models. Distinct from `no_data`, a modeled ask
 * with no observations. Nothing in the UI renders this today.
 */
export interface Unsupported {
  code: string;
  pointer?: string | null;
  detail?: string | null;
  definition?: Record<string, unknown> | null;
}

/**
 * One resolved entity inside a `ParsedPart` restatement: the canonical text
 * the engine used for it, plus its role when it's a directional entity (e.g.
 * "donor"/"recipient"); null/absent for a plain subject entity.
 */
export interface RestatementEntity {
  text: string;
  role_text?: string | null;
}

/**
 * The engine's own canonical restatement of one resolved (or re-grounded)
 * variable: the entities, date request, unit and source text it actually
 * used — not the user's original wording. Round-tripping it through a
 * `parsed` dataset_resubmit entry (unmodeled here — see DatasetResubmitEntry)
 * reproduces the same DateRequest, entities, unit, source, and spec_id.
 * Never render this as "what you asked."
 */
export interface ParsedPart {
  variable_text: string;
  entities: RestatementEntity[];
  /** null for an open-start or reversed window, which has no phrase */
  time_text?: string | null;
  unit_text?: string | null;
  source_text?: string | null;
}

/** Fields every `Part` variant carries, regardless of its own status. */
export interface PartBase {
  /**
   * The asked variable text, in query order. Echoed back onto the rebuilt
   * part for every dataset_resubmit entry kind (identity, candidates,
   * placeholder, and parsed via its nested ParsedPart), so this is always
   * populated there. Null only when the whole posted query was empty or
   * whitespace-only (raw_text door), which refuses with
   * variable_not_resolved before extraction runs and so has no text to name.
   */
  variable_text?: string | null;
  /** This part's own signals only (e.g. `binding_folded`, `observations_omitted`). */
  warnings: Warning[];
  /** This part's own by_step timing. Excludes the shared once-per-request `extract` step. */
  timing_ms?: Timing | null;
  /**
   * Present only under response_options.include_sentence. A candidates or
   * no_data part carries a summary sentence here. A definite part's
   * confirmation sentence lives at `spec.rendered_sentence` (lifted by
   * normalizeSpec; `spec.resolved` is provenance only).
   */
  rendered_sentence?: string | null;
  /** Token form of rendered_sentence, same gating. */
  sentence_plan?: SentenceToken[] | null;
  /**
   * The engine's canonical restatement of this part, populated on raw_text
   * and parsed runs; null on every modeled dataset_resubmit entry kind
   * (identity, candidates, placeholder carry no phrase to restate — only the
   * unmodeled `parsed` entry gets one back). On the wire and typed for a
   * later consumer; nothing here reads this field yet.
   */
  restatement?: ParsedPart | null;
}

export interface DefinitePart extends PartBase {
  status: "definite";
  spec: Spec;
}

export interface CandidatesPart extends PartBase {
  status: "candidates";
  candidates: CandidateSet;
}

export interface NoDataPart extends PartBase {
  status: "no_data";
  no_data: NoData;
}

export interface UnsupportedPart extends PartBase {
  status: "unsupported";
  unsupported: Unsupported;
}

/**
 * One outcome per variable the query asked about, in query order. Two parts
 * folded onto the same five-tuple shape carry the identical spec_id. Every
 * part after the first in that group carries `binding_folded` in its own
 * warnings, with no independent spec beyond the shared representative.
 */
export type Part = DefinitePart | CandidatesPart | NoDataPart | UnsupportedPart;

/** Latency breakdown for the response. */
export interface Timing {
  /** total run latency in ms */
  total: number;
  /** per-step latency in ms */
  by_step?: Record<string, number> | null;
}

/** Run health, warnings, timing, and build stamp. */
export interface Diagnostics {
  /** engine build id; distinct from schema_version */
  engine_build: string;
  /** degraded-mode, applied-signal, partial-graph signals */
  warnings: Warning[];
  timing_ms?: Timing | null;
  /** per-request LLM token counts {input_tokens, output_tokens, cached_tokens} */
  llm_usage?: Record<string, number> | null;
  /** unique request trace ID from backend for debugging and telemetry */
  trace_id?: string | null;
  /** buffered transport only: soft deadline truncated this response (null on SSE, where the done event carries it) */
  timed_out?: boolean | null;
}

export interface QueryEcho {
  entry_path: "raw_text" | "parsed" | "dataset_resubmit";
  /** the user's words (raw_text path) */
  raw_query?: string;
  /** post-extraction normalised text (raw_text path) */
  normalized_query?: string;
  /** the variable text resolved, after conjunction split */
  variable_text: string[];
  /** true on the parsed and dataset_resubmit paths */
  extract_skipped: boolean;
}

// ---------------------------------------------------------------------------
// ResolveResponse (the envelope)
// ---------------------------------------------------------------------------

/**
 * The wire envelope, unmodified. One entry in `parts` per variable the query
 * asked about, in query order: a single-variable query is one part, so
 * `status === parts[0].status`. Two parts folded onto the same five-tuple
 * shape carry the identical spec_id; the later one carries `binding_folded`
 * in its own warnings instead of an independent spec.
 *
 * Every part renders, in order — rendered position always equals array
 * index. Use `partAt`/`partSentence`/`patchPartSpec`/`spliceResponseParts`
 * (lib/contract/parts) rather than indexing `parts` directly.
 */
export interface ResolveResponse {
  schema_version: SchemaVersion;
  /** the parts' shared status when every part agrees, else "mixed" */
  status: PartStatus | "mixed";
  query_echo: QueryEcho;
  diagnostics: Diagnostics;
  parts: Part[];
  /**
   * The sentence composed across every part: one connected phrase rather than
   * parts[].map(partSentence) stitched together client-side. A single-part
   * response's plan equals that part's own plan. Absent on an older capture
   * that predates composition.
   */
  rendered_sentence?: string | null;
  /** Token form of rendered_sentence, same composition, same caveat. Each
   *  token carries `part_index` naming which variable it belongs to, or
   *  omits it for a token shared across every part (see SentenceToken). */
  sentence_plan?: SentenceToken[] | null;
}

// ---------------------------------------------------------------------------
// Request
// ---------------------------------------------------------------------------

export interface RemovedParts {
  facets?: string[];
  entities?: string[];
}

/** path A: UI, Python package. Extract runs. */
export interface RawTextInput {
  kind: "raw_text";
  query: string;
}

/** path B (MCP): extract skipped. Unsupported engines return 400 for this. */
export interface ParsedInput {
  kind: "parsed";
  variable_text: string[];
  entity_text?: string[];
  time_text?: string;
  source_text?: string;
  /** echo-only; the engine must not re-parse it */
  raw_query?: string;
}

/** path D: resolve from an existing spec_id directly. */
export interface SpecIdInput {
  kind: "spec_id";
  spec_id: string;
}

// ---------------------------------------------------------------------------
// path E: dataset_resubmit — resubmit every part of a multi-variable
// response in one request, and get the full, re-composed envelope back.
// ---------------------------------------------------------------------------

/**
 * One candidate's identity contribution inside a `candidates` dataset_resubmit
 * entry: the same pair `promoteFromSpec` derives from a Spec, but without the
 * base/removed fields, which apply to the whole entry rather than one
 * candidate.
 */
export interface DatasetCandidateEntry {
  identity: BaseIdentity;
  resolved_stat_var_dcids?: string[];
}

/**
 * A resolved (or edited) part, resubmitted as its full identity: `identity`
 * plus the sibling fields `promoteFromSpec` derives (`base_spec_id`/
 * `base_identity`/`removed`/`resolved_stat_var_dcids`), plus `entry_kind` and
 * `variable_text` (every entry carries its own, since a multi-part envelope
 * has no single shared variable_text). A shape change (what the variable IS)
 * refuses `shape_mismatch`; changing what a variable is stays a fresh
 * raw_text run.
 */
export interface DatasetIdentityEntry {
  entry_kind: "identity";
  variable_text: string;
  identity: BaseIdentity;
  base_spec_id?: string;
  base_identity?: BaseIdentity;
  removed?: RemovedParts;
  resolved_stat_var_dcids?: string[];
}

/**
 * A part still carrying two or more competing specs, resubmitted as the same
 * candidate set: `ordering`/`truncated` echoed verbatim from
 * `CandidatesPart.candidates` (its `max_candidates` is not part of this
 * entry — C135 never defined it here, and the engine rejects it with 400
 * "Extra inputs are not permitted"), and each candidate's own identity in
 * posted order (at least 2). A candidate that promotes to no_data drops
 * server-side; fewer than 2 survivors return definite (1) or no_data (0).
 */
export interface DatasetCandidatesEntry {
  entry_kind: "candidates";
  variable_text: string;
  ordering: Ordering;
  truncated: boolean;
  /** at least 2 */
  candidates: DatasetCandidateEntry[];
}

/**
 * A part that couldn't be resolved, resubmitted to hold its position in the
 * envelope rather than to be re-evaluated. Returns a stub part carrying the
 * part-scoped info warning `part_restated`; the client keeps its own richer
 * copy of that part and takes only the envelope sentence and the siblings
 * from the response.
 */
export interface DatasetPlaceholderEntry {
  entry_kind: "placeholder";
  variable_text: string;
  status: "no_data" | "unsupported";
  reason?: NoDataReason;
  code?: string;
}

/**
 * Contract v1 models three entry kinds. A fourth, `parsed` (a fresh resolve
 * of an edited restatement), exists on the wire but is never modeled here
 * and never emitted.
 */
export type DatasetResubmitEntry =
  DatasetIdentityEntry | DatasetCandidatesEntry | DatasetPlaceholderEntry;

/**
 * path E: resubmit every part of a multi-variable response at once and get
 * back the full N-part envelope with the composed sentence, rather than one
 * identity-edit request per part with client-side splicing. `entries` is 1
 * to 6, in response part order. `raw_query` is echo-only, for `query_echo`.
 */
export interface DatasetResubmitInput {
  kind: "dataset_resubmit";
  /** 1 to 6, in response part order */
  entries: DatasetResubmitEntry[];
  raw_query?: string;
}

export type ResolveInput =
  | RawTextInput
  | ParsedInput
  | SpecIdInput
  | DatasetResubmitInput;

export interface ResolveOptions {
  max_candidates?: number;
  coverage?: "auto" | "prefer_exact" | "breadth_only" | "none";
  place_as_constraint?: boolean;
  /**
   * When true (the default; absent also means true), the engine returns
   * rendered_sentence / sentence_plan inline. Set false to opt out.
   */
  include_sentence?: boolean;
  /** when true, each SlotOption.coverage carries an observation count */
  include_option_coverage?: boolean;
  /**
   * When true, Spec.observations carries the resolved answer's observation
   * values. The engine treats absent as false; the HTTP transport sends true
   * unless a caller opts out. Delivery mirrors include_option_coverage's
   * SSE/buffered transport split.
   */
  include_observations?: boolean;
}

export interface ResolveRequest {
  schema_version: SchemaVersion;
  input: ResolveInput;
  options?: ResolveOptions;
  response_options?: ResolveOptions;
}

// ---------------------------------------------------------------------------
// Options: on-demand slot alternatives (POST /api/search/options) & PlaceOptions
// ---------------------------------------------------------------------------

/**
 * The identity core's own shape descriptor (dfo-apis `IdentityShape`):
 * `{kind:"statvar_schema", population_type?, measured_property?, ...}` (bare
 * dcid strings, not GraphRef pairs) or `{kind:"stat_var", ...}` pinning one
 * StatVar directly. Distinct from the response-side `Shape` above (which
 * carries GraphRef pairs and display fields like `label`/`slot_keys`).
 * Opaque here: never constructed by a consumer, only copied through from
 * `Spec.definition.identity.shape` or compared for equality.
 */
export interface IdentityShape {
  kind: "statvar_schema" | "stat_var";
  [key: string]: any;
}

/**
 * One what/how identity slot's binding state (dfo-apis `IdentityBinding`):
 * the identity core's own wire shape, distinct from the engine's resolved
 * `Binding` union above (`Slot.binding`, `{kind, value}`). `state` (not
 * `kind`) is the discriminator; `ref`/`refs` carry bare dcid strings, never a
 * full GraphRef.
 */
export type IdentityBinding =
  | { state: "value"; ref: string }
  | { state: "set"; refs: string[] }
  | { state: "unbound" };

/** One what/how slot's identity contribution: bare property dcid + binding
 *  state. Never where/when/source — see BaseIdentity's field docs. */
export interface IdentitySlot {
  property: string;
  binding: IdentityBinding;
}

/** A completed unit-conversion request — legal only inside a `unit`-axis
 *  facet binding's `request` form. */
export interface IdentityUnitRequest {
  currency: string;
  prices: "current" | "constant";
  /** required exactly when prices === 'constant' */
  base_year?: number;
}

/** One facet axis's binding state: the slot union minus `unbound` (a facet
 *  map is sparse — an unconstrained axis is simply absent, not `unbound`),
 *  plus the unit axis's request form. */
export type IdentityFacetBinding =
  | { state: "value"; ref: string }
  | { state: "set"; refs: string[] }
  | { state: "value"; request: IdentityUnitRequest };

/** The identity core's own `requested_window` union — distinct from the
 *  engine's resolved `RequestedWindow` (`TimeWindow | "latest" | undefined`
 *  above): `undefined` there maps to `{kind:"all"}` here, since a
 *  BaseIdentity always carries this member, never omits it. */
export type IdentityWindow =
  | { kind: "all" }
  | { kind: "latest" }
  | { kind: "range"; start_year?: number; end_year?: number };

/**
 * Contract v1 identity core (`BaseIdentity` on the wire): exactly what gets
 * hashed into spec_id, serialised once and echoed back verbatim — never
 * re-derived client-side. `shape` is opaque here (never constructed by this
 * app, only copied or compared); `slots` covers only what/how axes — where
 * lives in `entities` (keyed `observationAbout`/`origin`/`destination`), when
 * in `requested_window`, source in `facets.provenance`.
 */
export interface BaseIdentity {
  identity_version: "spec1";
  shape: IdentityShape;
  slots: IdentitySlot[];
  entities: Record<string, string[]>;
  requested_window: IdentityWindow;
  facets?: Record<string, IdentityFacetBinding>;
}

export interface OptionsTarget {
  role?: string;
  scope?: "peers" | "children";
}

export interface OptionsRequest {
  schema_version?: SchemaVersion;
  identity?: BaseIdentity;
  for?: OptionsTarget;
  resolved_stat_var_dcids?: string[];
  // Backwards-compatible fields matching PlaceOptionsRequest
  stat_var_dcids?: string[];
  anchor_dcid?: string;
  scope?: PlaceOptionsScope;
}

export interface OptionItem {
  dcid: string;
  label: string;
  value?: SlotValue;
}

export interface OptionsResponse {
  options: OptionItem[];
  complete: boolean;
}

/** Which anchor types each scope supports in v1 is documented on the engine's
 * options / place_options endpoint; an unsupported anchor type is a typed 400,
 * not a silent empty result. */
export type PlaceOptionsScope = "peers" | "children";

export interface PlaceOptionsRequest {
  stat_var_dcids?: string[];
  resolved_stat_var_dcids?: string[];
  anchor_dcid?: string;
  scope: PlaceOptionsScope;
  identity?: BaseIdentity;
}

export interface PlaceOption {
  dcid: string;
  label: string;
}

export interface PlaceOptionsResponse {
  options: PlaceOption[];
  complete: boolean;
}

// ---------------------------------------------------------------------------
// Response and Spec Normalization
// ---------------------------------------------------------------------------

/**
 * Normalizes a Spec from dfo-apis (where fields live under `spec.resolved`, or flat)
 * into the complete, safe interface expected by the UI and ViewModel projection.
 */
export function normalizeSpec(spec: any): Spec {
  if (!spec) return spec;
  const resolved = spec.resolved;
  const src = resolved ?? spec;

  // Normalize entities (dfo-apis returns flat ref string & role string, or in resolved.entities)
  const rawEntities =
    spec.entities ??
    resolved?.entities ??
    spec.resolution?.resolved_entities ??
    [];
  const entities: Entity[] = rawEntities.map((e: any) => {
    if (!e) return e;
    const ref =
      typeof e === "string"
        ? { dcid: e, label: e }
        : typeof e.ref === "string"
          ? { dcid: e.ref, label: e.label ?? e.ref }
          : (e.ref ?? { dcid: e.dcid ?? "", label: e.label ?? e.dcid ?? "" });
    let role = e.role;
    if (typeof role === "string") {
      role = {
        kind:
          role === "observationAbout"
            ? "subject"
            : role === "provider"
              ? "directional"
              : role === "recipient"
                ? "directional"
                : role,
        direction:
          role === "provider"
            ? "from"
            : role === "recipient"
              ? "to"
              : undefined,
      };
    } else if (!role) {
      role = { kind: "subject" };
    }
    return {
      ...e,
      ref,
      role,
    };
  });

  // Normalize stat_vars (dfo-apis returns ref as string, or under resolved.stat_vars)
  const rawStatVars =
    spec.stat_vars ??
    resolved?.stat_vars ??
    spec.resolution?.resolved_stat_vars ??
    (spec.observations?.series ?? resolved?.observations?.series ?? [])
      .map((s: any) => s.stat_var)
      .filter(Boolean);
  const stat_vars: StatVar[] = rawStatVars.map((sv: any) => {
    if (!sv) return sv;
    const ref =
      typeof sv === "string"
        ? { dcid: sv, label: sv }
        : typeof sv.ref === "string"
          ? { dcid: sv.ref, label: sv.label ?? sv.ref }
          : (sv.ref ?? {
              dcid: sv.dcid ?? "",
              label: sv.label ?? sv.dcid ?? "",
            });
    return {
      ...sv,
      ref,
      shape_id:
        sv.shape_id ?? spec.shape?.shape_id ?? resolved?.shape?.shape_id ?? "",
    };
  });

  // Normalize observations series structure
  let observations: SpecObservations | null =
    spec.observations ?? resolved?.observations ?? src.observations ?? null;
  if (observations?.series) {
    const rawSeries = observations.series as any[];
    const normalizedSeries: ObservationSeries[] = rawSeries.map((s: any) => {
      const stat_var_dcid =
        s.stat_var_dcid ??
        (typeof s.stat_var === "string"
          ? s.stat_var
          : (s.stat_var?.dcid ??
            (typeof s.stat_var?.ref === "string"
              ? s.stat_var.ref
              : s.stat_var?.ref?.dcid))) ??
        "";
      const entity_dcid =
        s.entity_dcid ??
        (typeof s.entities?.[0] === "string"
          ? s.entities[0]
          : typeof s.entities?.[0]?.ref === "string"
            ? s.entities[0].ref
            : s.entities?.[0]?.ref?.dcid) ??
        "";
      const label = s.entities?.[0]?.label ?? s.entity_label;
      return {
        ...s,
        stat_var_dcid,
        entity_dcid,
        ...(label !== undefined ? { entity_label: label } : {}),
        points: s.points ?? [],
      };
    });
    observations = {
      ...observations,
      series: normalizedSeries,
      complete:
        (observations as any).complete ?? !(observations as any).truncated,
      total_obs:
        observations.total_obs ??
        normalizedSeries.reduce(
          (acc, cur) => acc + (cur.points?.length ?? 0),
          0,
        ),
    };
  }

  // Normalize resolution trace
  const rawTrace = src.resolution ?? resolved?.trace ?? spec.trace ?? {};
  const resolution: ResolutionTrace = {
    resolved_stat_vars: Array.isArray(rawTrace.resolved_stat_vars)
      ? rawTrace.resolved_stat_vars.map((v: any) =>
          typeof v === "string" ? { dcid: v, label: v } : v,
        )
      : [],
    resolved_entities: Array.isArray(rawTrace.resolved_entities)
      ? rawTrace.resolved_entities.map((e: any) =>
          typeof e === "string" ? { dcid: e, label: e } : e,
        )
      : [],
    resolved_sources: Array.isArray(rawTrace.resolved_sources)
      ? rawTrace.resolved_sources.map((s: any) =>
          typeof s === "string" ? { dcid: s, label: s } : s,
        )
      : [],
    slot_filters: Array.isArray(rawTrace.slot_filters)
      ? rawTrace.slot_filters
      : [],
    pipeline_trace: Array.isArray(rawTrace.pipeline_trace)
      ? rawTrace.pipeline_trace
      : [],
    applied_window: rawTrace.applied_window ?? null,
    requested_window: rawTrace.requested_window ?? null,
    date_source: rawTrace.date_source ?? null,
    n_recalled: rawTrace.n_recalled ?? null,
  };

  const shape: Shape = src.shape ?? {
    shape_id: "",
    label: "",
    population_type: null,
    measured_property: null,
    stat_type: null,
    slot_keys: [],
    member_count: 0,
    refine_supported: false,
  };

  const coverage: Coverage = src.coverage ?? {
    kind: "bare",
    has_data: false,
  };

  return {
    spec_id: spec.spec_id ?? resolved?.spec_id ?? "",
    shape,
    slots: src.slots ?? [],
    stat_vars,
    entities,
    coverage,
    observations,
    slot_options: src.slot_options ?? [],
    entity_options: src.entity_options ?? [],
    inapplicable_slots: src.inapplicable_slots ?? [],
    unresolved_slots: src.unresolved_slots ?? [],
    facet_options: src.facet_options ?? [],
    resolution,
    variable_text: src.variable_text ?? null,
    available_at_place: src.available_at_place ?? null,
    confidence: src.confidence ?? null,
    definition: spec.definition ?? src.definition,
    // Same source as every other resolved field; resolved itself is kept
    // below, for provenance only.
    rendered_sentence: src.rendered_sentence ?? null,
    sentence_plan: src.sentence_plan ?? null,
    resolved: spec.resolved,
  };
}

/**
 * Normalizes one raw wire Part into its typed, discriminated form. Every spec
 * inside it (a definite part's own spec, a candidates part's `candidates.specs`,
 * a no_data part's `nearest_real`/`flagged_match`) goes through normalizeSpec.
 * An unsupported part carries no Spec and passes its payload through as-is.
 */
function normalizePart(part: any): Part {
  const base = {
    variable_text: part.variable_text ?? null,
    warnings: part.warnings ?? [],
    timing_ms: part.timing_ms ?? null,
    rendered_sentence: part.rendered_sentence ?? null,
    sentence_plan: part.sentence_plan ?? null,
    restatement: part.restatement ?? null,
  };

  if (part.status === "candidates") {
    return {
      ...base,
      status: "candidates",
      candidates: {
        ...part.candidates,
        specs: (part.candidates?.specs ?? []).map(normalizeSpec),
      },
    };
  }

  if (part.status === "no_data") {
    return {
      ...base,
      status: "no_data",
      no_data: {
        ...part.no_data,
        nearest_real: part.no_data?.nearest_real?.map(normalizeSpec),
        flagged_match: part.no_data?.flagged_match
          ? normalizeSpec(part.no_data.flagged_match)
          : undefined,
      },
    };
  }

  if (part.status === "unsupported") {
    return { ...base, status: "unsupported", unsupported: part.unsupported };
  }

  // "definite"
  return { ...base, status: "definite", spec: normalizeSpec(part.spec) };
}

/**
 * Normalizes a raw wire ResolveResponse into the typed envelope: every spec
 * nested inside every part goes through normalizeSpec. `parts` is the only
 * source of outcome data; there is no flat top-level shape to fall back to.
 */
export function normalizeResponse(response: any): ResolveResponse {
  if (!response) return response;
  return {
    schema_version: response.schema_version,
    status: response.status,
    query_echo: response.query_echo,
    diagnostics: response.diagnostics,
    parts: (response.parts ?? []).map(normalizePart),
    rendered_sentence: response.rendered_sentence ?? null,
    sentence_plan: response.sentence_plan ?? null,
  };
}
