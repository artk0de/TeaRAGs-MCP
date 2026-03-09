---
title: Qdrant
sidebar_position: 2
---

import MermaidTeaRAGs from '@site/src/components/MermaidTeaRAGs';

# Qdrant

TeaRAGs uses [Qdrant](https://qdrant.tech/) as its vector database. There are several ways to run it — from zero-config embedded mode to a remote managed cluster.

## Connection Modes

<MermaidTeaRAGs>
{`
flowchart LR
    TeaRAGs[🍵 TeaRAGs]

    subgraph autodetect["Autodetect (default)"]
        Probe["🔍 Probe localhost:6333"]
        Embedded["📦 Embedded<br/><small>auto-download binary</small>"]
        Probe -->|not found| Embedded
    end

    External["🐳 External Qdrant<br/><small>Docker / hosted / cloud</small>"]

    TeaRAGs -->|QDRANT_URL unset| autodetect
    TeaRAGs -->|QDRANT_URL=embedded| Embedded
    TeaRAGs -->|QDRANT_URL=http://...| External
    Probe -->|found| External
`}
</MermaidTeaRAGs>

| Mode | `QDRANT_URL` value | When to use |
|------|--------------------|-------------|
| **Autodetect** (default) | *unset* | Works for most users — tries external first, falls back to embedded |
| **Embedded** | `embedded` | Force built-in Qdrant, ignore any external instance |
| **External** | `http://host:port` | Use a specific Qdrant instance (Docker, self-hosted, cloud) |

### Default Autodetect Logic

When `QDRANT_URL` is not set, TeaRAGs:

1. **Probes `localhost:6333`** — if a Qdrant instance is running there, uses it as external
2. **Falls back to embedded** — downloads and starts a managed Qdrant binary automatically

This means existing Docker setups keep working with zero changes, and new users get Qdrant out of the box.

---

## Embedded Qdrant (Default)

The simplest option — no Docker, no manual setup. TeaRAGs downloads and manages the Qdrant binary automatically.

### How It Works

- On `npm install`, the postinstall script downloads the Qdrant binary for your platform
- If that fails (e.g. no internet), the binary is downloaded lazily on first use
- Qdrant runs as a **detached child process** alongside TeaRAGs
- Multiple TeaRAGs instances share the same daemon via refcounting
- The daemon shuts down automatically after 30 seconds of inactivity

### Supported Platforms

| Platform | Architecture | Binary |
|----------|-------------|--------|
| macOS | Apple Silicon (arm64) | `qdrant-aarch64-apple-darwin.tar.gz` |
| macOS | Intel (x64) | `qdrant-x86_64-apple-darwin.tar.gz` |
| Linux | x64 | `qdrant-x86_64-unknown-linux-gnu.tar.gz` |
| Linux | arm64 | `qdrant-aarch64-unknown-linux-musl.tar.gz` |
| Windows | x64 | `qdrant-x86_64-pc-windows-msvc.zip` |

### Data Storage

| Variable | Description | Default |
|----------|-------------|---------|
| `QDRANT_EMBEDDED_STORAGE_PATH` | Override storage location | `~/.tea-rags/qdrant/storage` |

Data persists between restarts. To reset, delete the storage directory:

```bash
rm -rf ~/.tea-rags/qdrant
```

### Daemon Lifecycle

The embedded Qdrant daemon is managed automatically:

1. **First start** — binary downloaded (if needed), free port selected, process spawned
2. **Subsequent connections** — existing daemon reused via PID/port file discovery
3. **Refcounting** — each TeaRAGs instance increments a ref counter on attach, decrements on detach
4. **Idle shutdown** — when all refs released, daemon waits 30 seconds then terminates via `SIGTERM`

Daemon files are stored in `~/.tea-rags/qdrant/`:
- `daemon.pid` — process ID
- `daemon.port` — HTTP port
- `daemon.refs` — active reference count

---

## Docker Qdrant (Local)

Run Qdrant as a Docker container. Useful if you already have Docker and want more control over the database.

### Option A: Docker Run

The simplest way — a single command, no extra files:

```bash
docker run -d --name qdrant \
  -p 6333:6333 -p 6334:6334 \
  -v qdrant_storage:/qdrant/storage \
  qdrant/qdrant
```

Manage the container:

```bash
# Stop
docker stop qdrant

# Start again
docker start qdrant

# View logs
docker logs qdrant

# Remove (data persists in the named volume)
docker rm qdrant
```

### Option B: Docker Compose

Add a `docker-compose.yml` to your project root — convenient for teams and reproducible setups:

```yaml title="docker-compose.yml"
services:
  qdrant:
    image: qdrant/qdrant
    ports:
      - "6333:6333"
      - "6334:6334"
    volumes:
      - qdrant_storage:/qdrant/storage
    restart: unless-stopped

volumes:
  qdrant_storage:
```

```bash
docker compose up -d
```

This file can be committed to your repository so every team member gets the same setup.

### Configuration

With Docker running on default port (`6333`), TeaRAGs **autodetects** it — no `QDRANT_URL` needed.

To use a custom port:

```bash
QDRANT_URL=http://localhost:7333
```

### When to Use Docker

- You already have Docker in your workflow
- You need Qdrant's web dashboard (available at `http://localhost:6333/dashboard`)
- You want to pin a specific Qdrant version
- You need custom Qdrant configuration (memory limits, WAL settings, etc.)

---

## Self-Hosted Qdrant

Run Qdrant as a standalone binary or systemd service on a local or remote machine — without Docker.

### Install from Package

Download the binary for your platform from [Qdrant releases](https://github.com/qdrant/qdrant/releases) and run:

```bash
./qdrant --storage-path /path/to/storage
```

Default ports: HTTP on `6333`, gRPC on `6334`.

### Connect TeaRAGs

```bash
# Local (default port — autodetected)
# No configuration needed

# Local with custom port
QDRANT_URL=http://localhost:7333

# Remote machine
QDRANT_URL=http://192.168.1.100:6333
```

### With API Key

If your Qdrant instance requires authentication:

```bash
QDRANT_URL=http://your-qdrant-host:6333
QDRANT_API_KEY=your-api-key
```

---

## External / Cloud Qdrant

Use a managed Qdrant cluster for production workloads, team sharing, or when you need high availability.

### Qdrant Cloud Free Tier

Qdrant Cloud offers a **free forever** cluster — no credit card required. Enough for most individual projects.

**Free tier limits:**

| Resource | Limit |
|----------|-------|
| RAM | 1 GB |
| Disk | 4 GB |
| vCPU | 0.5 |
| Nodes | 1 |
| Vectors (768d) | ~1 million |
| Users | Unlimited |

:::warning Inactivity Policy
Free clusters **suspend after 1 week** of inactivity and are **deleted after 4 weeks** if not reactivated. Make sure your agent runs periodically or reactivate the cluster manually via the dashboard.
:::

**Setup:**

1. Sign up at [cloud.qdrant.io/signup](https://cloud.qdrant.io/signup) (no credit card)
2. Go to **Clusters** → click **+ Create** → select **Free**
3. Choose a cloud provider (AWS, GCP, or Azure) and region
4. Wait for the cluster to provision (1–2 minutes)
5. Open the cluster detail page and copy the **URL** and **API key**
6. Configure TeaRAGs:

```bash
QDRANT_URL=https://your-cluster-id.aws.cloud.qdrant.io:6333
QDRANT_API_KEY=your-cloud-api-key
```

**How far does 1 million vectors go?** With TeaRAGs' default chunking (~2500 chars per chunk), 1M vectors covers roughly **500k–1M lines of code** — enough for most individual repositories.

### Any Qdrant-Compatible Endpoint

TeaRAGs works with any Qdrant REST API endpoint — self-managed clusters, Qdrant Hybrid Cloud, or third-party hosting:

```bash
QDRANT_URL=https://your-qdrant.example.com:6333
QDRANT_API_KEY=your-api-key
```

---

## Environment Variables Reference

| Variable | Description | Default |
|----------|-------------|---------|
| `QDRANT_URL` | Connection mode: unset = autodetect, `embedded` = force embedded, `http://...` = external | Autodetect |
| `QDRANT_API_KEY` | API key for Qdrant authentication | — |
| `QDRANT_EMBEDDED_STORAGE_PATH` | Override embedded Qdrant storage location | `~/.tea-rags/qdrant/storage` |

## Troubleshooting

### Embedded Qdrant won't start

1. Check if the binary exists:
   ```bash
   ls ~/.tea-rags/qdrant/
   ```
2. Check for stale daemon files:
   ```bash
   cat ~/.tea-rags/qdrant/daemon.pid
   cat ~/.tea-rags/qdrant/daemon.port
   ```
3. Clean up and restart:
   ```bash
   rm ~/.tea-rags/qdrant/daemon.*
   ```

### Port conflict

If another process occupies the auto-selected port, the daemon will pick a different one on next start. If `localhost:6333` is occupied by a non-Qdrant process, autodetect may incorrectly identify it as external Qdrant. Force embedded mode:

```bash
QDRANT_URL=embedded
```

### Switching from Docker to embedded

If you were using Docker Qdrant and want to switch to embedded:

1. Stop Docker Qdrant: `docker compose down`
2. Remove or unset `QDRANT_URL` from your MCP config
3. TeaRAGs will start embedded Qdrant on next use
4. Re-index your codebase (data is stored separately)
