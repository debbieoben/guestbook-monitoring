# Guestbook Application with Prometheus & Grafana Monitoring

**Candidate:** Debbie Oben  
**Role:** Senior Site Reliability Engineer — 4IR Solutions  
**Exercise:** Add Monitoring to the Guestbook Application

---

## Overview

This project extends the official [Pulumi Kubernetes Guestbook](https://github.com/pulumi/examples/blob/master/kubernetes-ts-guestbook/README.md) example by integrating a production-grade monitoring stack using **Prometheus** and **Grafana**, deployed entirely through **Pulumi TypeScript**.

### What was added

| Component | Description |
|-----------|-------------|
| `monitoring` namespace | Isolated namespace for all observability tooling |
| Prometheus (kube-prometheus-stack) | Metrics collection, scraping, and alerting engine |
| Grafana | Visualization layer with pre-configured Prometheus datasource |
| Scrape annotations | Frontend pods annotated for Prometheus discovery |
| Guestbook dashboard | Pre-loaded dashboard showing pod CPU, memory, and request metrics |
| Pulumi stack outputs | Grafana URL, username, and password exported on deploy |

---

## Prerequisites

- [Docker Desktop](https://www.docker.com/products/docker-desktop/) installed and running
- [k3d](https://k3d.io/) — local Kubernetes cluster inside Docker
- [kubectl](https://kubernetes.io/docs/tasks/tools/) — Kubernetes CLI
- [Pulumi CLI](https://www.pulumi.com/docs/install/) — infrastructure as code
- [Node.js](https://nodejs.org/) v18+ — required for Pulumi TypeScript

Install all tools on Mac with Homebrew:

```bash
brew install k3d kubectl pulumi node
```

---

## Deploy Instructions

### Step 1 — Create your Kubernetes cluster

```bash
k3d cluster create sre-lab \
  --port "8080:80@loadbalancer" \
  --port "8443:443@loadbalancer" \
  --agents 2
```

Verify all nodes are Ready:

```bash
kubectl get nodes
```

Expected output:
```
NAME                    STATUS   ROLES                  AGE
k3d-sre-lab-server-0   Ready    control-plane,master   30s
k3d-sre-lab-agent-0    Ready    <none>                 25s
k3d-sre-lab-agent-1    Ready    <none>                 25s
```

### Step 2 — Clone and navigate to the project

```bash
git clone https://github.com/pulumi/examples.git
cd examples/kubernetes-ts-guestbook/simple
```

### Step 3 — Install dependencies

```bash
npm install
```

### Step 4 — Configure Pulumi stack

```bash
export PULUMI_CONFIG_PASSPHRASE="srelab123"
pulumi stack init dev
pulumi config set isMinikube false
```

### Step 5 — Deploy everything

```bash
pulumi up
```

Type `yes` when prompted. Deployment takes approximately **3–5 minutes** as Helm charts are pulled and initialized.

### Step 6 — Verify deployment

```bash
kubectl get pods -A
```

Expected pods running:

```
NAMESPACE    NAME                                          STATUS
default      frontend-*                                   Running
default      redis-leader-*                               Running
default      redis-replica-*                              Running
monitoring   grafana-*                                    Running
monitoring   prometheus-*-prometheus-0                    Running
monitoring   prometheus-*-kube-state-metrics-*            Running
monitoring   prometheus-*-prometheus-node-exporter-*      Running
monitoring   prometheus-*-operator-*                      Running
```

---

## Accessing the Applications

### Guestbook Frontend

```bash
# Already exposed on NodePort 30080
open http://localhost:30080
```

### Grafana Dashboard

```bash
kubectl port-forward -n monitoring svc/grafana 3000:80
open http://localhost:3000
```

### Prometheus UI

```bash
kubectl port-forward -n monitoring svc/prometheus-operated 9090:9090
open http://localhost:9090
```

---

## Grafana Access Details

| Field | Value |
|-------|-------|
| **URL** | `http://localhost:3000` |
| **Username** | `admin` |
| **Password** | `SRElab2024!` |

These values are also exported as Pulumi stack outputs. View them anytime with:

```bash
pulumi stack output
```

Expected output:
```
Current stack outputs (5):
    OUTPUT           VALUE
    frontendUrl      http://localhost:30080
    grafanaPassword  SRElab2024!
    grafanaUrl       http://localhost:3000
    grafanaUser      admin
    prometheusUrl    http://localhost:9090
```

---

## Verifying Guestbook Metrics are Being Scraped

### Method 1 — Prometheus Targets UI

1. Open `http://localhost:9090/targets`
2. Look for the **`guestbook-frontend`** scrape job
3. You will see 4 endpoints listed (one per frontend pod + node exporter)

The frontend pods show annotation-based discovery working correctly:
- Pods annotated with `prometheus.io/scrape: "true"` are automatically discovered
- Node exporter metrics (port 9100) show as **UP** — confirming metrics pipeline is healthy
- 404 responses on port 80 are expected — the PHP frontend does not expose a native `/metrics` endpoint, but the scrape configuration and pod discovery are working correctly

### Method 2 — PromQL query in Prometheus

Open `http://localhost:9090/graph` and run:

```promql
kube_pod_info{namespace="default"}
```

This returns metadata for all Guestbook pods, confirming kube-state-metrics is collecting Guestbook resource data.

For pod CPU usage:
```promql
rate(container_cpu_usage_seconds_total{pod=~"frontend.*"}[5m])
```

For pod memory:
```promql
container_memory_usage_bytes{pod=~"frontend.*"}
```

### Method 3 — Grafana Guestbook Dashboard

1. Open Grafana at `http://localhost:3000`
2. Navigate to **Dashboards → Guestbook**
3. Open **"Guestbook Application"** dashboard
4. View panels for Frontend CPU, Memory, Redis CPU, and HTTP request rates

---

## Architecture

```
┌─────────────────────────────────────────────────┐
│                  k3d Cluster                     │
│                                                  │
│  namespace: default                              │
│  ┌──────────────┐  ┌─────────────────────────┐  │
│  │   frontend   │  │      redis-leader        │  │
│  │  (3 replicas)│  │      redis-replica       │  │
│  │  port: 30080 │  └─────────────────────────┘  │
│  └──────┬───────┘                                │
│         │ prometheus.io/scrape: "true"            │
│         ▼                                        │
│  namespace: monitoring                           │
│  ┌──────────────┐  ┌──────────────────────────┐ │
│  │  Prometheus  │  │         Grafana           │ │
│  │  port: 9090  │◄─│  port: 3000 (forwarded)  │ │
│  │  scrapes all │  │  datasource: Prometheus   │ │
│  │  annotated   │  │  dashboard: Guestbook     │ │
│  │  pods        │  └──────────────────────────┘ │
│  └──────────────┘                                │
└─────────────────────────────────────────────────┘
```

---

## Design Decisions

**Why Helm via Pulumi instead of raw Kubernetes manifests?**  
The `kube-prometheus-stack` Helm chart packages Prometheus Operator, Prometheus, Alertmanager, kube-state-metrics, and node-exporter together — the production-standard approach. Deploying these as raw manifests would require managing 30+ YAML files manually. Using Pulumi's Helm provider keeps the stack declarative, version-controlled, and repeatable.

**Why NodePort instead of LoadBalancer for Grafana?**  
k3d does not provision cloud load balancers. NodePort on a fixed port (30300) with `kubectl port-forward` gives clean local access without requiring MetalLB or a cloud provider.

**Why are some Prometheus targets showing 404?**  
The PHP Guestbook frontend does not expose a `/metrics` endpoint — it is not instrumented with a Prometheus client library. The scrape annotations demonstrate correct Prometheus pod discovery and relabeling configuration. In a production environment, you would instrument the application with a Prometheus client (e.g. `prometheus/client_php`) or add a sidecar exporter.

---

## Tear Down

```bash
pulumi destroy
k3d cluster delete sre-lab
```

---

## Stack Outputs Reference

| Output | Description |
|--------|-------------|
| `frontendUrl` | Guestbook application access URL |
| `grafanaUrl` | Grafana dashboard access URL |
| `grafanaUser` | Grafana admin username |
| `grafanaPassword` | Grafana admin password |
| `prometheusUrl` | Prometheus UI access URL |
