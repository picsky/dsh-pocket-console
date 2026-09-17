/**
 * The browser half's own routes.
 *
 * The browser half cannot call a Host Remote method: that surface is generated
 * and the forwarded-event allowlist is host-owned. It uses routes on the GUI's
 * own server instead — same-origin, so the browser's session cookie already
 * applies and no token of our own is needed.
 *
 * The routes carry what the card needs: the binding, the open requests, and the
 * decision the desktop should mirror. That is not public, so every request goes
 * through the connection's trust fence first, and a deployment without a fence
 * falls back to the same-origin check every mutating call already carries.
 *
 * @module pocket-console/routes
 */

import QRCode from 'qrcode'

/** Same-origin route prefix the browser half calls; it never crosses the `/api` fence. */
const ROUTE_PREFIX = '/__pocket'

/**
 * Serve the browser half's routes on the webserver that serves the GUI.
 *
 * The browser half cannot call a Host Remote method: that surface is generated
 * and the forwarded-event allowlist is host-owned. It uses routes on the GUI's
 * own server instead — same-origin, so the browser's session cookie already
 * applies and no token of our own is needed.
 *
 * The routes carry what the card needs: the binding, the open requests, and the
 * decision the desktop should mirror. That is not public, so every request goes
 * through the connection's trust fence first, and a deployment without a fence
 * falls back to the same-origin check every mutating call already carries.
 *
 * @param webServer - the route-registration carrier.
 * @param snapshot - thunk returning the current state for the card.
 * @param actions - mutating operations the card may request.
 * @param trust - the connection's request fence, when the deployment has one.
 * @returns the disposer removing the route.
 */
export function registerRoutes(webServer, snapshot, actions, trust = () => undefined) {
  const json = (res, status, body) => {
    const payload = JSON.stringify(body)
    res.writeHead(status, {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
      'content-length': Buffer.byteLength(payload),
    })
    res.end(payload)
  }

  /** Bound a request body so a malformed caller cannot grow it without limit. */
  const readBody = async (req) => {
    const chunks = []
    let size = 0
    for await (const chunk of req) {
      size += chunk.length
      if (size > 64 * 1024) throw new Error('body too large')
      chunks.push(chunk)
    }
    if (size === 0) return {}
    return JSON.parse(Buffer.concat(chunks).toString('utf8'))
  }

  /** Reject a cross-site mutation; a browser sends `Origin` on every POST. */
  const sameOrigin = (req) => {
    const origin = req.headers.origin
    if (origin === undefined) return true
    const host = req.headers.host
    if (host === undefined) return false
    try {
      return new URL(origin).host === host
    } catch {
      return false
    }
  }

  return webServer.register({
    kind: 'prefix',
    path: ROUTE_PREFIX,
    handler: async (req, res) => {
      const path = new URL(req.url ?? '/', 'http://x').pathname.slice(ROUTE_PREFIX.length)
      const method = req.method ?? 'GET'
      try {
        // The connection owns browser authority; ask it before reading anything.
        const rejection = trust(req)
        if (rejection !== undefined) {
          json(res, rejection, { error: rejection === 401 ? 'unauthorized' : 'forbidden' })
          return
        }
        if (path === '/state' && method === 'GET') {
          json(res, 200, await snapshot())
          return
        }
        if (path === '/qr.svg' && method === 'GET') {
          // The host renders the code because a browser half shipped without a
          // build step cannot inline a QR encoder; the card only needs an <img>.
          const { enrollment } = await snapshot()
          const url = enrollment?.verifyUrl
          if (typeof url !== 'string') {
            res.writeHead(404)
            res.end()
            return
          }
          const svg = await QRCode.toString(url, { type: 'svg', margin: 1, width: 240 })
          res.writeHead(200, {
            'content-type': 'image/svg+xml',
            'cache-control': 'no-store',
            'content-length': Buffer.byteLength(svg),
          })
          res.end(svg)
          return
        }
        if (method !== 'POST') {
          json(res, 405, { error: 'method not allowed' })
          return
        }
        if (!sameOrigin(req)) {
          json(res, 403, { error: 'cross-origin request refused' })
          return
        }
        if (path === '/bind') {
          await readBody(req)
          json(res, 200, await actions.begin())
          return
        }
        if (path === '/unbind') {
          await readBody(req)
          json(res, 200, await actions.clear())
          return
        }
        if (path === '/mirror' && typeof actions.mirror === 'function') {
          json(res, 200, await actions.mirror(await readBody(req)))
          return
        }
        json(res, 404, { error: 'unknown route' })
      } catch (error) {
        json(res, 500, { error: error instanceof Error ? error.message : String(error) })
      }
    },
  })
}
