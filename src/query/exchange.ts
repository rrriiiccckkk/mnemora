import { createHash } from "node:crypto";
import type { GraphologyStore } from "../store.js";
import { isCanonicalId } from "./canonical-id.js";
import { normalizeScope } from "../scope.js";

const MAX_BYTES = 10 * 1024 * 1024;
const MAX_RECORDS = 1000;
const lossyOmissions = ["digest_audit_state", "embeddings", "local_source_paths", "observation_payload_bodies", "observation_quote_bodies", "query_audit_state"] as const;
const jsonlOmissions = ["credentials", "embeddings", "local_source_paths", "provider_state", "query_audit_state", "digest_audit_state"];
type Format = "jsonl" | "csv" | "graphml";
export interface KgExportOptions { format: Format; maxBytes?: number; maxRecords?: number }
export interface KgExportResult { format: Format; data: string; record_count: number; truncated: false; omissions: string[] }
export interface KgImportError { line: number; category: string; message: string }
export interface KgImportPreview { counts: { total: number; valid: number; node: number; edge: number; observation: number; redirect: number }; duplicates: Array<{ kind: string; line: number }>; conflicts: Array<{ kind: string; category: string; line: number }>; errors: KgImportError[]; payload_hash: string; graph_revision: number; preview_hash: string }
export interface KgImportConfirmInput { previewHash: string; input: string | Uint8Array; confirm: boolean }
export interface KgImportResult { imported: { total: number; node: number; edge: number; observation: number; redirect: number }; graph_revision: number }
export interface KgImportLimits { maxBytes?: number; maxRecords?: number }

type Rec = { format_version: 1 | 2; kind: "node" | "edge" | "observation" | "redirect"; [key: string]: unknown };
type Located = { record: Rec; line: number };
type Parsed = { records: Located[]; preview: KgImportPreview };

export function exportGraph(store: GraphologyStore, options: KgExportOptions): KgExportResult {
  if (!options || !["jsonl", "csv", "graphml"].includes(options.format)) throw new Error("unsupported export format");
  const maxRecords = bound(options.maxRecords, MAX_RECORDS); const maxBytes = bound(options.maxBytes, MAX_BYTES);
  const nodes = store.db.prepare("SELECT id,type,name,description,aliases,importance,deleted_at,created_at,updated_at FROM kg_nodes ORDER BY id").all() as Array<Record<string, unknown>>;
  const edges = store.db.prepare("SELECT id,source_id,target_id,type,edge_props,weight,deleted_at,created_at,updated_at FROM kg_edges ORDER BY id").all() as Array<Record<string, unknown>>;
  const observations = store.db.prepare("SELECT id,edge_id,source_entity_id,payload,source,scope,quote,confidence,valid_from,valid_to,temporal_confidence,created_at FROM kg_observations ORDER BY id").all() as Array<Record<string, unknown>>;
  const redirects = store.db.prepare("SELECT retired_id,canonical_id,created_at FROM kg_entity_redirects ORDER BY retired_id").all() as Array<Record<string, unknown>>;
  const sourceOmissions = new Set<string>();
  const records: Rec[] = [
    ...nodes.map(row => ({ format_version: 2 as const, kind: "node" as const, node: mapJsonColumns(row, ["aliases"]) })),
    ...edges.map(row => ({ format_version: 2 as const, kind: "edge" as const, edge: mapJsonColumns(row, ["edge_props"]) })),
    ...observations.map(row => { const sanitized=sanitizeSource(String(row.source)); for(const item of sanitized.omissions) sourceOmissions.add(item); return ({ format_version: 2 as const, kind: "observation" as const, observation: { ...mapJsonColumns(row, ["payload"]), source: sanitized.value } }); }),
    ...redirects.map(row => ({ format_version: 2 as const, kind: "redirect" as const, redirect: row }))
  ];
  const recordCount = options.format === "jsonl" ? records.length : nodes.length + edges.length;
  if (recordCount > maxRecords) throw new Error("export record bound exceeded");
  let data: string;
  if (options.format === "jsonl") data = records.map(canonicalStringify).join("\n") + (records.length ? "\n" : "");
  else if (options.format === "csv") data = toCsv(nodes, edges);
  else data = toGraphml(nodes, edges);
  if (Buffer.byteLength(data, "utf8") > maxBytes) throw new Error("export byte bound exceeded");
  return { format: options.format, data, record_count: recordCount, truncated: false, omissions: options.format === "jsonl" ? [...new Set([...jsonlOmissions, ...[...sourceOmissions].sort()])] : [...lossyOmissions] };
}

