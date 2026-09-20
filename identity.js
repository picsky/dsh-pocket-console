/**
 * Whose card this is, in the one part of a card a reader sees without opening it.
 *
 * Two cards that need an answer at the same time are otherwise indistinguishable: the
 * title carried the prefix and the kind and nothing else, so a reader running a plan
 * across several sessions had to guess which card belonged to which. The workspace is
 * the label because it is what a person recognizes — the session that is running in
 * `my-app` is "the my-app one" to whoever is looking at it.
 *
 * The value is derived once, when the card is built, and carried on the record that
 * owns the card. A card is rewritten several times in its life — settled, superseded,
 * retracted — and re-reading the workspace at each of those moments would make the
 * name vanish from a rewrite whenever the session happened to have been reclaimed
 * since. What the card says about itself stays what it said when it was sent.
 *
 * @module pocket-console/identity
 */

import { basename } from 'node:path'

/** Characters of a workspace name a title keeps before it is clipped. */
const WORKSPACE_LIMIT = 40

/**
 * What a card title calls one session's workspace.
 *
 * The name only; a session without one, or with one that names nothing (a filesystem
 * root), is left unnamed rather than labelled with something invented for it.
 * @param cwd - the session's absolute working directory, as its header carries it.
 * @returns the label, or undefined when there is nothing to show.
 */
export function workspaceLabel(cwd) {
  if (typeof cwd !== 'string') return undefined
  const path = cwd.trim()
  if (path === '') return undefined
  // Cross-platform on purpose: the Host can be started on either, and `cwd` arrives
  // in that platform's spelling. A root has no trailing name, and is nothing to show.
  const name = basename(path)
  if (name === '' || name === path) return undefined
  return name.length <= WORKSPACE_LIMIT ? name : name.slice(0, WORKSPACE_LIMIT)
}

/**
 * A card title: what the card is, and the workspace it belongs to.
 *
 * The kind is passed in already spelled out rather than assembled here, because the
 * two halves come from different places — the kind is card copy, the workspace is
 * session data — and this function's whole job is the join between them. A label that
 * names nothing is treated as no label at all, so every title in the plugin goes
 * through this one function and no rewrite path can be the one that forgot.
 * @param base - the title so far: the deployment's prefix and what the card is.
 * @param label - a workspace label, when the session has one.
 * @returns the title both halves make.
 */
export function titleOf(base, label) {
  if (typeof label !== 'string') return base
  const name = label.trim()
  return name === '' ? base : `${base} · ${name}`
}
