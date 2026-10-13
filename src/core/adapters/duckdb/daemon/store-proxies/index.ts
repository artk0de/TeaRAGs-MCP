/**
 * Per-store daemon proxies (bd tea-rags-mcp-0qaht.38): one class per
 * `GraphDbClient` sub-interface, each sending its ops through a
 * `DaemonOpCaller`. `DaemonGraphDbClient` composes them.
 */
export { DaemonGraphAnalyticsStoreProxy, UnsupportedDaemonReadError } from "./graph-analytics-store-proxy.js";
export { DaemonFieldAccessStoreProxy } from "./field-access-store-proxy.js";
export { DaemonGraphReadStoreProxy } from "./graph-read-store-proxy.js";
export { DaemonIdentifierStoreProxy } from "./identifier-store-proxy.js";
export { DaemonOntologyReportStoreProxy } from "./ontology-report-store-proxy.js";
export { DaemonStorageMaintenanceProxy } from "./storage-maintenance-proxy.js";
export { DaemonSymbolFileStoreProxy } from "./symbol-file-store-proxy.js";
export { DaemonTemporalStoreProxy } from "./temporal-store-proxy.js";