export function previewJsonlImport(store: GraphologyStore, input: string | Uint8Array, limits: KgImportLimits = {}): KgImportPreview {
  const parsed = parseAndValidate(store, input, normalizeImportLimits(limits));
  store.db.prepare("INSERT OR REPLACE INTO kg_import_previews(preview_hash,graph_revision,summary,payload_hash,created_at) VALUES(?,?,?,?,?)")
    .run(parsed.preview.preview_hash, parsed.preview.graph_revision, canonicalStringify(parsed.preview), parsed.preview.payload_hash, Date.now());
  return parsed.preview;
}

export function confirmJsonlImport(store: GraphologyStore, input: KgImportConfirmInput, limits: KgImportLimits = {}): KgImportResult {
  if (input.confirm !== true) throw new Error("confirm must be true");
  const normalizedLimits = normalizeImportLimits(limits);
  let counts!: KgImportPreview["counts"];
  store.runGraphImportTransaction(() => {
    const parsed = parseAndValidate(store, input.input, normalizedLimits);
    const saved = store.db.prepare("SELECT graph_revision,payload_hash FROM kg_import_previews WHERE preview_hash=?").get(input.previewHash) as { graph_revision: number; payload_hash: string } | undefined;
    if (!saved || saved.payload_hash !== parsed.preview.payload_hash) throw new Error("preview hash or input hash mismatch");
    if (saved.graph_revision !== store.graphRevision()) throw new Error("stale graph revision");
    if (parsed.preview.preview_hash !== input.previewHash) throw new Error("preview hash mismatch");
    if (parsed.preview.errors.length || parsed.preview.conflicts.length) throw new Error("import validation failed");
    counts = parsed.preview.counts;
    const byKind = (kind: Rec["kind"]) => parsed.records.filter(item => item.record.kind === kind).map(item=>item.record);
    for (const record of byKind("node")) insertNode(store, record.node as Record<string, unknown>);
    for (const record of byKind("edge")) insertEdge(store, record.edge as Record<string, unknown>);
    for (const record of byKind("observation")) insertObservation(store, record.observation as Record<string, unknown>);
    for (const record of byKind("redirect")) insertRedirect(store, record.redirect as Record<string, unknown>);
    store.db.prepare("DELETE FROM kg_import_previews WHERE preview_hash=?").run(input.previewHash);
  });
  return { imported: { total: counts.valid, node: counts.node, edge: counts.edge, observation: counts.observation, redirect: counts.redirect }, graph_revision: store.graphRevision() };
}

