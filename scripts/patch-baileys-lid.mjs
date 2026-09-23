/**
 * WhatsApp now requires addressing_mode=lid on 1:1 sends to @lid chats.
 * Baileys 6.7.24 sets that for groups only, so new linked numbers accept
 * the send and then drop it. Older phone-number chats are unchanged.
 */
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const file = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "node_modules",
  "@whiskeysockets",
  "baileys",
  "lib",
  "Socket",
  "messages-send.js",
);

const needle = `            else {
                stanza.attrs.to = destinationJid;
            }`;
const patched = `            else {
                stanza.attrs.to = destinationJid;
                if (isLid) stanza.attrs.addressing_mode = 'lid';
            }`;

const src = fs.readFileSync(file, "utf8");
if (src.includes("if (isLid) stanza.attrs.addressing_mode = 'lid'")) {
  console.log("[patch-baileys-lid] already applied");
} else if (!src.includes(needle)) {
  console.error("[patch-baileys-lid] could not find the send stanza — baileys version changed");
  process.exit(1);
} else {
  fs.writeFileSync(file, src.replace(needle, patched));
  console.log("[patch-baileys-lid] applied");
}
