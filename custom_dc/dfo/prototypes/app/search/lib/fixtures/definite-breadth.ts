/**
 * definite × breadth — "malaria grants to Ethiopia since 2015".
 * One variable spanning many donor-year cells. From contract Example 1.
 */

import type { Spec, ResolveResponse, SlotKey } from "@/lib/contract/types";
import { ref, echo, definite } from "./_common";

const SHAPE_ID = "shape/development_finance_flows";

const whatKey: SlotKey = {
  axis: "what",
  property: ref("flowType", "flow type"),
  label: "flow",
};
const howKey: SlotKey = {
  axis: "how",
  property: ref("purpose", "purpose"),
  label: "purpose",
};
const channelKey: SlotKey = {
  axis: "how",
  property: ref("channel", "channel"),
  label: "channel",
};
const whereKey: SlotKey = { axis: "where", property: null, label: "recipient" };
const whenKey: SlotKey = { axis: "when", property: null, label: "time" };
const sourceKey: SlotKey = { axis: "source", property: null, label: "source" };

export const definiteBreadthSpec: Spec = {
  spec_id: "spec_def_breadth_malaria_eth_2015",
  shape: {
    shape_id: SHAPE_ID,
    label: "development finance flows",
    population_type: ref("DevelopmentFinance", "development finance"),
    measured_property: ref(
      "DevelopmentFinanceFlow",
      "development finance flow",
    ),
    stat_type: ref("measuredValue", "measured value"),
    slot_keys: [whatKey, howKey, channelKey, whereKey, whenKey, sourceKey],
    member_count: 412,
    refine_supported: true,
  },
  // The hashed identity core a dataset_resubmit edit posts against (contract v1).
  // what/how slots only (where/when/source live in
  // entities/requested_window/facets, not identity.slots); a resolved
  // 'absent' binding (channel) has no identity-core equivalent, so it maps
  // to 'unbound' like any other unconstrained what/how slot.
  definition: {
    identity: {
      identity_version: "spec1",
      shape: {
        kind: "statvar_schema",
        population_type: "DevelopmentFinance",
        measured_property: "DevelopmentFinanceFlow",
        stat_type: "measuredValue",
      },
      slots: [
        { property: "flowType", binding: { state: "value", ref: "ODAGrants" } },
        {
          property: "purpose",
          binding: { state: "value", ref: "MalariaControl" },
        },
        { property: "channel", binding: { state: "unbound" } },
      ],
      // Directional-flow shape: the where-slot binds the recipient, so it
      // lives at entities.destination (the donor rides entities.origin,
      // set only via editDonor -- this fixture's base spec has none bound).
      entities: { destination: ["country/ETH"] },
      requested_window: { kind: "range", start_year: 2015 },
    },
  },
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
      key: howKey,
      binding: {
        kind: "value",
        value: {
          value_kind: "enum_value",
          ref: ref("MalariaControl", "malaria control"),
        },
      },
    },
    {
      key: whereKey,
      binding: {
        kind: "value",
        value: { value_kind: "entity", ref: ref("country/ETH", "Ethiopia") },
      },
    },
    {
      key: whenKey,
      binding: {
        kind: "value",
        value: { value_kind: "time_window", time_window: { start_year: 2015 } },
      },
    },
    { key: channelKey, binding: { kind: "absent" } },
    { key: sourceKey, binding: { kind: "unbound" } },
  ],
  stat_vars: [
    {
      ref: ref(
        "ONE/CRS_DAC/Malariacontrol-ODAGrants-ETH",
        "Malaria control ODA grants (Ethiopia)",
      ),
      shape_id: SHAPE_ID,
      slot_values: [
        {
          key: whatKey,
          value: {
            value_kind: "enum_value",
            ref: ref("ODAGrants", "ODA grants"),
          },
        },
        {
          key: howKey,
          value: {
            value_kind: "enum_value",
            ref: ref("MalariaControl", "malaria control"),
          },
        },
      ],
    },
  ],
  entities: [
    {
      ref: ref("country/ETH", "Ethiopia"),
      entity_type: ref("Country", "Country"),
      role: {
        kind: "directional",
        role: ref("recipient", "recipient"),
        direction: "to",
      },
    },
  ],
  coverage: {
    kind: "breadth",
    has_data: true,
    dimensions: [
      { label: "donors", count: 36 },
      { label: "years", count: 9 },
      { label: "methods", count: 3 },
    ],
    window: { start_year: 2015, end_year: 2023 },
  },
  resolution: {
    resolved_stat_vars: [
      ref(
        "ONE/CRS_DAC/Malariacontrol-ODAGrants-ETH",
        "Malaria control ODA grants (Ethiopia)",
      ),
    ],
    resolved_entities: [ref("country/ETH", "Ethiopia")],
    resolved_sources: [ref("dc/base/OECD_CRS", "OECD CRS")],
    slot_filters: [
      {
        key: whatKey,
        binding_kind: "value",
        refs: [ref("ODAGrants", "ODA grants")],
      },
      {
        key: howKey,
        binding_kind: "value",
        refs: [ref("MalariaControl", "malaria control")],
      },
      {
        key: whereKey,
        binding_kind: "value",
        refs: [ref("country/ETH", "Ethiopia")],
      },
      { key: sourceKey, binding_kind: "unbound", refs: [] },
    ],
    applied_window: { start_year: 2015 },
    date_source: "query",
    pipeline_trace: [
      { step: "extract", ran: true, ms: 18 },
      { step: "recall", ran: true, ms: 42 },
      { step: "shape", ran: true, ms: 7 },
      { step: "bind", ran: true, ms: 25 },
      { step: "materialise", ran: true, ms: 61 },
      { step: "answer", ran: true, ms: 3 },
    ],
  },
  // Dev-finance bilateral shape: the observation series is keyed by the DONOR
  // (country/USA), which is NOT one of Spec.entities -- the recipient
  // (Ethiopia) is baked into the StatVar dcid instead. entity_label carries
  // the donor's display name since nothing else in this Spec names it.
  // Truncated preview (complete: false): 5 of 270 total observations ship.
  observations: {
    series: [
      {
        stat_var_dcid: "ONE/CRS_DAC/Malariacontrol-ODAGrants-ETH",
        entity_dcid: "country/USA",
        entity_label: "United States",
        points: [
          { date: "2020", value: 18_200_000 },
          { date: "2021", value: 19_800_000 },
          { date: "2022", value: 21_400_000 },
          { date: "2023", value: 23_100_000 },
          { date: "2024", value: 24_607_887.18 },
        ],
        source_refs: [ref("dc/base/OECD_CRS", "OECD CRS")],
      },
    ],
    total_obs: 270,
    complete: false,
  },
};

export const definiteBreadth: ResolveResponse = definite(
  definiteBreadthSpec,
  echo({
    raw_query: "malaria grants to Ethiopia since 2015",
    normalized_query: "malaria control ODA grants to Ethiopia from 2015",
    variable_text: ["malaria control ODA grants"],
  }),
);
