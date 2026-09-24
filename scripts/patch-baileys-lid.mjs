/**
 * Baileys 6.7.x needed this revert of addressing_mode=lid on 1:1 sends.
 * Baileys 7 only sets addressing_mode on groups — leave it alone.
 */
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const pkgPath = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "node_modules",
  "@whiskeysockets",
  "baileys",
  "package.json",
);

if (!fs.existsSync(pkgPath)) {
  console.log("[patch-baileys-lid] baileys not installed, skip");
  process.exit(0);
}

const ver = JSON.parse(fs.readFileSync(pkgPath, "utf8")).version || "";
if (String(ver).startsWith("7.")) {
  console.log(`[patch-baileys-lid] skip (baileys ${ver})`);
  process.exit(0);
}

const file = path.join(path.dirname(pkgPath), "lib", "Socket", "messages-send.js");
const patched = `            else {
                stanza.attrs.to = destinationJid;
                if (isLid) stanza.attrs.addressing_mode = 'lid';
            }`;
const original = `            else {
                stanza.attrs.to = destinationJid;
            }`;

if (!fs.existsSync(file)) {
  console.log("[patch-baileys-lid] messages-send.js missing, skip");
  process.exit(0);
}

const src = fs.readFileSync(file, "utf8");
if (!src.includes("if (isLid) stanza.attrs.addressing_mode = 'lid'")) {
  console.log("[patch-baileys-lid] nothing to revert");
} else {
  fs.writeFileSync(file, src.replace(patched, original));
  console.log("[patch-baileys-lid] reverted");
}
