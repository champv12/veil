import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
const forbidden = /@veil\/(?:api|bridge|identity|key-broker|object-store)|\b(?:workos|supabase|postgres|aws-sdk|@aws-sdk)\b/i;
for (const file of await walk("packages")) { if (/\.[cm]?[jt]sx?$/.test(file) && forbidden.test(await readFile(file, "utf8"))) throw new Error(`Cloud dependency in Core: ${file}`); }
async function walk(root) { const out=[]; for (const name of await readdir(root,{withFileTypes:true})) { const file=path.join(root,name.name); if (name.isDirectory()) out.push(...await walk(file)); else out.push(file); } return out; }
