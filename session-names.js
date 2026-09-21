/**
 * What each session is called, as the small line under a card's title.
 *
 * A card's title says what the card *is* and which project it belongs to — and a project with two
 * sessions running in it produces two identical titles, which is exactly the thing a person holding
 * a phone cannot tell apart. The session's own name is the one property that separates them.
 *
 * **Nothing here invents a name.** The harness already gives every session a title: it appends a
 * `session/title` event when the first human message arrives, when a generator produces one, and when
 * somebody renames the session, newest wins — and it guarantees that title never reaches model input.
 * This module only listens for that event and remembers it, which is why it needs no service, no
 * permission, and no configuration.
 *
 * **Read from the firehose**, because the plugin already watches that stream for everything else and
 * the title arrives on it — and, when a session's title event predates this process (every session
 * that existed before a restart), **read once from the harness's title service** the first time a card
 * asks. Without that second source, "the card says which session it is" would quietly stop being true
 * for every existing session after every restart.
 *
 * @module pocket-console/session-names
 */

import { sessionName } from './identity.js'

/**
 * How many sessions' names are remembered before the coldest is forgotten.
 *
 * A name is a session id and a short string, and a deployment that stays up for weeks will see a lot
 * of sessions. Bounded and least-recently-used, the same discipline the workspace registry and the
 * activity records use: the session nobody has looked at for longest is the one to forget.
 */
const CAPACITY = 256

/**
 * Create the session-name registry.
 * @param options - the copy table in force, for the line a card shows.
 * @returns following the title events, and the line a card shows for one session.
 */
export function createSessionNames({ ctx, messages, log, diagnostics = () => {} }) {
  /** One name per session, oldest key forgotten first. */
  const names = new Map()

  /**
   * Remember one name, oldest key forgotten first.
   *
   * Re-inserted so the first key is the coldest one — but only while there is room to move it: at the
   * cap, moving a key that is already last would first remove it and then find no room to put it back,
   * which is how a live name would be lost for good.
   *
   * Both ways of learning a name go through here, so a name read from the harness is remembered
   * exactly like one that arrived on the firehose — and both say so out loud, which is the only way
   * "why has this card no small line" is answerable from outside.
   * @param session - the session id.
   * @param name - the normalized name.
   */
  const remember = (session, name) => {
    if (names.size < CAPACITY) names.delete(session)
    else if (!names.has(session)) names.delete(names.keys().next().value)
    names.set(session, name)
    log?.debug?.(messages().logSessionNamed(session, name))
    diagnostics?.(`会话名：${session} → ${name}`)
  }

  /**
   * Read one session's folded title, for a session whose `session/title` event this process never saw.
   *
   * An event is the live truth and this is only a starting point, which is why it runs **only when
   * nothing is remembered**: a title that later arrives on the firehose — including a rename —
   * overwrites whatever was read here. Without it, every session that was already named when this
   * process started would keep a nameless card for the rest of the deployment's life.
   *
   * The title service is optional and read through `get`, so a deployment that does not mount it
   * simply never learns a name this way: no small line, and no failure either.
   * @param session - the session id.
   * @returns the name, or undefined when nothing can be read.
   */
  const learn = (session) => {
    const live = ctx?.get?.('agents')?.get?.(session)?.session
    if (live === undefined) return undefined
    return sessionName(ctx?.get?.('sessionTitle')?.get?.(live)?.title)
  }

  return {
    /**
     * Follow one session event.
     *
     * Only `session/title` carries a name, and only the newest one counts: the harness supersedes an
     * older title when a generator finishes or a person renames the session, and the newest name is
     * the one a reader would recognize. A title that is empty after normalization is not a name and
     * does not replace one.
     * @param session - the session, as the firehose reports it.
     * @param event - the committed event.
     */
    observe(session, event) {
      if (event?.type !== 'session/title') return
      const id = session?.id
      if (id === undefined) return
      const name = sessionName(event.data?.title)
      if (name === undefined) return
      remember(id, name)
    },
    /**
     * The name of one session, as a card's small line, or undefined when there is none to show.
     *
     * Undefined is the whole of the fallback: no title seen means no small line, and the card is
     * rendered the way it was before this feature existed. The line is composed here rather than at
     * each card so that every card spells it the same way, in the deployment's own language.
     * @param session - the session id the card belongs to.
     * @returns the line, or undefined.
     */
    subtitle(session) {
      let name = names.get(session)
      // Nothing remembered means nothing has been heard about this session in *this* process, which is
      // the ordinary state of every session that already existed when the deployment started. Read it
      // once, and only once: from then on the firehose — including a rename — is the only thing that
      // can change it.
      if (name === undefined) {
        name = learn(session)
        if (name !== undefined) remember(session, name)
      }
      return name === undefined ? undefined : messages().sessionLine(name)
    },
    /**
     * How many names are held, for the suite.
     * @returns the number of remembered sessions.
     */
    tracked: () => names.size,
  }
}
