// Copyright 2016-2025, Pulumi Corporation.  All rights reserved.
// Extended by Debbie Oben — added Prometheus + Grafana monitoring stack

import * as k8s from "@pulumi/kubernetes";
import * as pulumi from "@pulumi/pulumi";

// ─────────────────────────────────────────────────────────────────
// CONFIG
// ─────────────────────────────────────────────────────────────────
const config = new pulumi.Config();
const isMinikube = config.getBoolean("isMinikube");

// ─────────────────────────────────────────────────────────────────
// REDIS LEADER  (original — unchanged)
// ─────────────────────────────────────────────────────────────────
const redisLeaderLabels = { app: "redis-leader" };
const redisLeaderDeployment = new k8s.apps.v1.Deployment("redis-leader", {
    spec: {
        selector: { matchLabels: redisLeaderLabels },
        template: {
            metadata: { labels: redisLeaderLabels },
            spec: {
                containers: [{
                    name: "redis-leader",
                    image: "redis",
                    resources: { requests: { cpu: "100m", memory: "100Mi" } },
                    ports: [{ containerPort: 6379 }],
                }],
            },
        },
    },
});

const redisLeaderService = new k8s.core.v1.Service("redis-leader", {
    metadata: {
        name: "redis-leader",
        labels: redisLeaderDeployment.metadata.labels,
    },
    spec: {
        ports: [{ port: 6379, targetPort: 6379 }],
        selector: redisLeaderDeployment.spec.template.metadata.labels,
    },
});

// ─────────────────────────────────────────────────────────────────
// REDIS REPLICA  (original — unchanged)
// ─────────────────────────────────────────────────────────────────
const redisReplicaLabels = { app: "redis-replica" };
const redisReplicaDeployment = new k8s.apps.v1.Deployment("redis-replica", {
    spec: {
        selector: { matchLabels: redisReplicaLabels },
        template: {
            metadata: { labels: redisReplicaLabels },
            spec: {
                containers: [{
                    name: "replica",
                    image: "pulumi/guestbook-redis-replica",
                    resources: { requests: { cpu: "100m", memory: "100Mi" } },
                    env: [{ name: "GET_HOSTS_FROM", value: "dns" }],
                    ports: [{ containerPort: 6379 }],
                }],
            },
        },
    },
});

const redisReplicaService = new k8s.core.v1.Service("redis-replica", {
    metadata: {
        name: "redis-replica",
        labels: redisReplicaDeployment.metadata.labels,
    },
    spec: {
        ports: [{ port: 6379, targetPort: 6379 }],
        selector: redisReplicaDeployment.spec.template.metadata.labels,
    },
});

// ─────────────────────────────────────────────────────────────────
// FRONTEND  (original + prometheus scrape annotations added)
// ─────────────────────────────────────────────────────────────────
const frontendLabels = { app: "frontend" };
const frontendDeployment = new k8s.apps.v1.Deployment("frontend", {
    spec: {
        selector: { matchLabels: frontendLabels },
        replicas: 3,
        template: {
            metadata: {
                labels: frontendLabels,
                // ← ADDED: tells Prometheus to scrape this pod
                annotations: {
                    "prometheus.io/scrape": "true",
                    "prometheus.io/port":   "80",
                    "prometheus.io/path":   "/metrics",
                },
            },
            spec: {
                containers: [{
                    name:  "frontend",
                    image: "pulumi/guestbook-php-redis",
                    resources: { requests: { cpu: "100m", memory: "100Mi" } },
                    env: [{ name: "GET_HOSTS_FROM", value: "dns" }],
                    ports: [{ containerPort: 80 }],
                }],
            },
        },
    },
});


const frontendService = new k8s.core.v1.Service("frontend", {
    metadata: {
        labels: frontendDeployment.metadata.labels,
        name: "frontend",
    },
    spec: {
        type: "NodePort",
        ports: [{ port: 80, targetPort: 80, nodePort: 30080 }],
        selector: frontendDeployment.spec.template.metadata.labels,
    },
});
// ─────────────────────────────────────────────────────────────────
// MONITORING NAMESPACE  (new)
// ─────────────────────────────────────────────────────────────────
const monitoringNamespace = new k8s.core.v1.Namespace("monitoring", {
    metadata: { name: "monitoring" },
});

