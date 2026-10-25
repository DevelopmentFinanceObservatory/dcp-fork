/**
 * definite × exact — "women in Kenya".
 * A single resolved series with a counted observation footprint. From contract
 * Example 2. Demographic axes the query did not mention bind `absent`.
 */

import type { Spec, ResolveResponse, SlotKey } from "@/lib/contract/types";
import { ref, echo, definite } from "./_common";

const SHAPE_ID = "shape/person_count";

const genderKey: SlotKey = {
  axis: "how",
  property: ref("gender", "gender"),
  label: "gender",
};
const ageKey: SlotKey = {
  axis: "how",
  property: ref("age", "age"),
  label: "age",
};
const whereKey: SlotKey = { axis: "where", property: null, label: "place" };

export const definiteExactSpec: Spec = {
  spec_id: "spec_def_exact_women_kenya",
  shape: {
    shape_id: SHAPE_ID,
    label: "person count",
    population_type: ref("Person", "person"),
    measured_property: ref("count", "count"),
    stat_type: ref("measuredValue", "measured value"),
    slot_keys: [genderKey, ageKey, whereKey],
    member_count: 25,
    refine_supported: true,
  },
  // The hashed identity core a dataset_resubmit edit posts against (contract v1).
  // Subject-only shape: the where-slot binds the plain
  // subject, so it lives at entities.observationAbout. A resolved 'absent'
  // binding (age) has no identity-core equivalent and maps to 'unbound'.
  definition: {
    identity: {
      identity_version: "spec1",
      shape: {
        kind: "statvar_schema",
        population_type: "Person",
        measured_property: "count",
        stat_type: "measuredValue",
      },
      slots: [
        { property: "gender", binding: { state: "value", ref: "Female" } },
        { property: "age", binding: { state: "unbound" } },
      ],
      entities: { observationAbout: ["country/KEN"] },
      requested_window: { kind: "all" },
    },
  },
  slots: [
    {
      key: genderKey,
      binding: {
        kind: "value",
        value: { value_kind: "enum_value", ref: ref("Female", "female") },
      },
    },
    { key: ageKey, binding: { kind: "absent" } },
    {
      key: whereKey,
      binding: {
        kind: "value",
        value: { value_kind: "entity", ref: ref("country/KEN", "Kenya") },
      },
    },
  ],
  stat_vars: [
    {
      ref: ref("Count_Person_Female", "Count of female persons"),
      shape_id: SHAPE_ID,
      slot_values: [
        {
          key: genderKey,
          value: { value_kind: "enum_value", ref: ref("Female", "female") },
        },
      ],
    },
  ],
  entities: [
    {
      ref: ref("country/KEN", "Kenya"),
      entity_type: ref("Country", "Country"),
      role: { kind: "subject" },
    },
  ],
  coverage: {
    kind: "exact",
    has_data: true,
    observation_count: 14,
    window: { start_year: 2000, end_year: 2023 },
  },
  resolution: {
    resolved_stat_vars: [ref("Count_Person_Female", "Count of female persons")],
    resolved_entities: [ref("country/KEN", "Kenya")],
    resolved_sources: [
      ref("dc/base/WorldDevelopmentIndicators", "World Development Indicators"),
    ],
    slot_filters: [
      {
        key: genderKey,
        binding_kind: "value",
        refs: [ref("Female", "female")],
      },
      { key: ageKey, binding_kind: "absent", refs: [] },
      {
        key: whereKey,
        binding_kind: "value",
        refs: [ref("country/KEN", "Kenya")],
      },
    ],
    pipeline_trace: [
      { step: "extract", ran: true, ms: 15 },
      { step: "recall", ran: true, ms: 31 },
      { step: "shape", ran: true, ms: 6 },
      { step: "bind", ran: true, ms: 19 },
      { step: "materialise", ran: true, ms: 22 },
      { step: "answer", ran: true, ms: 2 },
    ],
  },
  // Truncated preview: coverage says 14 observations (2000-2023), but only the
  // latest 5 ship (complete: false) — points are the newest end of the series,
  // per SpecObservations' "latest points only" contract, not an even sample.
  observations: {
    series: [
      {
        stat_var_dcid: "Count_Person_Female",
        entity_dcid: "country/KEN",
        points: [
          { date: "2019", value: 26_000_000 },
          { date: "2020", value: 26_500_000 },
          { date: "2021", value: 27_100_000 },
          { date: "2022", value: 27_700_000 },
          { date: "2023", value: 28_300_000 },
        ],
        source_refs: [
          ref(
            "dc/base/WorldDevelopmentIndicators",
            "World Development Indicators",
          ),
        ],
      },
    ],
    total_obs: 14,
    complete: false,
  },
};

export const definiteExact: ResolveResponse = definite(
  definiteExactSpec,
  echo({
    raw_query: "women in Kenya",
    normalized_query: "female persons in Kenya",
    variable_text: ["female persons"],
  }),
);
