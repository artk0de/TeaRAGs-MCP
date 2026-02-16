---
title: Local Exposed GPU Setup
sidebar_position: 3
---

import MermaidTeaRAGs from '@site/src/components/MermaidTeaRAGs';

# Local Exposed GPU Setup

Use a dedicated machine with a powerful GPU in your local network as an embedding server for TeaRAGs. This setup delivers the best performance — fast GPU embedding + fast local Qdrant storage.

## Why This Setup?

**Best of both worlds:**
- Dedicated GPU for fast embedding (1.5-2x faster than M3 Pro)
- Local Qdrant on your development machine (microsecond latency)
- Ollama accessible from multiple machines in your network
- No cloud costs, fully local and private

**Recommended topology:**

<MermaidTeaRAGs>
{`
flowchart LR
    subgraph dev["💻 Development Machine"]
        claude["🤖 Claude Code"]
        qdrant["🗄️ Qdrant<br/><small>Docker</small>"]
    end

    subgraph gpu["🖥️ GPU Server"]
        ollama["✨ Ollama<br/><small>GPU</small>"]
    end

    claude -->|embedding| ollama
    ollama -.->|vectors| claude
    claude -->|storage| qdrant
`}
</MermaidTeaRAGs>

## GPU Server Setup

### 1. Choose Your GPU Server

Any machine with a dedicated GPU:
- Desktop PC with NVIDIA/AMD GPU
- Laptop with discrete GPU
- External GPU (eGPU) enclosure
- Mac Studio / Mac Mini with M-series chip
- Used gaming PC or workstation

**Minimum specs:**
- 8GB+ VRAM
- Gigabit LAN connection
- 16GB+ RAM

**Recommended:**
- NVIDIA RTX 3060/4060 (12GB VRAM) or better
- AMD RX 6800/7800 (12GB+ VRAM)
- Apple M-series (16GB+ unified memory)

### 2. Install GPU Drivers

#### NVIDIA (CUDA)

<details>
<summary><strong>Linux</strong></summary>

```bash
# Ubuntu/Debian
sudo apt update
sudo apt install nvidia-driver-535 nvidia-cuda-toolkit

# Verify installation
nvidia-smi
```

</details>

<details>
<summary><strong>Windows</strong></summary>

