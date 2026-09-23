/**
 * 1) Keep the old global addressing_mode stanza patch OFF (it dropped PN chats).
 * 2) Let sendMessage forward additionalAttributes so we can set
 *    addressing_mode=lid + recipient_pn only on 1:1 LID sends.
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

if (!fs.existsSync(file)) {
  console.log("[patch-baileys-lid] baileys not installed, skip");
  process.exit(0);
}

let src = fs.readFileSync(file, "utf8");

const badStanza = `            else {
                stanza.attrs.to = destinationJid;
                if (isLid) stanza.attrs.addressing_mode = 'lid';
            }`;
const goodStanza = `            else {
                stanza.attrs.to = destinationJid;
            }`;
if (src.includes(badStanza)) {
  src = src.replace(badStanza, goodStanza);
  console.log("[patch-baileys-lid] reverted global addressing_mode stanza patch");
}

const oldAttrs = `                const additionalAttributes = {};
                const additionalNodes = [];`;
const newAttrs = `                const additionalAttributes = { ...(options.additionalAttributes || {}) };
                const additionalNodes = [];`;
if (src.includes(oldAttrs)) {
  src = src.replace(oldAttrs, newAttrs);
  console.log("[patch-baileys-lid] sendMessage forwards additionalAttributes");
} else if (src.includes(newAttrs)) {
  console.log("[patch-baileys-lid] additionalAttributes forward already applied");
} else {
  console.warn("[patch-baileys-lid] could not find additionalAttributes init to patch");
}

fs.writeFileSync(file, src, "utf8");
