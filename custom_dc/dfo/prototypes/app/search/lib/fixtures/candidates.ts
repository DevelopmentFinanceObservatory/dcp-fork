/**
 * candidates — "aid to Africa".
 * Ambiguous: 2..N competing Specs, broadest first. Picking one promotes it to a
 * definite (via dataset_resubmit). The two candidates here differ in their `what`
 * binding (all flows vs ODA grants) and carry different coverage treatments.
 */

import type {
  CandidateSet,
  ResolveResponse,
  SlotKey,
  Spec,
} from "@/lib/contract/types";
import { CURRENT_SCHEMA_VERSION } from "@/lib/contract/version";
import { ref, echo, diagnostics, warn } from "./_common";

const SHAPE_ID = "shape/development_finance_flows";

const whatKey: SlotKey = {
  axis: "what",
  property: ref("flowType", "flow type"),
  label: "flow",
};
const whereKey: SlotKey = { axis: "where", property: null, label: "recipient" };
const sourceKey: SlotKey = { axis: "source", property: null, label: "source" };

const africa = ref("africa", "Africa");

const slotKeys = [whatKey, whereKey, sourceKey];

function trace(svRefs: ReturnType<typeof ref>[]) {
  return {
    resolved_stat_vars: svRefs,
    resolved_entities: [africa],
    resolved_sources: [ref("dc/base/OECD_CRS", "OECD CRS")],
    slot_filters: [
      { key: whereKey, binding_kind: "value" as const, refs: [africa] },
      { key: sourceKey, binding_kind: "unbound" as const, refs: [] },
    ],
    pipeline_trace: [
      { step: "extract" as const, ran: true, ms: 14 },
      { step: "recall" as const, ran: true, ms: 39 },
      { step: "shape" as const, ran: true, ms: 6 },
      { step: "bind" as const, ran: true, ms: 21 },
      { step: "materialise" as const, ran: true, ms: 44 },
      { step: "answer" as const, ran: true, ms: 3 },
    ],
  };
}

/** Broadest first: all development-finance flows to Africa. */
const broadSpec: Spec = {
  spec_id: "spec_cand_all_flows_africa",
  shape: {
    shape_id: SHAPE_ID,
    label: "development finance flows",
    population_type: ref("DevelopmentFinance", "development finance"),
    measured_property: ref(
      "DevelopmentFinanceFlow",
      "development finance flow",
    ),
    stat_type: ref("measuredValue", "measured value"),
    slot_keys: slotKeys,
    member_count: 412,
    refine_supported: true,
  },
  slots: [
    { key: whatKey, binding: { kind: "unbound" } },
    {
      key: whereKey,
      binding: { kind: "value", value: { value_kind: "entity", ref: africa } },
    },
    { key: sourceKey, binding: { kind: "unbound" } },
  ],
  stat_vars: [
    {
      ref: ref("ONE/CRS_DAC/AllFlows-AFR", "All flows (Africa)"),
      shape_id: SHAPE_ID,
      slot_values: [],
    },
  ],
  entities: [
    {
      ref: africa,
      entity_type: ref("ContinentalUnion", "Continent"),
      role: { kind: "subject" },
    },
  ],
  coverage: {
    kind: "breadth",
    has_data: true,
    dimensions: [
      { label: "flow types", count: 11 },
      { label: "donors", count: 36 },
      { label: "years", count: 22 },
    ],
  },
  resolution: trace([ref("ONE/CRS_DAC/AllFlows-AFR", "All flows (Africa)")]),
};

/** Narrower: ODA grants to Africa. */
const narrowSpec: Spec = {
  spec_id: "spec_cand_oda_grants_africa",
  shape: { ...broadSpec.shape },
  slots: [
    {
      key: whatKey,
      binding: {
        kind: "value",
        value: {
          value_kind: "enum_value",
          ref: ref("ODAGrants", "ODA grants"),
        },
      },
    },
    {
      key: whereKey,
      binding: { kind: "value", value: { value_kind: "entity", ref: africa } },
    },
    { key: sourceKey, binding: { kind: "unbound" } },
  ],
  stat_vars: [
    {
      ref: ref("ONE/CRS_DAC/ODAGrants-AFR", "ODA grants (Africa)"),
      shape_id: SHAPE_ID,
      slot_values: [
        {
          key: whatKey,
          value: {
            value_kind: "enum_value",
            ref: ref("ODAGrants", "ODA grants"),
          },
        },
      ],
    },
  ],
  entities: [
    {
      ref: africa,
      entity_type: ref("ContinentalUnion", "Continent"),
      role: { kind: "subject" },
    },
  ],
  coverage: {
    kind: "breadth",
    has_data: true,
    dimensions: [
      { label: "donors", count: 30 },
      { label: "years", count: 22 },
    ],
  },
  resolution: trace([ref("ONE/CRS_DAC/ODAGrants-AFR", "ODA grants (Africa)")]),
};

export const candidateSet: CandidateSet = {
  ordering: "broadest_first",
  max_candidates: 2,
  specs: [broadSpec, narrowSpec],
};

export const candidates: ResolveResponse = {
  schema_version: CURRENT_SCHEMA_VERSION,
  status: "candidates",
  query_echo: echo({
    raw_query: "aid to Africa",
    normalized_query: "aid to Africa",
    variable_text: ["aid"],
  }),
  diagnostics: diagnostics({ warnings: [warn("ambiguous flow type")] }),
  parts: [
    {
      status: "candidates",
      variable_text: "aid",
      warnings: [],
      timing_ms: null,
      rendered_sentence: null,
      sentence_plan: null,
      candidates: candidateSet,
    },
  ],
};
