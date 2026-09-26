/**
 * Local stand-in for `qrcode`. The real package encodes a QR matrix; the route
 * only needs to prove it produced an SVG of the expected type, so this echoes
 * the payload into a minimal document.
 */

/**
 * Make the next render fail, so a case can watch the route degrade rather than only
 * watch it succeed. The route promises that a broken encoder costs one image and one
 * warning instead of the whole card, and a promise nobody has watched hold is a promise
 * that quietly stopped being true.
 */
export const refuse = { next: false }

export default {
  /**
   * Render text as an SVG document.
   * @param text - payload to encode.
   * @param options - encoding options; `width` is echoed as the viewBox.
   * @returns the SVG document.
   * @throws when a case asked the next render to fail.
   */
  async toString(text, options = {}) {
    if (refuse.next) {
      refuse.next = false
      throw new Error('qrcode: the encoder is unavailable')
    }
    const size = options.width ?? 240
    return `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 ${size} ${size}"><desc>${text}</desc></svg>`
  },
}
