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
