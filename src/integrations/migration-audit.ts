import { createHash, randomUUID } from "node:crypto";
import type { DatabaseSyncInstance } from "@photostructure/sqlite";
import { normalizeScope } from "../scope.js";
import type { IntegrationProviderId, ResolvedSource } from "./types.js";

export interface ImportAudit { id:string; provider:IntegrationProviderId; scope:string; externalId:string; contentHash:string; status:"imported"|"skipped_duplicate"|"failed"; cursor:string|null; createdAt:number; }
export class ProviderMigrationAuditRepository {
 constructor(private readonly db:DatabaseSyncInstance) {}
 record(input:{provider:IntegrationProviderId;scope:string;source:ResolvedSource;status:ImportAudit["status"];cursor?:string}):ImportAudit {const scope=normalizeScope(input.scope),id=`provider-import:${randomUUID()}`,now=Date.now(),externalId=input.source.ref.externalId.slice(0,200),hash=createHash("sha256").update(input.source.content).digest("hex");this.db.prepare("INSERT OR IGNORE INTO kg_scopes(id,created_at,updated_at) VALUES(?,?,?)").run(scope,now,now);this.db.prepare("INSERT OR IGNORE INTO mnemora_provider_import_audits(id,provider,scope,external_id,content_hash,status,cursor,created_at) VALUES(?,?,?,?,?,?,?,?)").run(id,input.provider,scope,externalId,hash,input.status,input.cursor??null,now);return {id,provider:input.provider,scope,externalId,contentHash:hash,status:input.status,cursor:input.cursor??null,createdAt:now};}
 list(provider:IntegrationProviderId,scope:string,limit=50):ImportAudit[]{return (this.db.prepare("SELECT * FROM mnemora_provider_import_audits WHERE provider=? AND scope=? ORDER BY created_at DESC,id DESC LIMIT ?").all(provider,normalizeScope(scope),Math.min(100,Math.max(1,limit))) as Array<Record<string,unknown>>).map(row=>({id:String(row.id),provider:row.provider as IntegrationProviderId,scope:String(row.scope),externalId:String(row.external_id),contentHash:String(row.content_hash),status:row.status as ImportAudit["status"],cursor:row.cursor?String(row.cursor):null,createdAt:Number(row.created_at)}));}
}
