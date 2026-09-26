# Troubleshooting

[← All documentation](README.md)

Symptoms in the order you are likely to meet them: installing, first binding, then
cards that arrive or do not.

## Installing

**The first install from GitHub stops on `ERR_PNPM_IGNORED_BUILDS`.**
A git dependency resolves its own dependencies from the registry, so pnpm ≥11 meets
`protobufjs`'s postinstall and refuses to finish until that script is allowed or
declined. The stub pnpm appends is not a decision: set it to `false` in the profile's
`pnpm-workspace.yaml` and re-run. Installing from npm never reaches this, because the
transport arrives bundled.

**pnpm wrote `minimumReleaseAgeExclude` into the profile, or installed the previous version.**
Both are pnpm's supply-chain policy for a version published very recently, not
something this plugin asks for. It holds a fresh version back, resolves an unpinned
spec to the one before it, and records the exclusion that lets the one it did install
through. Name the version to take it right away — `dsh plugin --profile web add
dsh-pocket-console@0.7.6` — and re-add the plain name later if you would rather track
releases automatically. pnpm also caches registry metadata, so a version published
minutes ago can stay invisible until that cache refreshes.

**A `github:` install activates nothing, and a start says
`pocket-console (dsh-pocket-console): failed to import`.**
pnpm resolves no bundled dependency of a git dependency, so `dsh plugin --profile web add
github:picsky/dsh-pocket-console` installs the repository with **no `node_modules` at all** — and
the Feishu transport is one of the packages the published tarball carries inside it. Measured on
0.9.5 against DSH 0.1.7-rc.2: the entry was absent from the composed tree, the specifier that
failed was `qrcode`, and adding the transport to that same profile made the same install
activate. Two ways out. Install the published package — `dsh plugin --profile web add
dsh-pocket-console` — or a locally packed tarball; both carry the transport. Or keep the git
install and give the profile the transport: `dsh plugin --profile web add
@larksuiteoapi/node-sdk qrcode`, then set `protobufjs: false` under `allowBuilds` in the profile's
`pnpm-workspace.yaml` (the entry above is why) and run `dsh plugin --profile web install` again.
Restart `dsh web` afterwards.

**Any start can print that warning, and it carries no detail.**
`failed to import` is the harness's own label for a configured entry that never got a fiber, and
the harness prints nothing with it: a deliberately broken import in this plugin's own copy
produces exactly those two lines and nothing above them, so the terminal has no more to give.
Check the entry rather than the warning: `dsh --profile web --dump-config` should list the
`# == dsh-pocket-console` layer, and the route the card calls should exist —
`http://127.0.0.1:3080/__pocket/state` answering `401` means the plugin is up, and a bare `404`
means it is not loaded at all. A tree whose install is complete activates on every fresh start, so
restart `dsh web` after the package manager changes a profile; if the warning survives that,
report it with the profile's `package.json` and the output of `dsh plugin --profile web install`.

**The page stops at "Failed to load plugins" and nothing opens at all.**
That page is the web shell refusing to start, not a card that failed: it requires every
plugin it loaded to reach the active state, and an entry whose required Cordis service
is missing waits forever. The parentheses name the service. This plugin was that entry
on DSH 0.1.7, which renamed the browser settings service the card was bound to
(`settingsScope` → `configForms`) and moved the host's editable fields off
`settings.installSection` and onto the entry's own volatile `Config`; versions up to
0.9.2 required the old names, so one renamed service took the whole interface down.
The fix asks for the settings transport by capability and waits for it, so a service the
Host does not provide costs the card and never the page; see the changelog for the
release that carries it. Note that 0.9.3 stopped the boot failure and still registered no
card: it read the service once, before 0.1.7's settings provider had applied. 0.9.4 is
the version whose card actually appears.
To get back in on an affected version, remove the plugin
(`dsh plugin --profile web remove dsh-pocket-console`) and upgrade.

