# OpenShift MQTT Demo

An interactive OpenShift demo application designed for GitOps with Argo CD, without any pipeline dependency.

## What it demonstrates

- Front-end web app to send messages to one broker, all brokers, or round-robin across brokers
- Live queue counts per broker
- Delete / purge queued messages per broker
- OpenShift Routes, Services, Deployments, resource requests/limits, probes, and NetworkPolicies
- KEDA autoscaling for broker deployments at a queue depth threshold of 10
- Argo CD Applications for dev, test, and prod
- Simple GitOps deployment with no Tekton or image build step required

## Important demo note

The MQTT brokers are real Mosquitto containers. The queue depth shown in the UI, and used for KEDA scaling, is tracked in Redis by the API service. That keeps the demo visual and deterministic while still showing actual MQTT publish activity.

The frontend and API are both packaged directly into Kubernetes manifests using ConfigMaps plus standard public container images. That means the repo can be synced on a fresh cluster immediately, with no pipeline, no build stage, and no internal-registry bootstrap problem.

## Layout

- `deploy/base` – common Kubernetes / OpenShift manifests
- `deploy/overlays/dev|test|prod` – environment overlays
- `deploy/applications` – Argo CD Applications
- `bootstrap.sh` – automated bootstrap script
- `docs/DEPLOYMENT.md` – detailed deployment instructions and troubleshooting
- `apps/` – optional reference source versions of the frontend and API, not required for deployment

## Quick start

1. Push this repo to your Git server.
2. Export your repo URL.
3. Run `./bootstrap.sh`.

The bootstrap script now also labels the target namespaces for OpenShift GitOps management and creates a fallback `admin` RoleBinding for the Argo CD application controller in each app namespace, plus an explicit `argocd-limitrange-manager` Role and RoleBinding for `LimitRange` objects.

Example:

```bash
chmod +x bootstrap.sh
export GIT_URL="https://github.com/YOUR_ORG/ocp-mqtt-demo.git"
export GIT_BRANCH="main"
./bootstrap.sh
```

## Default namespaces

- `mqtt-demo-dev`
- `mqtt-demo-test`
- `mqtt-demo-prod`

## GitOps permissions

OpenShift GitOps needs permission to manage resources in the target namespaces. The bootstrap script now does two things automatically:

- labels each target namespace with `argocd.argoproj.io/managed-by=openshift-gitops`
- creates a fallback `argocd-admin` RoleBinding that binds the Argo CD application controller service account to the built-in `admin` ClusterRole in each target namespace
- creates an explicit `argocd-limitrange-manager` Role and RoleBinding in each target namespace so Argo CD can manage `LimitRange` objects even where `admin` is insufficient

That avoids common Argo CD sync failures for resources such as `LimitRange`, `Route`, `NetworkPolicy`, `Deployment`, and `ScaledObject`.

## Validation

```bash
oc get applications -n openshift-gitops
oc get all -n mqtt-demo-dev
oc get route frontend -n mqtt-demo-dev
oc get scaledobject -n mqtt-demo-dev
oc get hpa -n mqtt-demo-dev
oc auth can-i create limitranges --as system:serviceaccount:openshift-gitops:openshift-gitops-argocd-application-controller -n mqtt-demo-dev
```


Frontend note: the frontend deployment now runs nginx with an OpenShift-friendly non-root configuration, stores temp files under `/tmp`, and mounts writable `emptyDir` volumes for nginx runtime paths.


Redis note: this demo now runs Redis with snapshot persistence disabled so queue-count writes do not fail on ephemeral demo storage.


## KEDA Redis DNS note

This package pins each environment's KEDA Redis trigger to the fully qualified service DNS name (`redis.<namespace>.svc.cluster.local:6379`) so the scaler can resolve Redis correctly from outside the application namespace.


## KEDA Redis connectivity

This demo includes a `NetworkPolicy` named `allow-keda-to-redis` so KEDA in the `openshift-keda` namespace can reach the Redis service on TCP 6379. Without it, the `ScaledObject` readiness can fail with a Redis connection timeout.


## Faster scale-down after purge

This package now clears the Redis-backed queue key during a purge and configures each `ScaledObject` with more aggressive HPA scale-down behavior:
- `pollingInterval: 15`
- `cooldownPeriod: 30`
- HPA scale-down stabilization window of 30 seconds

Because KEDA in this demo scales from Redis list length, scaling down depends on the Redis queue key dropping back to `0`.


## Latest architecture update

- MQTT brokers stay fixed at 1 replica each.
- KEDA now scales dedicated queue worker deployments (`worker-a`, `worker-b`, `worker-c`) from Redis queue depth.
- The UI now shows queue depth, active queue workers, and processed message counts per broker.
- Purge clears the Redis queue that KEDA watches, so workers can scale back down normally.

Worker scaling notes:
- workers intentionally process messages with a short delay so scale-out is visible in the UI
- KEDA/HPA scale-down is deliberately slower to reduce pod churn during demos


## Worker scaling model

This version uses KEDA `ScaledJob` resources for the queue workers instead of scaling long-lived worker Deployments. That gives a more visual demo on OpenShift: when queue depth rises, worker Job pods appear and process messages in small batches, then complete and disappear once the backlog is gone.

Recommended demo queue sizes:
- 30 to 60 messages for one broker
- 60 to 120 messages in round-robin mode

Each worker job processes a small batch slowly on purpose so scale-out is visible in the UI and in the OpenShift console.


This build also sets the API and worker jobs to use namespace-qualified Redis DNS names by default.

