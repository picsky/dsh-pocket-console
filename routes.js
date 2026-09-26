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

/** Same-origin route prefix the browser half calls; it never crosses the `/api` fence. */
const ROUTE_PREFIX = '/__pocket'

/** Bytes of request body one route accepts before refusing it. */
const MAX_BODY_BYTES = 64 * 1024

/**
 * Serve the browser half's routes on the webserver that serves the GUI.
 *
 * @param webServer - the route-registration carrier.
 * @param snapshot - thunk returning the current state for the card.
 * @param actions - mutating operations the card may request.
 * @param trust - the connection's request fence, when the deployment has one.
 * @param log - the deployment's logger, when the routes have one. A missing encoder is
 *   worth one warning: the card's `<img>` shows nothing and the reason appears nowhere else.
 * @returns the disposer removing the route.
 */
export function registerRoutes(webServer, snapshot, actions, trust = () => undefined, log = undefined) {
  /**
   * The QR encoder, resolved the first time a code is asked for.
   *
   * It belongs to the *published tarball*, not to this module's import graph, and that
   * difference is load-bearing: `package.json` declares it in `bundleDependencies`, and
   * pnpm resolves no bundled dependency of a git dependency — a `github:` install lands
   * the repository with no `node_modules` at all. A static import here therefore spends
   * the whole entry: the harness reports `failed to import` and says nothing else, so the
   * plugin is gone rather than one image. Importing it inside the route that needs it
   * keeps that failure where it belongs.
   * @returns the encoder module.
   */
  let encoder
  const qrEncoder = async () => {
    encoder ??= await import('qrcode')
    return encoder.default ?? encoder
  }

  /** Whether the missing-encoder warning was already written for this registration. */
  let warned = false
  const json = (res, status, body) => {
    const payload = JSON.stringify(body)
    res.writeHead(status, {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
      'content-length': Buffer.byteLength(payload),
    })
    res.end(payload)
  }

  /**
   * Read a JSON request body, distinguishing a bad request from a broken server.
   *
   * A body that is too large or not JSON is the caller's mistake and belongs in the
   * 400 family: reporting it as 500 tells the reader the plugin failed when it did
   * not, and buries a genuine server fault among ordinary client errors.
   * @param req - the incoming request.
   * @returns the parsed body, an empty object when there is none.
   * @throws a `status`-tagged error when the body is unusable.
   */
  const readBody = async (req) => {
    const chunks = []
    let size = 0
    for await (const chunk of req) {
      size += chunk.length
      if (size > MAX_BODY_BYTES) throw badRequest('body too large')
      chunks.push(chunk)
    }
    if (size === 0) return {}
    try {
      return JSON.parse(Buffer.concat(chunks).toString('utf8'))
    } catch {
      throw badRequest('body is not JSON')
    }
  }

  /** An error the route reports as a client mistake rather than a server fault. */
  const badRequest = (message) => Object.assign(new Error(message), { status: 400 })

  /**
   * Reject a cross-site mutation; a browser sends `Origin` on every POST.
   *
   * A missing `Origin` is accepted on purpose: a same-origin request from a page that
   * is not a browser (a health probe, a script on the host) carries none, and the
   * routes are inside the connection's trust fence wherever a deployment has one. The
   * check exists to stop a *cross-site* write, which always carries the attacker's
   * `Origin`.
   * @param req - the incoming request.
   * @returns whether the request may mutate.
   */
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
          let svg
          try {
            const QRCode = await qrEncoder()
            svg = await QRCode.toString(url, { type: 'svg', margin: 1, width: 240 })
          } catch (error) {
            // One image is missing, not the plugin. The card still binds by credentials, so an
            // encoder that cannot be loaded *or* cannot render is an unavailable resource and
            // the deployment's log carries the reason — once, because a card reloads its image
            // on every render.
            if (!warned) {
              warned = true
              log?.warn?.(
                'the QR encoder (qrcode) is unavailable, so the enrollment card shows no code;'
                + ' install the published package, or add qrcode to this profile',
                error,
              )
            }
            json(res, 503, { error: 'the QR encoder (qrcode) is unavailable' })
            return
          }
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
        if (path === '/adopt') {
          const body = await readBody(req)
          const { appId, appSecret } = body ?? {}
          // Both are needed to name an app, and a half-filled form says so
          // instead of failing deeper in the connection.
          if (typeof appId !== 'string' || appId.trim() === ''
            || typeof appSecret !== 'string' || appSecret.trim() === '') {
            json(res, 400, { error: 'an app id and an app secret are both required' })
            return
          }
          json(res, 200, await actions.adopt({ appId, appSecret }))
          return
        }
        if (path === '/mirror' && typeof actions.mirror === 'function') {
          json(res, 200, await actions.mirror(await readBody(req)))
          return
        }
        json(res, 404, { error: 'unknown route' })
      } catch (error) {
        // A body the caller got wrong is reported as their mistake; anything else is
        // a server fault. Collapsing both into 500 made an oversized or malformed
        // body look like a broken plugin.
        const status = typeof error?.status === 'number' ? error.status : 500
        json(res, status, { error: error instanceof Error ? error.message : String(error) })
      }
    },
  })
}
