# Evidence storage

Original source snapshots, fixtures, profiles and raw records are stored byte for byte in `evidence.tar.gz`. Every member SHA was compared with the original before packing. Original inner inventories are unchanged.

Extract into a scratch directory before following inner reproduction paths or verifying the original inventories; keep captured TypeScript outside the repository so it does not participate in lint or test discovery.

```sh
mkdir -p /tmp/tea-rags-evidence-orchestration-results
tar -xzf evidence.tar.gz -C /tmp/tea-rags-evidence-orchestration-results
```
