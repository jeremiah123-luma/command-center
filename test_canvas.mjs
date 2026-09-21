import { getCanvas, shortCode } from "./src/worker.js";
const mem = new Map();
const env = {
  CANVAS_BASE: "https://njit.instructure.com",
  CANVAS_TOKEN: process.env.CANVAS_TOKEN,
  STATE: { get: async (k, t) => { const v = mem.get(k); return v == null ? null : (t === "json" ? JSON.parse(v) : v); }, put: async (k, v) => mem.set(k, v), delete: async k => mem.delete(k) },
};
console.log("shortCode:", ["FA26-PHYS111A021","FA26-CS100-MC","FA26-FYSSEMY23","FA26-MATH112011"].map(c => shortCode(c, "")).join(" | "));
const t0 = Date.now();
const snap = await getCanvas(env, true);
console.log("ok:", snap.ok, "| items:", snap.items.length, "| counts:", JSON.stringify(snap.counts), "| ms:", Date.now() - t0, snap.error || "");
for (const x of snap.items.filter(i => !i.submitted).slice(0, 5)) console.log("  ", x.course, "|", x.title.slice(0, 42), "|", x.dueAt, "|", x.points, "|", x.id);
const t1 = Date.now(); const again = await getCanvas(env, false); console.log("cached read ms:", Date.now() - t1, "| same updatedAt:", again.updatedAt === snap.updatedAt);
