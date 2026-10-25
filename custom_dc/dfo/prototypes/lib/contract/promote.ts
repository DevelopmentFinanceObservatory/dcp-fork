/**
 * Promote fields and identity-edit helpers for a `dataset_resubmit` entry's
 * `identity` kind (also fed into a `candidates` entry's own candidate
 * identities — see `DatasetCandidateEntry`).
 *
 * Contract v1: a resubmit posts `identity` — the complete edited
 * `BaseIdentity` — plus `base_spec_id`/`base_identity` (the prior spec being
 * edited, verified by hash) and, for a standard shape, `resolved_stat_var_dcids`
 * (graph state, never hashed into spec_id, so it rides as a sibling of
 * `identity` rather than a member). `extra="forbid"` on the wire rejects any
 * top-level `shape`/`slots`/`donor_dcid`/`entity_dcids`/`requested_window`
 * field outside `identity`. Where/when/source are not identity slots:
 * `where` lives in `identity.entities` (keyed `observationAbout`/`origin`/
 * `destination`), `when` in `identity.requested_window`, `source` in
 * `identity.facets.provenance`.
 *
 * `removed` acknowledges a facet axis or entity role dropped ENTIRELY from
 * the base (never a slot — every shape-declared slot key is always present
 * in `identity.slots`, so a slot's own `unbound` state is its own removal
 * signal). Every edit path here starts from `spec.definition.identity` —
 * which is always posted verbatim as `base_identity` too (see
 * `promoteFromSpec`) — so "dropped from the base" and "dropped from this
 * edit's own starting point" are the same check.
 */

import type {
  BaseIdentity,
  Binding,
  IdentityBinding,
  IdentityFacetBinding,
  IdentityWindow,
  RemovedParts,
  Slot,
  SlotValue,
  Spec,
} from "./types";

export interface PromoteFields {
  /**
   * The base's own resolved StatVar dcid(s). Required by the engine's
   * standard (promote-only) path; harmless (ignored) on a named-family
   * resubmit, which reconstructs its own SV(s) from `identity.slots`
   * bindings instead. Sent whenever the spec has resolved StatVars,
   * independent of shape.refine_supported.
   */
  resolved_stat_var_dcids?: string[];
  /** the prior spec's own id, when it carries a hashed identity */
  base_spec_id?: string;
  /** the prior spec's own identity, verified by hash against base_spec_id */
  base_identity?: BaseIdentity;
  /** every facet axis / entity role dropped entirely from the base */
  removed?: RemovedParts;
}

/** Derive the promote fields for a dataset_resubmit `identity` entry of
 *  `spec`: the sibling fields that ride alongside `identity`, not inside it.
 *  base_spec_id/base_identity attach whenever the spec carries a hashed
 *  identity (definition.identity) — verified by hash server-side against
 *  whatever identity is actually posted. */
export function promoteFromSpec(spec: Spec): PromoteFields {
  const out: PromoteFields = {};

  const baseIdentity = spec.definition?.identity;
  if (spec.spec_id && baseIdentity) {
    out.base_spec_id = spec.spec_id;
    out.base_identity = baseIdentity;
  }

  const svs = (spec.resolution?.resolved_stat_vars ?? [])
    .map((r) => r?.dcid)
    .filter(Boolean);
  if (svs.length) out.resolved_stat_var_dcids = svs;

  return out;
}

// ---------------------------------------------------------------------------
// Resolved-binding -> identity-binding adapters
// ---------------------------------------------------------------------------
// The page's slot editors build a binding in the engine's RESOLVED wire shape
// (`{kind:'unbound'}` / `{kind:'value', value:{ref, value_kind}}` —
// Spec.slots[i].binding), because that's what slot_options entries and the
// currently-bound value carry. The identity core's own binding shape is
// `{state, ref}` (bare dcid), not `{kind, value:{ref:{dcid,label}}}` — these
// adapters bridge the two without asking the editors to know about the
// identity wire shape at all.

/** The bound dcid a resolved binding carries, or null when it binds nothing
 *  (unbound/absent, or a shape this adapter doesn't recognise). */
function resolvedBindingDcid(binding: unknown): string | null {
  const b = binding as { kind?: string; value?: SlotValue } | null | undefined;
  if (!b || b.kind === "unbound" || b.kind === "absent") return null;
  return b.value?.ref?.dcid ?? null;
}

/** Convert a resolved what/how slot binding to its identity-slot form. Every
 *  shape-declared slot is dense (always present, `unbound` if nothing is
 *  bound), so — unlike facets/entities — there is no "drop" case here. A
 *  resolved `absent` binding (the constraint property isn't on the resolved
 *  SVs) has no identity-core equivalent and also maps to `unbound`. */
export function toIdentitySlotBinding(binding: unknown): IdentityBinding {
  const dcid = resolvedBindingDcid(binding);
  return dcid ? { state: "value", ref: dcid } : { state: "unbound" };
}

/** Convert a resolved binding to a facet binding, or null when it should be
 *  dropped from the sparse `facets` map entirely (the facet union has no
 *  `unbound` state — an unconstrained axis is simply absent). */
function toIdentityFacetBinding(binding: unknown): IdentityFacetBinding | null {
  const dcid = resolvedBindingDcid(binding);
  return dcid ? { state: "value", ref: dcid } : null;
}

