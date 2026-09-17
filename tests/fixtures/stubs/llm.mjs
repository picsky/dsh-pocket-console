/**
 * Stand-in for the harness message constructor the plugin imports when it hands
 * an instruction back to a session.
 *
 * Only the fields the plugin relies on are produced: an id and the echo of what
 * the caller passed. The suite asserts on the echoed source, which is what
 * distinguishes a plugin-sourced instruction from human input.
 */

let counter = 0

/**
 * Build one user message.
 * @param options - the message fields.
 * @param options.content - message content blocks.
 * @param options.source - who produced the message.
 * @returns the constructed message.
 */
export function createUserMessage({ content, source }) {
  counter += 1
  return { id: `msg_stub_${counter}`, role: 'user', content, source }
}
