# Configuration

All new corpus behavior is opt-in:

```json
{
  "corpus": {
    "enabled": true,
    "workspaceRoot": "/explicit/local/workspace"
  },
  "workspaceBoundary": { "userMdExclusive": { "enabled": true } }
}
```

`workspaceRoot` is configuration only. It is not stored in the database or
returned in corpus results. The default limits are 1 MiB per file, 500 files,
4,000 characters and 80 lines per chunk. Sessions and dreaming artifacts are
off unless explicitly enabled. `syncOnSearch` defaults to true with a 60-second
minimum interval; it runs only while an operator explicitly requests a corpus
search.

## Optional bounded tool-result preservation

This is separate from the corpus and disabled by default:

```json
{
  "artifacts": {
    "enabled": true,
    "inlineThresholdChars": 12000,
    "maxArtifactBytes": 262144,
    "toolPayloads": { "enabled": true }
  }
}
```

Only public string tool results that fit the configured artifact limit are
archived. A later same-scope/session ContextEngine assembly replaces only an
exact-hash complete copy with an opaque reference. `kg_memory artifact_read`
is exact-ID, same-scope, and limited to 16 KiB per page. It does not infer file
paths or recover host-private truncated tool reads.