**The Settings card does not appear.**
The card is keyed on the settings namespace the Host serves. Check the plugin loaded
(`dsh --profile web --dump-config` should list a `# == dsh-pocket-console` layer), then
reload the page — the served namespace list re-reads on a document commit or a
reconnect, not on registration. On DSH 0.1.7 and later there is no Settings card at
all: the same card is in the sidebar's **Plugins** page, listed under that page's
*Official* group with the pages the installation ships (the page renders every
registered settings page there; the profile's own bundles are the *Installed* group
below). The page's console says `pocket-console: settings card mounted on plugins.item`
when the card mounted. If that line is missing, the settings service never reached the
plugin: versions before 0.9.4 read it once, too early, and registered nothing.

## Binding

**"Scan to create an app" fails, or no QR code appears.**
The one-click flow needs to reach `open.feishu.cn`. If the host is behind a proxy, make
sure that host is reachable.

**A card action answers 404, or the card says the host is running an older version.**
The page and the process serving it are replaced separately: after `dsh plugin … add`,
the page can already be the new one while `dsh web` still runs the old code, and a route
the card needs is then missing. Restart `dsh web` — reloading the page does not update
the host — and reload the page afterwards.

**"Could not verify these credentials", or a reason naming the App ID or App Secret.**
The plugin asked the platform with exactly the pair you entered and it refused, so the
app id or the secret does not match a live app. Copy both again from the developer
console (the secret is shown once; regenerate it if it was not saved), and remember
that a rejected pair is deliberately not kept. If the message says the platform gave no
clear answer instead, the host cannot reach `open.feishu.cn`.

**The QR code appeared but scanning does not finish.**
The link is valid for 10 minutes and can be used once. Click **Unbind**, then **Scan to
create an app** again for a fresh one. Your Feishu account must be able to create apps
in its organization; on a personal account with no organization, create a free
organization first and invite yourself.

**The card is stuck at "Connecting to Feishu…".**
The handshake is still trying. Past 30 seconds the card says the wait is unusual. If it
never settles, the host cannot reach `open.feishu.cn`, or the pair is wrong — **Unbind**
and bind again, using **Use an existing app** if you have a pair you know works.

**A direct message did not bind this deployment.**
Binding happens from a direct message to an unbound deployment. A group message never
binds, and a deployment that already has a recipient ignores other accounts — that is
deliberate, because the recipient is what decides where approval cards go and whose
presses count ([ADR 0006](decisions/0006-binding-is-not-up-for-grabs.md)). To change a
bound recipient: **Use another app**, or **Unbind** and send a new direct message.

## Cards that do not arrive, or do nothing

**The connection logs `ws client ready` but buttons do nothing.**
Feishu's older "message card callback" is not available over the long connection — only
the newer `card.action.trigger`. Make sure the app subscribes to `card.action.trigger`;
the one-click flow does this for you.

**A button answers with 该请求已处理或过期.**
The click carried no live request: the desktop answered that request first, or it was
cancelled — a decision rewrites the card, so its buttons should have gone with it.
Releases before 0.1.0 read card actions from the wrong envelope field and produced this
toast for every click; upgrade if that is the version in the profile.

**Approvals never reach the phone.**
Check what the card reports. **Bound** with **Connection: established** means delivery is
live and the problem is elsewhere (`delaySeconds`, or an unbound recipient — send the bot
a message). **Connection: dropped** means the long connection is reconnecting and only
the desktop can answer meanwhile; the channel is deliberately not treated as reachable
then, so a request stays with the desktop instead of waiting on a card that cannot
return. **Failed** carries the platform's reason for the credentials.

## Questions about the setup itself

**Is it safe to run alongside another Feishu bot?**
Only if it is a **different app**. Feishu delivers long-connection events to one client
at random, so two tools sharing one app silently drop each other's callbacks. Create a
new app.

**Does it work with the Auto review preset?**
Not for approvals. Under Auto review, `approval/policy` is `never` and tool approvals no
longer pass through `approval/request`, so there is nothing to escalate. Question
escalation still works.

**Why did nothing arrive even though the session finished?**
A result notice needs `resultNotify: idle` and `delaySeconds` of quiet, and a turn that
either produced an *answer* (a message that speaks without calling a tool) or stopped
short — an error or the output ceiling — which is offered whatever it ended on. It is
suppressed while the session is still working, during `resultNotifyCooldownSeconds` after
the previous notice for that session, for delegated sessions, and for a session the host
has already reclaimed.