function parseAndValidate(store: GraphologyStore, input: string | Uint8Array, limits: Required<KgImportLimits>): Parsed {
  const bytes = typeof input === "string" ? Buffer.from(input, "utf8") : Buffer.from(input);
  if (bytes.byteLength > limits.maxBytes) throw new Error(`JSONL input exceeds byte limit (${limits.maxBytes===MAX_BYTES?"10 MiB maximum":`${limits.maxBytes} bytes`})`);
  let text: string; try { text = new TextDecoder("utf-8", { fatal: true }).decode(bytes); } catch { throw new Error("invalid UTF-8 input"); }
  if (/^\s*(?:<\?xml|<graphml|kind,id,)/i.test(text)) throw new Error("only JSONL import is supported");
  const lines = text.split(/\n/); if (lines.at(-1) === "") lines.pop(); if (lines.length > limits.maxRecords) throw new Error(`JSONL input exceeds record limit (${limits.maxRecords===MAX_RECORDS?"1,000 maximum":limits.maxRecords})`);
  const records: Located[] = []; const errors: KgImportError[] = []; const duplicates: KgImportPreview["duplicates"] = []; const conflicts: KgImportPreview["conflicts"] = [];
  const seen = new Map<string, string>();
  for (let index = 0; index < lines.length; index++) {
    const lineNo = index + 1; const line = lines[index].endsWith("\r") ? lines[index].slice(0, -1) : lines[index];
    if (!line.trim()) { errors.push({ line: lineNo, category: "invalid_record", message: "blank JSONL record" }); continue; }
    let value: unknown; try { value = JSON.parse(line); } catch { errors.push({ line: lineNo, category: "invalid_json", message: "one JSON object required per line" }); continue; }
    const validation = validateRecord(value); if (validation) { errors.push({ line: lineNo, category: validation.category, message: validation.message }); continue; }
    const record = value as Rec; const body = record[record.kind] as Record<string, unknown>; const id = identity(record.kind, body); const key = `${record.kind}:${id}`; const canonical = canonicalStringify(record);
    if (seen.has(key)) { if(seen.get(key)===canonical) duplicates.push({kind:record.kind,line:lineNo}); else conflicts.push({kind:record.kind,category:"duplicate_identity",line:lineNo}); continue; }
    seen.set(key, canonical); records.push({record,line:lineNo});
  }
  const existing = new Set<string>();
  for (const [kind, table, column] of [["node","kg_nodes","id"],["edge","kg_edges","id"],["observation","kg_observations","id"],["redirect","kg_entity_redirects","retired_id"]] as const) {
    for (const row of store.db.prepare(`SELECT ${column} AS id FROM ${table}`).all() as Array<{id:string}>) existing.add(`${kind}:${row.id}`);
  }
  for (const {record,line} of records) {
    const body = record[record.kind] as Record<string, unknown>; const id = identity(record.kind, body);
    if (existing.has(`${record.kind}:${id}`)) conflicts.push({kind:record.kind,category:"existing_identity",line});
  }
  const nodeIds = new Set(records.filter(x => x.record.kind === "node").map(x => String((x.record.node as Record<string, unknown>).id)));
  for (const row of store.db.prepare("SELECT id FROM kg_nodes").all() as Array<{ id: string }>) nodeIds.add(row.id);
  const edgeIds = new Set(records.filter(x => x.record.kind === "edge").map(x => String((x.record.edge as Record<string, unknown>).id)));
  for (const row of store.db.prepare("SELECT id FROM kg_edges").all() as Array<{ id: string }>) edgeIds.add(row.id);
  const edgeTriples = new Set((store.db.prepare("SELECT source_id,target_id,type FROM kg_edges").all() as Array<{source_id:string;target_id:string;type:string}>).map(row=>`${row.source_id}\0${row.target_id}\0${row.type}`));
  const activeNodes = new Set((store.db.prepare("SELECT id FROM kg_nodes WHERE deleted_at IS NULL").all() as Array<{id:string}>).map(row=>row.id));
  for(const {record} of records) if(record.kind==="node" && (record.node as Record<string,unknown>).deleted_at===null) activeNodes.add(String((record.node as Record<string,unknown>).id));
  const auditIds = new Set((store.db.prepare("SELECT id FROM kg_merge_audits").all() as Array<{id:string}>).map(row=>row.id));
  for (const {record,line} of records) {
    const body = record[record.kind] as Record<string, unknown>;
    if (record.kind === "edge") { const triple=`${body.source_id}\0${body.target_id}\0${body.type}`; if(edgeTriples.has(triple)) conflicts.push({kind:"edge",category:"existing_edge_triple",line}); else edgeTriples.add(triple); if(!nodeIds.has(String(body.source_id))||!nodeIds.has(String(body.target_id))) errors.push({line,category:"referential_integrity",message:"record has missing reference"}); }
    if (record.kind === "observation" && ((body.edge_id != null && !edgeIds.has(String(body.edge_id))) || (body.source_entity_id != null && !nodeIds.has(String(body.source_entity_id))))) errors.push({line,category:"referential_integrity",message:"record has missing reference"});
    if (record.kind === "redirect") { const retired=String(body.retired_id), canonical=String(body.canonical_id); if(!nodeIds.has(canonical)) errors.push({line,category:"referential_integrity",message:"record has missing reference"}); if(retired===canonical) conflicts.push({kind:"redirect",category:"self_redirect",line}); else if(activeNodes.has(retired)) conflicts.push({kind:"redirect",category:"retired_id_is_active",line}); const audit=`import:${sha(Buffer.from(retired)).slice(0,24)}`; if(auditIds.has(audit)) conflicts.push({kind:"redirect",category:"audit_identity",line}); else auditIds.add(audit); }
  }
  const payloadHash = sha(bytes); const revision = store.graphRevision();
  const counts = { total: lines.length, valid: records.length, node: records.filter(x=>x.record.kind==="node").length, edge: records.filter(x=>x.record.kind==="edge").length, observation: records.filter(x=>x.record.kind==="observation").length, redirect: records.filter(x=>x.record.kind==="redirect").length };
  const base = { counts, duplicates, conflicts, errors, payload_hash: payloadHash, graph_revision: revision };
  return { records, preview: { ...base, preview_hash: sha(Buffer.from(canonicalStringify(base))) } };
}