/** Convert a resolved when-slot binding to its identity `requested_window`.
 *  Unbound (or unrecognised) means no date constraint (`{kind:"all"}`); a
 *  bound time_window carries start/end years; a literal "latest" value
 *  re-affirms an explicit latest-ask. */
export function toIdentityWindow(binding: unknown): IdentityWindow {
  const b = binding as { kind?: string; value?: SlotValue } | null | undefined;
  if (!b || b.kind === "unbound" || b.kind === "absent") return { kind: "all" };
  const v = b.value;
  if (v?.value_kind === "literal" && v.literal === "latest") {
    return { kind: "latest" };
  }
  if (v?.value_kind === "time_window") {
    const tw = v.time_window;
    return tw
      ? { kind: "range", start_year: tw.start_year, end_year: tw.end_year }
      : { kind: "all" };
  }
  return { kind: "all" };
}

// ---------------------------------------------------------------------------
// Identity-edit helpers: each returns the next identity plus any `removed`
// accounting the edit requires (identity_edit.check_edit_incomplete refuses
// 422 if a base-bound facet axis / entity role arrives neither re-sent nor
// named in `removed`).
// ---------------------------------------------------------------------------

export interface IdentityEdit {
  identity: BaseIdentity;
  removed?: RemovedParts;
}

/** Replace one what/how slot's binding, matched by property dcid. Every
 *  other slot rides through untouched, so shape-declared completeness
 *  (identity_edit.check_slots_declared) is preserved for free. */
export function withSlotBinding(
  identity: BaseIdentity,
  property: string | null | undefined,
  binding: IdentityBinding,
): BaseIdentity {
  if (!property) return identity;
  return {
    ...identity,
    slots: identity.slots.map((slot) =>
      slot.property === property ? { ...slot, binding } : slot,
    ),
  };
}

/** Bind or drop one entity role (`observationAbout`/`origin`/`destination`).
 *  `dcids` null/empty drops the role entirely; dropping a role the base had
 *  bound is acknowledged in `removed.entities`, since a role absent from
 *  `identity.entities` reads as "not asked about" rather than "unbound". */
export function withEntityEdit(
  identity: BaseIdentity,
  role: string,
  dcids: string[] | null,
): IdentityEdit {
  const entities = { ...identity.entities };
  const hadRole = role in entities;
  const bound = Boolean(dcids && dcids.length > 0);

  if (bound) {
    entities[role] = dcids as string[];
  } else {
    delete entities[role];
  }

  return {
    identity: { ...identity, entities },
    removed: !bound && hadRole ? { entities: [role] } : undefined,
  };
}

/** Bind or drop one facet axis (e.g. `provenance` for the source picker).
 *  `binding` null drops the axis from the sparse map; dropping an axis the
 *  base had bound is acknowledged in `removed.facets`. */
export function withFacetEdit(
  identity: BaseIdentity,
  axis: string,
  binding: IdentityFacetBinding | null,
): IdentityEdit {
  const facets = { ...(identity.facets ?? {}) };
  const hadAxis = axis in facets;

  if (binding) {
    facets[axis] = binding;
  } else {
    delete facets[axis];
  }

  return {
    identity: {
      ...identity,
      facets: Object.keys(facets).length ? facets : undefined,
    },
    removed: !binding && hadAxis ? { facets: [axis] } : undefined,
  };
}

/** Which entity role the where-axis slot binds for `identity`: `destination`
 *  for a directional-flow shape that already carries one (the recipient side
 *  — the donor rides `origin` via editDonor instead), else the plain subject
 *  role `observationAbout`. */
export function whereEntityRole(identity: BaseIdentity): string {
  return "destination" in identity.entities
    ? "destination"
    : "observationAbout";
}

/**
 * Route one resolved-slot edit (editSlot's `(spec, slotIndex, binding)`) to
 * the right member of `spec.definition.identity`: what/how slots by property
 * dcid, `where` to the entity role, `when` to `requested_window`, `source` to
 * `facets.provenance`. Throws if the spec carries no identity to edit against
 * — callers are expected to guard on `spec.definition?.identity` first.
 */
export function withResolvedSlotEdit(
  spec: Spec,
  slotIndex: number,
  binding: Binding | unknown,
): IdentityEdit {
  const identity = spec.definition?.identity;
  if (!identity) {
    throw new Error("withResolvedSlotEdit: spec has no identity to edit");
  }
  const slot = spec.slots?.[slotIndex] as Slot | undefined;
  const axis = slot?.key.axis;

  if (axis === "where") {
    const dcid = resolvedBindingDcid(binding);
    return withEntityEdit(
      identity,
      whereEntityRole(identity),
      dcid ? [dcid] : null,
    );
  }
  if (axis === "when") {
    return {
      identity: { ...identity, requested_window: toIdentityWindow(binding) },
    };
  }
  if (axis === "source") {
    return withFacetEdit(
      identity,
      "provenance",
      toIdentityFacetBinding(binding),
    );
  }
  return {
    identity: withSlotBinding(
      identity,
      slot?.key.property?.dcid,
      toIdentitySlotBinding(binding),
    ),
  };
}