- Download [NVIDIA Drivers](https://www.nvidia.com/Download/index.aspx)
- Download [CUDA Toolkit](https://developer.nvidia.com/cuda-downloads)
- Restart after installation
- Verify: `nvidia-smi` in PowerShell

</details>

**Resources:**
- [NVIDIA CUDA Installation Guide](https://docs.nvidia.com/cuda/cuda-installation-guide-linux/)

#### AMD (ROCm)

<details>
<summary><strong>Linux</strong></summary>

```bash
# Ubuntu 22.04
wget https://repo.radeon.com/amdgpu-install/latest/ubuntu/jammy/amdgpu-install_*.deb
sudo apt install ./amdgpu-install_*.deb
sudo amdgpu-install --usecase=rocm

# Verify installation
rocm-smi
```

</details>

<details>
<summary><strong>Windows</strong></summary>

ROCm can work on Windows **only with AMD Radeon PRO drivers** (blue logo), not Adrenaline (gaming drivers):
- Download [AMD Radeon PRO Software](https://www.amd.com/en/support/professional-graphics)
- Supports only **RDNA2** (RX 6000) and **RDNA3** (RX 7000) architectures
- Older GCN cards (RX 5000 and below) are **not supported** on Windows
- Alternative: Use Docker with Linux container + ROCm

</details>

**Supported GPU architectures:**
- ✅ RDNA3 (RX 7900/7800/7700/7600) — best support
- ✅ RDNA2 (RX 6900/6800/6700/6600) — good support
- ⚠️ GCN (RX 5000 and older) — Linux only, limited support
- ❌ Older GCN cards — not recommended

**Resources:**
- [AMD ROCm Installation Guide](https://rocm.docs.amd.com/en/latest/deploy/linux/quick_start.html)
- [ROCm GPU Support Matrix](https://rocm.docs.amd.com/en/latest/compatibility/compatibility-matrix.html)

#### Intel Arc

<details>
<summary><strong>Linux</strong></summary>

```bash
# Ubuntu 22.04
wget -qO - https://repositories.intel.com/gpu/intel-graphics.key | sudo gpg --dearmor -o /usr/share/keyrings/intel-graphics.gpg
echo "deb [arch=amd64 signed-by=/usr/share/keyrings/intel-graphics.gpg] https://repositories.intel.com/gpu/ubuntu jammy client" | sudo tee /etc/apt/sources.list.d/intel-gpu-jammy.list
sudo apt update
sudo apt install intel-opencl-icd intel-level-zero-gpu level-zero

# Verify installation
clinfo
```

</details>

<details>
<summary><strong>Windows</strong></summary>

- Download [Intel Arc Drivers](https://www.intel.com/content/www/us/en/download/785597/intel-arc-iris-xe-graphics-windows.html)
- Restart after installation

</details>

**Resources:**
- [Intel oneAPI Installation](https://www.intel.com/content/www/us/en/developer/tools/oneapi/base-toolkit-download.html)

:::warning Driver Compatibility
Ensure GPU drivers are compatible with your OS version. Mismatched drivers can cause crashes or poor performance. Check manufacturer documentation for your specific GPU model.
:::

### 3. Install Qdrant (Optional)

If you want to run both Qdrant and Ollama on the GPU server:

```bash
# Docker (recommended)
docker run -d \
  --name qdrant \
  -p 6333:6333 \
  -v $(pwd)/qdrant_storage:/qdrant/storage \
  --memory=4g \
  qdrant/qdrant:latest
```

:::tip Local vs Remote Qdrant
**Recommended:** Run Qdrant locally on your development machine for best storage performance (6966 ch/s vs 1810 ch/s). Only run Qdrant on GPU server if you can't use Docker on your development machine.
:::

### 4. Install Ollama

#### Option 1: Native Installation (Recommended)

<details>
<summary><strong>Linux</strong></summary>

```bash
curl -fsSL https://ollama.com/install.sh | sh
```

</details>

<details>
<summary><strong>Windows</strong></summary>

```powershell
# Download from https://ollama.com/download
# Run installer
```

</details>

<details>
<summary><strong>macOS (Mac Studio / Mac Mini)</strong></summary>

```bash
brew install ollama
```

</details>

#### Option 2: Docker with GPU

<details>
<summary><strong>Linux + NVIDIA</strong></summary>

```bash
# Install NVIDIA Container Toolkit first
distribution=$(. /etc/os-release;echo $ID$VERSION_ID)
curl -s -L https://nvidia.github.io/libnvidia-container/gpgkey | sudo apt-key add -
curl -s -L https://nvidia.github.io/libnvidia-container/$distribution/libnvidia-container.list | sudo tee /etc/apt/sources.list.d/nvidia-container-toolkit.list
sudo apt-get update && sudo apt-get install -y nvidia-container-toolkit
sudo systemctl restart docker

# Run Ollama with GPU
docker run -d \
  --name ollama \
  --gpus all \
  -p 11434:11434 \
  -v ollama_models:/root/.ollama \
  ollama/ollama:latest
```

</details>

<details>
<summary><strong>Linux + AMD ROCm</strong></summary>

```bash
docker run -d \
  --name ollama \
  --device /dev/kfd \
  --device /dev/dri \
  -p 11434:11434 \
  -v ollama_models:/root/.ollama \
  ollama/ollama:rocm
```

</details>

### 5. Configure Network Access

#### Enable Ollama Network Access

**Native Ollama:**

Create or edit Ollama service configuration:

<details>
<summary><strong>Linux (systemd)</strong></summary>

```bash
# Create override
sudo mkdir -p /etc/systemd/system/ollama.service.d
sudo tee /etc/systemd/system/ollama.service.d/override.conf << 'EOF'
[Service]
Environment="OLLAMA_HOST=0.0.0.0:11434"
EOF

# Reload and restart
sudo systemctl daemon-reload
sudo systemctl restart ollama
```

</details>

<details>
<summary><strong>macOS (launchd)</strong></summary>

```bash
# Set environment variable
launchctl setenv OLLAMA_HOST "0.0.0.0:11434"

# Restart Ollama app
# Or via command line:
OLLAMA_HOST=0.0.0.0:11434 ollama serve
```

</details>

<details>
<summary><strong>Windows</strong></summary>

```powershell
# Set environment variable (system-wide)
[System.Environment]::SetEnvironmentVariable('OLLAMA_HOST', '0.0.0.0:11434', 'Machine')

# Restart Ollama service or app
Restart-Service Ollama
```

</details>

<details>
<summary><strong>Docker</strong></summary>

```bash
# Already exposed on 0.0.0.0:11434 by default
# No additional configuration needed
```

</details>

#### Open Firewall Ports

<details>
<summary><strong>Linux (ufw)</strong></summary>

```bash
# Ollama
sudo ufw allow 11434/tcp

# Qdrant (if running on GPU server)
sudo ufw allow 6333/tcp

# Check status
sudo ufw status
```

</details>

<details>
<summary><strong>Windows Firewall</strong></summary>

```powershell
# Ollama
New-NetFirewallRule -DisplayName "Ollama" -Direction Inbound -Protocol TCP -LocalPort 11434 -Action Allow

# Qdrant (if running on GPU server)
New-NetFirewallRule -DisplayName "Qdrant" -Direction Inbound -Protocol TCP -LocalPort 6333 -Action Allow
```

</details>

<details>
<summary><strong>macOS</strong></summary>

```bash
# macOS firewall allows local network by default
# If enabled, add Ollama to allowed apps in System Settings → Network → Firewall
```

</details>

:::tip Firewall Configuration
Firewall rules vary by OS and distribution. Search for "open port [YOUR_OS]" if commands above don't work for your system. Common tools: `ufw` (Ubuntu), `firewalld` (RHEL/Fedora), Windows Defender Firewall, macOS System Settings.
:::

### 6. Set Static IP (Recommended)

Assign a static IP to your GPU server to avoid connection issues when the IP changes.

#### Option 1: Router DHCP Reservation (Recommended)

1. Log into your router admin panel (usually `192.168.1.1` or `192.168.0.1`)
2. Find **DHCP Reservation** or **Static DHCP** settings
3. Add reservation:
   - **MAC Address:** Your GPU server's network interface MAC
   - **IP Address:** e.g., `192.168.1.100`
4. Save and reboot GPU server

**How to find MAC address:**

<details>
<summary><strong>Linux</strong></summary>

```bash
ip link show
# Look for "link/ether XX:XX:XX:XX:XX:XX"
```

</details>

<details>
<summary><strong>Windows</strong></summary>

```powershell
ipconfig /all
# Look for "Physical Address"
```

</details>

<details>
<summary><strong>macOS</strong></summary>

```bash
ifconfig en0 | grep ether
```

</details>

#### Option 2: Static IP on Server

<details>
<summary><strong>Linux (netplan)</strong></summary>

```yaml
# /etc/netplan/01-network.yaml
network:
  version: 2
  ethernets:
    eth0:  # or your interface name
      dhcp4: no
      addresses:
        - 192.168.1.100/24
      gateway4: 192.168.1.1
      nameservers:
        addresses: [8.8.8.8, 8.8.4.4]
```

Apply:
```bash
sudo netplan apply
```

</details>

<details>
<summary><strong>Windows</strong></summary>

- Control Panel → Network → Change adapter settings
- Right-click network adapter → Properties
- IPv4 → Properties → Use the following IP address
- Set IP: `192.168.1.100`, Subnet: `255.255.255.0`, Gateway: `192.168.1.1`

</details>

<details>
<summary><strong>macOS</strong></summary>

- System Settings → Network → Ethernet/Wi-Fi → Details
- TCP/IP → Configure IPv4: Manually
- Set IP: `192.168.1.100`, Subnet Mask: `255.255.255.0`, Router: `192.168.1.1`

</details>

:::tip Router vs Server Static IP
**Prefer router DHCP reservation** — easier to manage, survives OS reinstalls, centralized configuration. Use server-side static IP only if you can't access router settings.
:::

### 7. Pull Embedding Models

```bash
# Default code-specialized model (recommended)
ollama pull unclemusclez/jina-embeddings-v2-base-code:latest

# Alternative models
ollama pull nomic-embed-text:latest
ollama pull mxbai-embed-large:latest
```

### 8. Verify Setup

**Check Ollama from another machine:**
```bash
# From your development machine
curl http://192.168.1.100:11434/api/version

# Test embedding
curl http://192.168.1.100:11434/api/embeddings -d '{
  "model": "unclemusclez/jina-embeddings-v2-base-code:latest",
  "prompt": "test"
}'
```

**Check Qdrant (if running on GPU server):**
```bash
curl http://192.168.1.100:6333/healthz
# Should return: "healthy"
```

## Development Machine Setup

### Configure TeaRAGs

On your development machine, point TeaRAGs to the GPU server:

```bash
claude mcp add tea-rags -s user -- node /path/to/tea-rags-mcp/build/index.js \
  -e EMBEDDING_BASE_URL=http://192.168.1.100:11434 \
  -e EMBEDDING_CONCURRENCY=4
```

**If Qdrant also runs on GPU server:**
```bash
claude mcp add tea-rags -s user -- node /path/to/tea-rags-mcp/build/index.js \
  -e QDRANT_URL=http://192.168.1.100:6333 \
  -e EMBEDDING_BASE_URL=http://192.168.1.100:11434 \
  -e EMBEDDING_CONCURRENCY=4
```

### Run Local Qdrant (Recommended)

For best storage performance, run Qdrant locally on your development machine:

```bash
docker run -d \
  --name qdrant \
  -p 6333:6333 \
  -v $(pwd)/qdrant_storage:/qdrant/storage \
  qdrant/qdrant:latest
```

This gives you:
- **Fast embedding:** Remote GPU (154-156 ch/s)
- **Fast storage:** Local Qdrant (6966 ch/s)
- **Best overall performance:** ~7m 39s for VS Code (3.5M LoC)

## Performance Tuning

### Auto-Tune for Remote GPU

Run the tuning benchmark pointing to your GPU server:

```bash
EMBEDDING_BASE_URL=http://192.168.1.100:11434 npm run tune
```

**Expected optimal settings:**
```bash
EMBEDDING_BATCH_SIZE=256
EMBEDDING_CONCURRENCY=4-6
QDRANT_UPSERT_BATCH_SIZE=512
QDRANT_BATCH_ORDERING=strong
```

See **[Performance Tuning](/config/performance-tuning)** for detailed benchmarks and topology comparison.

## Troubleshooting

### Cannot Connect to GPU Server

**Check network connectivity:**
```bash
ping 192.168.1.100
```

**Check Ollama is listening on 0.0.0.0:**
```bash
# On GPU server
sudo netstat -tulpn | grep 11434
# Should show 0.0.0.0:11434, NOT 127.0.0.1:11434
```

**Check firewall:**
```bash
# Linux
sudo ufw status

# Test from development machine
telnet 192.168.1.100 11434
# OR
nc -zv 192.168.1.100 11434
```

### Slow Embedding Performance

**Verify GPU is being used:**

**NVIDIA:**
```bash
# On GPU server
nvidia-smi
# Should show ollama process using GPU
```

**AMD:**
```bash
rocm-smi
```

**Intel:**
```bash
clinfo
```

**If GPU not used:**
- Check drivers are installed correctly
- Restart Ollama after driver installation
- For Docker: verify `--gpus all` flag (NVIDIA) or `--device /dev/kfd --device /dev/dri` (AMD)

### IP Address Changed

If GPU server IP changes after router reboot:

1. Check current IP: `ip addr` (Linux) or `ipconfig` (Windows)
2. Update TeaRAGs configuration with new IP
3. **Permanent fix:** Set static IP via router DHCP reservation (see above)

### Connection Drops During Indexing

**Increase timeout:**
```bash
claude mcp add tea-rags -s user -- node /path/to/tea-rags-mcp/build/index.js \
  -e EMBEDDING_BASE_URL=http://192.168.1.100:11434 \
  -e HTTP_REQUEST_TIMEOUT_MS=600000
```

**Check network stability:**
- Use wired Ethernet instead of Wi-Fi
- Check router logs for connection drops
- Disable Wi-Fi power saving on GPU server

## Security Considerations

### Local Network Only

**Do NOT expose Ollama to the internet** — it has no authentication by default.

**Safe:** `0.0.0.0:11434` (listens on all interfaces, accessible in LAN)
**Unsafe:** Port forwarding 11434 to internet (⚠️ security risk)

If you need remote access from outside your LAN:
- Use VPN (WireGuard, Tailscale, OpenVPN)
- Use SSH tunnel: `ssh -L 11434:localhost:11434 user@gpu-server`

### Firewall Best Practices

**Allow only local network:**

**Linux (ufw):**
```bash
# Allow from local network only (example: 192.168.1.0/24)
sudo ufw allow from 192.168.1.0/24 to any port 11434 proto tcp
```

**Windows Firewall:**
- Advanced Settings → Inbound Rules → Ollama
- Scope → Remote IP addresses → Add `192.168.1.0/24`

## Multi-User Setup

Multiple developers can share the same GPU server:

**GPU Server:** One instance of Ollama
**Each Developer:** Runs own Qdrant locally, points to shared Ollama

**Benefits:**
- Cost-effective — one GPU serves entire team
- Consistent performance across team
- Centralized model management

**Configuration (same on all dev machines):**
```bash
claude mcp add tea-rags -s user -- node /path/to/tea-rags-mcp/build/index.js \
  -e EMBEDDING_BASE_URL=http://192.168.1.100:11434 \
  -e EMBEDDING_CONCURRENCY=4
```

:::tip Shared GPU Performance
Ollama handles concurrent requests well. 4-6 developers can share a single GPU server without significant slowdown. Monitor GPU usage with `nvidia-smi` to check load.
:::

## Next Steps

- **[Performance Tuning](/config/performance-tuning)** — benchmark your GPU server, compare topologies
- **[Installation](/config/first-time-setup)** — see all setup options
- **[Configuration Variables](/config/environment-variables)** — full configuration reference
