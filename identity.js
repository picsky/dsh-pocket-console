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

/** Characters of a workspace name a title keeps before it is clipped. */
const WORKSPACE_LIMIT = 40

/**
 * Keep the first `limit` characters of a name, counting characters rather than code units.
 *
 * `String.prototype.slice` counts UTF-16 code units, so a limit landing between the halves
 * of a surrogate pair returns half a character — which then goes into the card as a lone
 * `\uD83D` and renders as a broken glyph. Walking the string yields whole code points.
 * @param name - the directory name.
 * @param limit - how many characters to keep.
 * @returns the name, clipped if it was longer.
 */
function clipName(name, limit) {
  let kept = ''
  let count = 0
  for (const character of name) {
    if (count === limit) break
    kept += character
    count += 1
  }
  return kept
}

/**
 * What a card title calls one session's workspace.
 *
 * The name only; a session without one, or with one that names nothing (a filesystem
 * root), is left unnamed rather than labelled with something invented for it.
 *
 * Both separators are honoured on every platform, and deliberately: the Host can run on
 * either, and a session's `cwd` arrives in the spelling of the machine that created it.
 * `path.basename` is platform-bound — on POSIX a backslash is an ordinary filename
 * character — so a workspace reached through a Windows-shaped path would be named by its
 * whole path on one platform and by its last segment on the other. For a label a person
 * reads, the name is the name wherever the Host happens to be running.
 * @param cwd - the session's absolute working directory, as its header carries it.
 * @returns the label, or undefined when there is nothing to show.
 */
export function workspaceLabel(cwd) {
  if (typeof cwd !== 'string') return undefined
  const path = cwd.trim()
  if (path === '') return undefined
  const segments = path.replaceAll('\\', '/').split('/').filter(segment => segment !== '' && segment !== '.')
  // A filesystem root has no final segment; a drive on its own is a root, not a name;
  // and a reference to a parent directory names nothing this session is. None of the
  // three is something to put on a card.
  const name = segments.at(-1)
  if (name === undefined || name === '..' || /^[A-Za-z]:$/.test(name)) return undefined
  return clipName(name, WORKSPACE_LIMIT)
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

/**
 * A session's name, as a card can put it in one line.
 *
 * The harness normalizes a session title before committing it (one terminal-safe line, capped in
 * bytes by configuration), so this is **not** a second normalization and deliberately not a clip: a
 * name that is too long for the small line is the platform's business, and it truncates it there
 * where the width is actually known. What is left here is the one guarantee a card needs and an
 * event cannot make — that what reaches a card title is a single line — plus the rule that nothing
 * to show means no line at all rather than an empty one.
 * @param title - the title text, as the session log carries it.
 * @returns the name, or undefined when there is nothing to show.
 */
export function sessionName(title) {
  if (typeof title !== 'string') return undefined
  const name = title.replace(/\s+/gu, ' ').trim()
  return name === '' ? undefined : name
}
