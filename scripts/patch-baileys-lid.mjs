/**
 * Undo the LID addressing_mode edit. That attribute made WhatsApp show a
 * typing bubble and then drop the message for every shop.
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

const patched = `            else {
                stanza.attrs.to = destinationJid;
                if (isLid) stanza.attrs.addressing_mode = 'lid';
            }`;
const original = `            else {
                stanza.attrs.to = destinationJid;
            }`;

if (!fs.existsSync(file)) {
  console.log("[patch-baileys-lid] baileys not installed, skip");
  process.exit(0);
}

const src = fs.readFileSync(file, "utf8");
if (!src.includes("if (isLid) stanza.attrs.addressing_mode = 'lid'")) {
  console.log("[patch-baileys-lid] nothing to revert");
} else {
  fs.writeFileSync(file, src.replace(patched, original));
  console.log("[patch-baileys-lid] reverted");
}
