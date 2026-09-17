/**
 * Local stand-in for `qrcode`. The real package encodes a QR matrix; the route
 * only needs to prove it produced an SVG of the expected type, so this echoes
 * the payload into a minimal document.
 */
export default {
  /**
   * Render text as an SVG document.
   * @param text - payload to encode.
   * @param options - encoding options; `width` is echoed as the viewBox.
   * @returns the SVG document.
   */
  async toString(text, options = {}) {
    const size = options.width ?? 240
    return `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 ${size} ${size}"><desc>${text}</desc></svg>`
  },
}
