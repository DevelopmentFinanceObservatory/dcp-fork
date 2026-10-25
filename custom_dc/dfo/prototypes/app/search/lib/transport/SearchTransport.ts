/**
 * SearchTransport — the one interface the UI talks to.
 *
 * The durable core never knows where a Spec comes from or how it is hosted. Every
 * surface calls `resolve` (new query, raw_text path) or `resubmitDataset`
 * (every phrase edit AND candidate promotion, dataset_resubmit path: the
 * whole current envelope resubmitted at once) and gets back a
 * ResolveResponse. Swapping the implementation — HttpTransport, an MCP
 * transport later — must not touch UI code.
 *
 * Request-lifecycle policy (timeout, retry/backoff, last-write-wins cancellation,
 * caching by spec_id) lives inside the implementations, not here. This
 * interface stays minimal on purpose.
 */

import type {
  DatasetResubmitEntry,
  PlaceOptionsRequest,
  PlaceOptionsResponse,
  ResolveResponse,
} from "@/lib/contract/types";
import type { SearchEvent } from "@/lib/client/searchClient";

export interface SearchTransport {
  /** New free-text query (raw_text entry path). */
  resolve(query: string, signal?: AbortSignal): Promise<ResolveResponse>;

  /**
   * Optional streaming resolve (raw_text). When present, the store prefers it for
   * a new query so the loading trace reflects real pipeline progress: the engine
   * emits interpretation → shape → sentence → step* → response → done events.
   * Transports that can't stream (fixtures) omit this and the store falls back to
   * buffered `resolve`.
   */
  resolveStream?(
    query: string,
    onEvent: (event: SearchEvent) => void,
    signal?: AbortSignal,
  ): Promise<void>;

  /**
   * Resolve an existing spec_id directly (spec_id entry path).
   */
  resolveSpecId?(
    specId: string,
    signal?: AbortSignal,
  ): Promise<ResolveResponse>;

  /**
   * Optional streaming resolve for an existing spec_id (spec_id entry path).
   */
  resolveSpecIdStream?(
    specId: string,
    onEvent: (event: SearchEvent) => void,
    signal?: AbortSignal,
  ): Promise<void>;

  /**
   * Resubmit every part of the current envelope at once (dataset_resubmit
   * entry path, dfo-apis #593/#606): every edit action -- editSlot, editDonor,
   * chooseSpec (candidate pick), editShared -- builds one `entries` list
   * (lib/contract's buildDatasetEntries) from the current parts and posts it
   * here, getting the full, re-composed N-part envelope back. `rawQuery`
   * echoes the originating typed query, when there was one, for `query_echo`.
   *
   * Optional, like `resolveSpecId`/`placeOptions` above, rather than required
   * like `resolve`: a test double that never exercises an edit action (most
   * component/render tests) doesn't need to stub it. A store that calls an
   * edit action against a transport lacking this surfaces that part's own
   * editError rather than throwing into a render (see specStore's
   * runDataset).
   */
  resubmitDataset?(
    entries: DatasetResubmitEntry[],
    rawQuery: string | undefined,
    signal?: AbortSignal,
  ): Promise<ResolveResponse>;

  /**
   * Optional streaming resubmitDataset. When present, the store prefers it so
   * the edit doesn't wait on the engine's synchronous coverage/observation
   * computation before showing the recomposed envelope: response, then
   * trailing slot_options/entity_options/facet_options/observations by
   * spec_id, then done -- no interpretation event. Transports that can't
   * stream (fixtures) omit this and the store falls back to buffered
   * `resubmitDataset`.
   */
  resubmitDatasetStream?(
    entries: DatasetResubmitEntry[],
    rawQuery: string | undefined,
    onEvent: (event: SearchEvent) => void,
    signal?: AbortSignal,
  ): Promise<void>;

  /**
   * Optional on-demand where-slot alternatives (POST /api/search/place_options).
   * Both shipped transports (Fixture, Http) implement it; optional per this
   * interface's existing resolveStream? precedent, so an ad-hoc test double
   * that never opens the where editor doesn't need to stub it. Lazy: the
   * where editor calls this itself when it opens, never as part of resolve or
   * a dataset edit. A typed 400 (unsupported_peers_anchor_type /
   * unsupported_children_anchor_type) rejects with that code on the thrown
   * Error -- see WhereEditor, which treats it as "hide this scope".
   */
  placeOptions?(
    req: PlaceOptionsRequest,
    signal?: AbortSignal,
  ): Promise<PlaceOptionsResponse>;
}