// ─────────────────────────────────────────────────────────────────
// PROMETHEUS  (new — deployed via Helm)
// ─────────────────────────────────────────────────────────────────
const prometheus = new k8s.helm.v3.Release("prometheus", {
    chart:           "kube-prometheus-stack",
    version:         "58.2.2",
    namespace:       "monitoring",
    repositoryOpts: {
        repo: "https://prometheus-community.github.io/helm-charts",
    },
    values: {
        // Lightweight settings for local k3d cluster
        prometheus: {
            prometheusSpec: {
                // Scrape pods with prometheus.io/scrape: "true" annotation
                podMonitorSelectorNilUsesHelmValues:     false,
                serviceMonitorSelectorNilUsesHelmValues: false,
                additionalScrapeConfigs: [{
                    job_name:        "guestbook-frontend",
                    kubernetes_sd_configs: [{ role: "pod" }],
                    relabel_configs: [
                        {
                            source_labels: ["__meta_kubernetes_pod_annotation_prometheus_io_scrape"],
                            action:        "keep",
                            regex:         "true",
                        },
                        {
                            source_labels: ["__meta_kubernetes_pod_annotation_prometheus_io_path"],
                            action:        "replace",
                            target_label:  "__metrics_path__",
                            regex:         "(.+)",
                        },
                        {
                            source_labels: ["__address__", "__meta_kubernetes_pod_annotation_prometheus_io_port"],
                            action:        "replace",
                            regex:         "([^:]+)(?::\\d+)?;(\\d+)",
                            replacement:   "$1:$2",
                            target_label:  "__address__",
                        },
                    ],
                }],
            },
        },
        // Disable heavy components not needed for this exercise
        alertmanager:     { enabled: false },
        grafana:          { enabled: false }, // we deploy Grafana separately below
        nodeExporter:     { enabled: true  },
        kubeStateMetrics: { enabled: true  },
    },
}, { dependsOn: [monitoringNamespace] });

// ─────────────────────────────────────────────────────────────────
// GRAFANA  (new — deployed via Helm, exposed as NodePort for k3d)
// ─────────────────────────────────────────────────────────────────
const grafanaAdminPassword = "SRElab2024!";

const grafana = new k8s.helm.v3.Release("grafana", {
    chart:     "grafana",
    version:   "7.3.7",
    namespace: "monitoring",
    repositoryOpts: {
        repo: "https://grafana.github.io/helm-charts",
    },
    values: {
        adminPassword: grafanaAdminPassword,
        service: {
            type:     "NodePort",
            nodePort: 30300,
        },
        // Pre-configure Prometheus as a datasource
        datasources: {
            "datasources.yaml": {
                apiVersion: 1,
                datasources: [{
                    name:      "Prometheus",
                    type:      "prometheus",
                    url:       "http://prometheus-kube-prometheus-prometheus.monitoring.svc.cluster.local:9090",
                    access:    "proxy",
                    isDefault: true,
                }],
            },
        },
        // Stretch goal — pre-load a Guestbook dashboard
        dashboardProviders: {
            "dashboardproviders.yaml": {
                apiVersion: 1,
                providers: [{
                    name:            "default",
                    orgId:           1,
                    folder:          "Guestbook",
                    type:            "file",
                    disableDeletion: false,
                    options: {
                        path: "/var/lib/grafana/dashboards/default",
                    },
                }],
            },
        },
        dashboards: {
            default: {
                guestbook: {
                    json: JSON.stringify({
                        title: "Guestbook Application",
                        panels: [
                            {
                                title:      "Frontend Pod CPU Usage",
                                type:       "graph",
                                gridPos:    { h: 8, w: 12, x: 0, y: 0 },
                                targets: [{
                                    expr:         "rate(container_cpu_usage_seconds_total{pod=~'frontend.*'}[5m])",
                                    legendFormat: "{{pod}}",
                                }],
                            },
                            {
                                title:   "Frontend Pod Memory Usage",
                                type:    "graph",
                                gridPos: { h: 8, w: 12, x: 12, y: 0 },
                                targets: [{
                                    expr:         "container_memory_usage_bytes{pod=~'frontend.*'}",
                                    legendFormat: "{{pod}}",
                                }],
                            },
                            {
                                title:   "Redis Leader CPU",
                                type:    "graph",
                                gridPos: { h: 8, w: 12, x: 0, y: 8 },
                                targets: [{
                                    expr:         "rate(container_cpu_usage_seconds_total{pod=~'redis-leader.*'}[5m])",
                                    legendFormat: "{{pod}}",
                                }],
                            },
                            {
                                title:   "HTTP Requests Rate",
                                type:    "graph",
                                gridPos: { h: 8, w: 12, x: 12, y: 8 },
                                targets: [{
                                    expr:         "rate(http_requests_total{job='guestbook-frontend'}[5m])",
                                    legendFormat: "{{method}} {{status}}",
                                }],
                            },
                        ],
                        schemaVersion: 16,
                        version:       1,
                    }),
                },
            },
        },
        // Lightweight resource settings
        resources: {
            requests: { cpu: "100m", memory: "128Mi" },
            limits:   { cpu: "200m", memory: "256Mi" },
        },
    },
}, { dependsOn: [monitoringNamespace, prometheus] });

// ─────────────────────────────────────────────────────────────────
// EXPORTS  (coding exercise requirement)
// ─────────────────────────────────────────────────────────────────

// Original export
export const frontendUrl = pulumi.interpolate`http://localhost:30080`;

// New monitoring exports
export const grafanaUrl      = pulumi.interpolate`http://localhost:30300`;
export const grafanaUser     = "admin";
export const grafanaPassword = grafanaAdminPassword;
export const prometheusUrl   = pulumi.interpolate`http://localhost:9090`;