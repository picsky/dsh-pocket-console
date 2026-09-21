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
 * the title arrives on it. A session whose title event predates this process simply has no name here,
 * and its cards render exactly as they did before this module existed — the property that makes the
 * whole feature safe to add.
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
export function createSessionNames({ messages, log, diagnostics = () => {} }) {
  /** One name per session, oldest key forgotten first. */
  const names = new Map()

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
      // Re-inserted so the first key is the coldest one — but only while there is room to move it:
      // at the cap, moving a key that is already last would first remove it and then find no room to
      // put it back, which is how a live name would be lost for good.
      if (names.size < CAPACITY) names.delete(id)
      else if (!names.has(id)) names.delete(names.keys().next().value)
      names.set(id, name)
      log?.debug?.(messages().logSessionNamed(id, name))
      // Said out loud for the same reason every other silent decision is: a card with no small line
      // and a card whose session was never named look identical on the phone, and this is the only
      // place that knows which of the two happened — or that the name changed under a live card.
      diagnostics?.(`会话名：${id} → ${name}`)
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
      const name = names.get(session)
      return name === undefined ? undefined : messages().sessionLine(name)
    },
    /**
     * How many names are held, for the suite.
     * @returns the number of remembered sessions.
     */
    tracked: () => names.size,
  }
}
