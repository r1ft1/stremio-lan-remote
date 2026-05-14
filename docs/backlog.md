# Backlog

Future work intentionally deferred from v1. Items here are not bugs in the v1 design — they're scoped-out features that should ship in a v2+ if the project sees real use.

## Security: prevent public-internet exposure of the LAN port

**Problem.** The addon binds `0.0.0.0:7000` so the phone can reach it across the LAN. If a user runs this on a Deck connected to a mobile hotspot, a public Wi-Fi, or a misconfigured network with port forwarding, anyone on the internet could hit `/cast?id=...` and force the Deck to play arbitrary content (or DoS it).

**Requirements.**
- The addon must refuse to serve `/cast` (and ideally `/manifest.json` and `/stream/...`) unless the request originates from a private network the user has approved.
- Detection must not require the user to manually configure subnets.
- The check must happen on every request — startup-only checks miss network changes.

**Implementation options (pick during v2 design):**
1. **Source-IP allowlist by RFC1918 default.** On each request, check the remote address against `10.0.0.0/8`, `172.16.0.0/12`, `192.168.0.0/16`, and `fc00::/7`. Reject otherwise with 403. Cheap, defaults work for 95% of home networks, fails open only if someone has a public-IP LAN (unusual).
2. **Same-subnet check.** Look up the server's own interface addresses and accept only requests whose source IP shares a subnet with one of them. Stricter than option 1 but breaks on VPNs and complex routing.
3. **Bound interface explicitly.** Force `BIND` to a specific non-`0.0.0.0` interface IP at install time. Removes the multi-interface ambiguity. Combine with option 1 for defense in depth.
4. **Public-routability self-test at startup.** Resolve the bind interface's external IP via STUN; if the bind IP equals the public IP, refuse to start. Catches the "Deck on hotspot" case loudly.

**Recommended for v2:** option 1 + option 3 together. Option 4 as a warning-only check.

**Out of scope here:** TLS, authentication tokens — those belong in the multi-device pairing item below.

---

## Multi-device controller pairing

**Problem.** Today any phone on the LAN that knows the manifest URL becomes a controller. Two issues: (1) no authentication means a guest on your Wi-Fi can hijack the Deck; (2) no concept of "registered devices" means we can't show the user which phones are paired or revoke access.

**Requirements.**
- Multiple phones can be registered as controllers of the same Deck.
- Pairing requires explicit confirmation on the Deck side (so casual LAN guests can't self-add).
- The Deck owner can list and revoke paired devices.
- Phones authenticate every command with a per-device token.

**Sketch of a pairing flow.**
1. Phone hits `POST /pair` with a self-generated device ID + nickname (e.g. "James's iPhone").
2. Addon writes a pending pairing to disk and emits a notification into the Stremio shell's UI ("Pair this device? Code: 4271") via the existing dispatch channel.
3. User confirms on the Deck (or via a `confirm-pairing.sh` CLI if the in-Stremio UI is too invasive). Confirmation issues a token tied to the device ID.
4. Phone stores the token. Every subsequent `/cast` (and other) request includes `Authorization: Bearer <token>`. Unauthenticated requests get 401.
5. `/pairings` endpoint, only callable from confirmed devices, lists registered phones. `/pairings/<id> DELETE` revokes.

**Storage.** A flat JSON file in `~/.local/share/stremio-lan-remote/pairings.json`. No DB needed.

**Combines with the security item above.** Even with RFC1918 enforcement, a guest on the LAN should still need explicit pairing to cast.

**UI question deferred:** how does the user confirm pairing on the Deck? In-Stremio dialog requires a deeper hook than v1 has; a CLI tool (`stremio-lan-remote pair --confirm 4271`) is the minimum viable path.

---

## Other deferred items (placeholders)

- HTTPS / TLS for the LAN listener (matters if pairing tokens become long-lived)
- mDNS advertisement so phones auto-discover the Deck instead of typing an IP
- Show current Deck playback state on the phone (requires reverse channel — addon polls shell's `getState`)
- Multi-Deck support from one phone (pick which Deck to cast to)
- Resume playback / "next episode" handoff (companion listens for end-of-file from the player, dispatches the next item)
- Replace the placeholder MP4 response with a "Casting to Deck" branded overlay (visually communicative, not silent black frame)
- After Player Load dispatch, also send Player::PausedChanged(paused: false) to skip the "click to play" Stremio logo state

## Install-friction architecture (v1.1 deployment paths)

v1 requires Tailscale on every device. Tested findings:

- **Stremio mobile v2 (Play Store) stripped the addon-install UI.** Custom addons can only be installed via account sync from web.stremio.com.
- **web.stremio.com is HTTPS, so it mixed-content-blocks plain HTTP addon URLs.** A real HTTPS endpoint is required for the manifest fetch.
- **`stremio://...` URL scheme is registered on mobile v2 but does not trigger install** (only opens the app, presumably because the UI code path was removed in the rewrite). QR pairing via this scheme is *not* viable for v2 mobile users.
- **After install, Stremio mobile fetches addon endpoints natively (not via browser JS), so plain HTTP works fine post-install.** The HTTPS requirement is purely for the install fetch.

Viable v1.1 deployment options to drop the Tailscale requirement:

### Option A: Cloudflare Worker hosting the manifest
- Free tier (100k req/day) hosts a JS function generating per-user manifests
- URL pattern: `https://lanremote.example.workers.dev/<base64-deck-host>/manifest.json`
- Manifest's stream entries point at the user's local Deck: `http://<deck-host>:7000/cast?...`
- User flow: visit static configurator page → enter Deck hostname → get personalized install URL → install via web.stremio.com → syncs to mobile
- Trade-off: depends on Cloudflare uptime; per-user Deck hostname leaked to our worker logs (but stripped of personal data)

### Option B: Stremio v1 APK only
- Document that mobile users must sideload Stremio v1 APK from stremio.com (not Play Store)
- v1 has the full addon UI, accepts plain HTTP install URLs
- QR pairing via `stremio://` scheme works on v1
- Trade-off: sideloading friction; v1 lacks newer Stremio features

### Option C: GitHub Pages user-fork model
- User forks the project, edits a config file with their Deck hostname, GH Actions builds a personalized manifest, deploys to their `username.github.io/lan-remote/`
- No central infrastructure
- Trade-off: every user needs a GitHub account and to perform a fork + edit + wait-for-CI before using the addon

Recommended path: **Option A (Cloudflare Worker)** for lowest user friction. Implementation is ~30 LOC of TS. Option B as documented fallback for users who refuse to depend on Cloudflare.
