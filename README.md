# velo-bridge-baileys

Experimental **parallel** WhatsApp bridge using [Baileys](https://github.com/WhiskeySockets/Baileys) instead of `whatsapp-web.js`. No Chromium — connects via a raw WebSocket, which means far lower RAM per session (roughly 10-20x lighter). On a 4GB VPS this should support 40-50 sessions vs the 5-6 the Puppeteer-based bridge can handle.

**This is not the production bridge.** The original `velo-bridge` (whatsapp-web.js) is untouched and keeps serving your live clients while this one is tested.

## API compatibility

This bridge exposes the **exact same HTTP API** as `velo-bridge`:

- `GET /health`
- `POST /session/create` — `{ shop_id, phone_number? }`
- `GET /session/:shopId/status`
- `DELETE /session/:shopId`
- `GET /session/all`
- `POST /message/send-text` — `{ shop_id, phone_number, message }`
- `POST /message/send-image` — `{ shop_id, phone_number, image_url, caption? }`
- `POST /message/send-audio` — `{ shop_id, phone_number, audio_url?, audio_base64?, mimetype? }`
- `POST /message/edit` — `{ shop_id, phone_number, wa_message_id, new_text }`
- `POST /message/delete` — `{ shop_id, phone_number, wa_message_id }`

Because the shape is identical, the frontend needs **zero code changes** to switch — only an env variable.

## Setup on the VPS (parallel to the existing bridge)

```bash
cd ~
git clone <this-repo-url> velo-bridge-baileys
cd velo-bridge-baileys
npm install
cp .env.example .env
nano .env   # fill in real values, use PORT=3002 (different from velo-bridge's 3001)
npm run build
pm2 start dist/index.js --name velo-bridge-baileys
pm2 save
```

Both bridges now run side by side: `velo-bridge` on 3001, `velo-bridge-baileys` on 3002.

Open the firewall port if needed:
```bash
sudo ufw allow 3002/tcp
```

## Testing before switching any real client

1. Confirm health: `curl http://localhost:3002/health`
2. In the frontend, temporarily point a **test business** at this port by setting `BAILEYS_BRIDGE_URL=http://<vps-ip>:3002` in a separate env/deploy, or test directly against the bridge with curl.
3. Verify on a spare/test WhatsApp number:
   - [ ] QR scan connects
   - [ ] Phone number pairing code connects
   - [ ] Inbound text messages arrive and trigger the bot
   - [ ] Inbound voice notes are received, uploaded, and transcribed by the bot
   - [ ] Inbound photos are received and handled by the bot
   - [ ] Outbound text sends
   - [ ] Outbound images send
   - [ ] Outbound voice notes send
   - [ ] Message edit works
   - [ ] Message delete works
   - [ ] Session survives a VPS reboot (`pm2 restart`) without re-scanning QR
   - [ ] Session count under load (open several test sessions, watch VPS `free -h` memory usage)

## Cutover (once fully verified)

This is the **entire migration** — one env var, no code changes:

```bash
# In Vercel (or wherever the frontend env lives):
BAILEYS_BRIDGE_URL=http://<vps-ip>:3002
BAILEYS_BRIDGE_SECRET=<matches this bridge's BRIDGE_SECRET>
```

Redeploy the frontend. Done.

## Rollback (if anything is wrong)

Just as fast — point the env var back:

```bash
BAILEYS_BRIDGE_URL=http://<vps-ip>:3001
BAILEYS_BRIDGE_SECRET=<matches the old velo-bridge's BRIDGE_SECRET>
```

Redeploy. The old `velo-bridge` (whatsapp-web.js) was never stopped or modified, so it's still fully functional and serving from its saved sessions.

## Important operational notes

- **Node.js >= 20 required** — Baileys 6.7.24 needs this. Check the VPS Node version with `node -v` before deploying. If it's older, install Node 20 via nvm alongside the existing version; don't upgrade the system Node in place since the old bridge may depend on the current version.
- **ESM only** — this package uses `"type": "module"` and `.js` extensions in imports (required by NodeNext module resolution). Don't mix in CommonJS `require()`.
- **Session storage differs from velo-bridge.** Baileys uses `useMultiFileAuthState`, storing creds under `sessions/<shopId>/`. This is a different auth format than whatsapp-web.js's LocalAuth — sessions are NOT transferable between the two bridges. Each business must re-scan/re-pair once when moved to this bridge.
- **Reconnect behavior**: Baileys does not auto-reconnect. This bridge implements its own reconnect-on-drop logic (see `onConnectionUpdate` in `sessionManager.ts`), reconnecting after a brief delay unless the disconnect reason is `loggedOut`, in which case the session is cleared and requires a fresh QR/pairing.
- **Version pin**: uses `@whiskeysockets/baileys@6.7.24` (the `legacy` dist-tag, patched against the known message-spoofing advisory). The `7.0.0-rc*` line has breaking changes and is not yet stable — do not upgrade to it without a deliberate review.
