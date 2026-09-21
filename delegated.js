/**
 * Which sessions this plugin stays out of: the ones a session delegated work to.
 *
 * A subagent is a session of its own — its own log, its own turns, its own events — and the firehose
 * does not say which sessions a person started and which one a run asked for. Two things followed
 * from that, both measured on a real deployment, and both of them wrong for the phone:
 *
 * - A delegate's prompt arrives as `{ kind: 'user' }`, the same shape a person's own message has, so
 *   the result notifier took it for a conversation somebody was having and sent a card when the
 *   delegate's turn ended. The guard was written — `results.js` says "a delegated one is reported
 *   through the session that asked for it" — but its test was `source.kind === 'user'`, which the
 *   delegate's prompt passes exactly.
 * - A delegate's `turn/start` built an activity record like any other session's, so the moment the
 *   phone took the person over, `onPriority` minted a card for every delegate the registry still
 *   reported as running: several cards, in the same millisecond, and every one of them rings.
 *
 * One instruction that fans out to a handful of subagents therefore put several cards on the phone,
 * all of them describing the same execution. The person's own session is where that run belongs: its
 * card already reports what the run is doing, and the delegate's own card is a message nobody asked
 * for — from a session nobody can see, under a name taken from its prompt.
 *
 * The signal is the session's creation header, which the store always supplies and deep-freezes.
 * `origin` is a declared header field whose only accepted value is `"subagent"` — the harness refuses
 * any other value, so the test cannot be fooled by a string that merely looks like one. It is read
 * rather than remembered, which is why nothing here depends on having seen the session start:
 * `results.js` already reads `session.header.cwd` for the same reason.
 *
 * `parentSession` is deliberately **not** the test. A fork carries one too, and a fork is a
 * conversation a person is having — it belongs on the phone exactly like the session it came from.
 *
 * @module pocket-console/delegated
 */

/** The one origin the harness writes for a session a run delegated to. */
export const DELEGATED_ORIGIN = 'subagent'

/**
 * Whether this session was delegated to rather than started by a person.
 *
 * Anything without a header — a bare `{ id }`, or a session the store built without one — is not
 * delegated, and that direction is the safe one: an unknown session keeps its card.
 * @param session - a session, as the firehose and the agent registry report it.
 * @returns whether a run handed work to this session instead of a person starting it.
 */
export function isDelegated(session) {
  return session?.header?.origin === DELEGATED_ORIGIN
}