const bodyKeys: Record<string, string[]> = {
  node: ["id","type","name","description","aliases","importance","deleted_at","created_at","updated_at"], edge: ["id","source_id","target_id","type","edge_props","weight","deleted_at","created_at","updated_at"],
  observation: ["id","edge_id","source_entity_id","payload","source","quote","confidence","valid_from","valid_to","temporal_confidence","created_at"], redirect: ["retired_id","canonical_id","created_at"]
};
function validateRecord(value: unknown): {category:string;message:string}|undefined {
  const invalid=(message="invalid record")=>({category:"invalid_record",message}); const invalidId=()=>({category:"invalid_id",message:"record contains invalid identifier"});
  if (!plain(value)) return invalid("record must be an object"); const record = value as Record<string, unknown>;
  if (![1,2].includes(Number(record.format_version)) || !["node","edge","observation","redirect"].includes(String(record.kind))) return invalid("unsupported JSONL record");
  const kind = String(record.kind); if (!sameKeys(record, ["format_version","kind",kind])) return invalid("record schema is closed");
  const keys = kind === "observation" && record.format_version === 2 ? [...bodyKeys.observation, "scope"] : bodyKeys[kind];
  const body = record[kind]; if (!plain(body) || !sameKeys(body as Record<string, unknown>, keys)) return invalid(`${kind} schema is closed`);
  const b = body as Record<string, unknown>; const ids=kind==="node"?[b.id]:kind==="edge"?[b.id,b.source_id,b.target_id]:kind==="observation"?[b.id,...(b.edge_id==null?[]:[b.edge_id]),...(b.source_entity_id==null?[]:[b.source_entity_id])]:[b.retired_id,b.canonical_id];
  if(ids.some(id=>!isCanonicalId(id))) return invalidId();
  if (kind === "node" && (!nonempty(b.type) || !nonempty(b.name) || typeof b.description!=="string" || !Array.isArray(b.aliases) || b.aliases.some(x=>typeof x!=="string") || !finite(b.importance) || !nullableTime(b.deleted_at) || !time(b.created_at) || !time(b.updated_at))) return invalid("invalid node");
  if (kind === "edge" && (!nonempty(b.type) || !plain(b.edge_props) || !finite(b.weight) || !nullableTime(b.deleted_at) || !time(b.created_at) || !time(b.updated_at))) return invalid("invalid edge");
  if (kind === "observation" && ((b.edge_id == null) === (b.source_entity_id == null) || !plain(b.payload) || !nonempty(b.source) || (record.format_version === 2 && !validScope(b.scope)) || typeof b.quote!=="string" || !finite(b.confidence) || !nullableTime(b.valid_from) || !nullableTime(b.valid_to) || (b.temporal_confidence!==null&&!finite(b.temporal_confidence)) || !time(b.created_at))) return invalid("observation requires exactly one valid subject");
  if (kind === "redirect" && !time(b.created_at)) return invalid("invalid redirect");
  return undefined;
}
function insertNode(store: GraphologyStore, b: Record<string, unknown>) { store.db.prepare("INSERT INTO kg_nodes(id,type,name,description,aliases,importance,deleted_at,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?)").run(b.id,b.type,b.name,b.description,canonicalStringify(b.aliases),b.importance,b.deleted_at,b.created_at,b.updated_at); store.db.prepare("INSERT INTO kg_nodes_fts(id,name,description,aliases) VALUES(?,?,?,?)").run(b.id,b.name,b.description,canonicalStringify(b.aliases)); }
function insertEdge(store: GraphologyStore, b: Record<string, unknown>) { store.db.prepare("INSERT INTO kg_edges(id,source_id,target_id,type,edge_props,weight,deleted_at,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?)").run(b.id,b.source_id,b.target_id,b.type,canonicalStringify(b.edge_props),b.weight,b.deleted_at,b.created_at,b.updated_at); }
function insertObservation(store: GraphologyStore, b: Record<string, unknown>) { const scope=validScope(b.scope)?String(b.scope):"default", now=Date.now(); store.db.prepare("INSERT OR IGNORE INTO kg_scopes(id,created_at,updated_at) VALUES(?,?,?)").run(scope,now,now); store.db.prepare("INSERT INTO kg_observations(id,edge_id,source_entity_id,payload,source,scope,quote,confidence,valid_from,valid_to,temporal_confidence,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)").run(b.id,b.edge_id,b.source_entity_id,canonicalStringify(b.payload),b.source,scope,b.quote,b.confidence,b.valid_from,b.valid_to,b.temporal_confidence,b.created_at); }
function insertRedirect(store: GraphologyStore, b: Record<string, unknown>) { const audit=`import:${sha(Buffer.from(String(b.retired_id))).slice(0,24)}`; store.db.prepare("INSERT INTO kg_merge_audits(id,canonical_id,duplicate_id,status,snapshot_version,snapshot,preview_hash,created_at) VALUES(?,?,?,'merged',1,'{}','import',?)").run(audit,b.canonical_id,b.retired_id,b.created_at); store.db.prepare("INSERT INTO kg_entity_redirects(retired_id,canonical_id,audit_id,created_at) VALUES(?,?,?,?)").run(b.retired_id,b.canonical_id,audit,b.created_at); }
function toCsv(nodes: Array<Record<string, unknown>>, edges: Array<Record<string, unknown>>): string { const rows = [["kind","id","source","target","type","name","description","properties"], ...nodes.map(n=>["node",n.id,"","",n.type,n.name,n.description,n.aliases]), ...edges.map(e=>["edge",e.id,e.source_id,e.target_id,e.type,"","",e.edge_props])]; return rows.map(row=>row.map(csv).join(",")).join("\r\n")+"\r\n"; }
function toGraphml(nodes: Array<Record<string, unknown>>, edges: Array<Record<string, unknown>>): string { return `<?xml version="1.0" encoding="UTF-8"?><graphml xmlns="http://graphml.graphdrawing.org/xmlns"><key id="name" for="node" attr.name="name" attr.type="string"/><key id="description" for="node" attr.name="description" attr.type="string"/><key id="type" for="edge" attr.name="type" attr.type="string"/><key id="properties" for="edge" attr.name="properties" attr.type="string"/><graph edgedefault="directed">${nodes.map(n=>`<node id="${xml(n.id)}"><data key="name">${xml(n.name)}</data><data key="description">${xml(n.description)}</data></node>`).join("")}${edges.map(e=>`<edge id="${xml(e.id)}" source="${xml(e.source_id)}" target="${xml(e.target_id)}"><data key="type">${xml(e.type)}</data><data key="properties">${xml(e.edge_props)}</data></edge>`).join("")}</graph></graphml>`; }
function mapJsonColumns(row: Record<string, unknown>, columns: string[]) { const out={...row}; for(const col of columns) out[col]=JSON.parse(String(out[col])); return out; }
function canonicalStringify(value: unknown): string { return JSON.stringify(sortValue(value)); }
function sortValue(value: unknown): unknown { if(Array.isArray(value)) return value.map(sortValue); if(plain(value)) return Object.fromEntries(Object.keys(value as Record<string,unknown>).sort().map(k=>[k,sortValue((value as Record<string,unknown>)[k])])); return value; }
function sameKeys(value: Record<string,unknown>, keys:string[]) { return Object.keys(value).sort().join("\0") === [...keys].sort().join("\0"); }
function plain(value: unknown): value is Record<string,unknown> { return typeof value === "object" && value !== null && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype; }
function identity(kind:string,b:Record<string,unknown>) { return String(kind==="redirect"?b.retired_id:b.id??""); }
function nonempty(value:unknown): value is string { return typeof value === "string" && value.length>0; }
function validScope(value: unknown): boolean { try { return typeof value === "string" && normalizeScope(value) === value; } catch { return false; } }
function finite(value:unknown): value is number { return typeof value === "number" && Number.isFinite(value); }
function time(value:unknown): value is number { return finite(value) && Number.isSafeInteger(value) && value>=0; }
function nullableTime(value:unknown) { return value===null || time(value); }
function sha(bytes:Uint8Array) { return createHash("sha256").update(bytes).digest("hex"); }
function bound(value:number|undefined, ceiling:number) { if(value===undefined)return ceiling; if(!Number.isSafeInteger(value)||value<1)return 0; return Math.min(value,ceiling); }
function normalizeImportLimits(limits:KgImportLimits): Required<KgImportLimits> { return {maxBytes:positiveLimit(limits.maxBytes,MAX_BYTES),maxRecords:positiveLimit(limits.maxRecords,MAX_RECORDS)}; }
function positiveLimit(value:number|undefined,maximum:number) { return Number.isSafeInteger(value)&&value!>=1?Math.min(value!,maximum):maximum; }
function sanitizeSource(source:string): {value:string;omissions:string[]} {
  if(/^file:/i.test(source) || /^(?:[A-Za-z]:[\\/]|\\\\|\/)/.test(source)) return {value:"local:omitted",omissions:["local_source_paths"]};
  if(/^https?:\/\//i.test(source)) try {
    const url=new URL(source), found:string[]=[];
    if(url.username||url.password){url.username="";url.password="";found.push("source_url_userinfo");}
    if(url.hash){url.hash="";found.push("source_url_fragment");}
    const sensitive=new Set(["apikey","xapikey","accesstoken","token","auth","authorization","password","passwd","secret","credential","sig","signature","key"]);
    for(const key of [...url.searchParams.keys()]) if(sensitive.has(key.toLowerCase().replace(/[-_.]/g,""))) {url.searchParams.delete(key); if(!found.includes("source_url_sensitive_query"))found.push("source_url_sensitive_query");}
    if(found.length===0) return {value:source,omissions:[]};
    url.searchParams.sort(); return {value:url.toString(),omissions:found};
  } catch { return {value:"source:omitted",omissions:["credentials"]}; }
  if(/^[a-z][a-z0-9+.-]*:(?:[A-Za-z]:[\\/]|\\\\|\/)/i.test(source)) return {value:"local:omitted",omissions:["local_source_paths"]};
  return {value:source,omissions:[]};
}
function csv(value:unknown) { const s=String(value??""); return /[",\r\n]/.test(s)?`"${s.replaceAll('"','""')}"`:s; }
function xml(value:unknown) { return String(value??"").replaceAll("&","&amp;").replaceAll("<","&lt;").replaceAll(">","&gt;").replaceAll('"',"&quot;").replaceAll("'","&apos;"); }
