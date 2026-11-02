// Metadata-only observer. Never performs a fetch, changes a timeout/status/body,
// or becomes a model eval variant. Controller rejects it for actual actors.
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const output = process.env.P0_FETCH_AUDIT;
const log = data => { try { if (output) fs.appendFileSync(output, JSON.stringify(data) + '\n'); } catch {} };
const storage = process.env.QDRANT_EMBEDDED_STORAGE_PATH || path.join(process.env.TEA_RAGS_DATA_DIR || path.join(os.homedir(), '.tea-rags'), 'qdrant');
const portFile = path.join(storage, 'daemon.port');
const helper = path.join(path.dirname(process.argv[1]), 'prime', 'qdrant-discovery.js');
// Exit-only filesystem observations cannot warm the prime cold path.
process.once('exit', () => {
let port = null, readable = false, helperSha = null, accessError = null;
try { fs.accessSync(portFile, fs.constants.R_OK); readable = true; const value = fs.readFileSync(portFile, 'utf8').trim(); port = /^\d+$/.test(value) ? Number(value) : 'NON_NUMERIC'; } catch (e) { accessError = e.code || e.name; }
try { helperSha = crypto.createHash('sha256').update(fs.readFileSync(helper)).digest('hex'); } catch {}
log({kind:'native_cli_context', argv:process.argv, cwd:process.cwd(), home:os.homedir(), storage, portFile, readable, port, accessError, helper, helperSha});
});
const original = globalThis.fetch;
globalThis.fetch = async function(input, init) {
 const url = typeof input === 'string' ? input : input.url;
 if (!String(url).endsWith('/readyz')) return original.apply(this, arguments);
 const start = performance.now();
 try { const response = await original.apply(this, arguments); log({kind:'actual_readyz_fetch', url, status:response.status, elapsedMs:performance.now()-start}); return response; }
 catch (error) { log({kind:'actual_readyz_fetch', url, errorName:error.name, errorCode:error.cause?.code || error.code || null, elapsedMs:performance.now()-start}); throw error; }
};
