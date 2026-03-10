# Deployment and validation

## Cluster prerequisites

Install these first:

- OpenShift GitOps
- KEDA

OpenShift Pipelines is no longer required for this simplified demo.

## Automated bootstrap

From the repo root:

```bash
chmod +x bootstrap.sh
export GIT_URL="https://github.com/YOUR_ORG/ocp-mqtt-demo.git"
export GIT_BRANCH="main"
./bootstrap.sh
```

## What the script does

- creates the three application namespaces
- labels the namespaces for OpenShift GitOps management
- creates a fallback `argocd-admin` RoleBinding in each app namespace
- creates an explicit `argocd-limitrange-manager` Role and RoleBinding in each app namespace
- patches repo URLs and namespace placeholders
- applies the Argo CD Applications

## GitOps namespace permissions

The most common failure mode for this demo is Argo CD lacking permission to create resources in `mqtt-demo-dev`, `mqtt-demo-test`, or `mqtt-demo-prod`.

The bootstrap script now handles this automatically by:

- labeling each namespace with `argocd.argoproj.io/managed-by=openshift-gitops`
- creating a fallback RoleBinding named `argocd-admin` in each namespace for the Argo CD application controller service account
- creating a dedicated `argocd-limitrange-manager` Role and RoleBinding in each namespace for `LimitRange` management

That covers objects such as:

- `Deployment`
- `Service`
- `Route`
- `NetworkPolicy`
- `LimitRange`
- `ScaledObject`

You can verify the most common failing permission like this:

```bash
oc auth can-i create limitranges \
  --as system:serviceaccount:openshift-gitops:openshift-gitops-argocd-application-controller \
  -n mqtt-demo-dev
```

Expected result:

```bash
yes
```

## Validation commands

```bash
oc get applications -n openshift-gitops
oc get all -n mqtt-demo-dev
oc get route frontend -n mqtt-demo-dev -o jsonpath='{.spec.host}{"\n"}'
oc get networkpolicy -n mqtt-demo-dev
oc get limits,resourcequota -n mqtt-demo-dev
oc get scaledobject,hpa -n mqtt-demo-dev
oc auth can-i create limitranges --as system:serviceaccount:openshift-gitops:openshift-gitops-argocd-application-controller -n mqtt-demo-dev
oc rollout status deploy/frontend -n mqtt-demo-dev
oc rollout status deploy/api -n mqtt-demo-dev
oc rollout status deploy/broker-a -n mqtt-demo-dev
```

## Demo usage

1. Open the frontend route in the dev namespace.
2. Send 10 or 25 messages to one broker.
3. Watch the queue count rise in the UI.
4. Check the corresponding HPA and pods to see KEDA react.
5. Purge a broker queue from the UI and watch the count drop.

## Common troubleshooting

### Argo CD reports permission errors

Check whether the namespace is labeled for GitOps management and whether the fallback RoleBinding exists:

```bash
oc get ns mqtt-demo-dev --show-labels
oc get rolebinding argocd-admin -n mqtt-demo-dev -o yaml
oc get rolebinding argocd-limitrange-manager -n mqtt-demo-dev -o yaml
oc get role argocd-limitrange-manager -n mqtt-demo-dev -o yaml
```

Re-check the permission explicitly:

```bash
oc auth can-i create limitranges \
  --as system:serviceaccount:openshift-gitops:openshift-gitops-argocd-application-controller \
  -n mqtt-demo-dev
```

If that still returns `no`, rerun `./bootstrap.sh` and then verify the dedicated `argocd-limitrange-manager` role exists in the target namespace.

### Argo CD app syncs but the UI cannot send messages

Check the API pod logs:

```bash
oc logs deploy/api -n mqtt-demo-dev
```

The API uses direct TCP connections to Redis and the MQTT brokers, so failures are usually caused by pod startup, NetworkPolicy issues, or image pull restrictions.

### Route opens but the cards never refresh

Confirm the frontend can reach the API service:

```bash
oc get svc api -n mqtt-demo-dev
oc get networkpolicy -n mqtt-demo-dev
```

### Broker scaling looks odd

For demo purposes, KEDA scales the broker deployments from Redis queue depth telemetry, not from native broker clustering metrics.


Frontend note: the frontend deployment now runs nginx with an OpenShift-friendly non-root configuration, stores temp files under `/tmp`, and mounts writable `emptyDir` volumes for nginx runtime paths.


### Redis reports MISCONF / snapshot errors

This demo now configures Redis for ephemeral demo usage by disabling RDB snapshots and append-only persistence. If you still see an older Redis pod behavior, resync Argo CD or restart the Redis deployment:

```bash
oc rollout restart deploy/redis -n mqtt-demo-dev
oc rollout status deploy/redis -n mqtt-demo-dev
```

### Sending messages only affects one broker

The UI now supports three modes:

- `single broker`
- `all brokers`
- `round robin`

Use `all brokers` when you want each broker to receive the selected message count.


## KEDA Redis address

The `ScaledObject` resources use namespace-qualified Redis service addresses:

- `redis.mqtt-demo-dev.svc.cluster.local:6379`
- `redis.mqtt-demo-test.svc.cluster.local:6379`
- `redis.mqtt-demo-prod.svc.cluster.local:6379`

This avoids DNS resolution failures from the KEDA operator when using a short hostname like `redis:6379`.


## KEDA Redis connectivity

This demo includes a `NetworkPolicy` named `allow-keda-to-redis` so KEDA in the `openshift-keda` namespace can reach the Redis service on TCP 6379. Without it, the `ScaledObject` readiness can fail with a Redis connection timeout.


## Faster scale-down after purge

This package includes two scale-down improvements:

1. The API purge endpoint deletes the Redis list for the selected broker, which is the metric KEDA is actually watching.
2. The `ScaledObject` definitions use a shorter polling interval and more aggressive HPA scale-down behavior.

After purging, allow a short period for KEDA and the generated HPA to observe the lower metric and reduce replicas.


## Latest architecture update

- MQTT brokers stay fixed at 1 replica each.
- KEDA now scales dedicated queue worker deployments (`worker-a`, `worker-b`, `worker-c`) from Redis queue depth.
- The UI now shows queue depth, active queue workers, and processed message counts per broker.
- Purge clears the Redis queue that KEDA watches, so workers can scale back down normally.

Worker scaling notes:
- workers intentionally process messages with a short delay so scale-out is visible in the UI
- KEDA/HPA scale-down is deliberately slower to reduce pod churn during demos


## Visual scaling behavior

This package now uses KEDA `ScaledJob` workers. You should expect to see worker Job pods appear when queue depth crosses the activation threshold, remain running while they process a small batch, and then complete once the queue drops. The UI active worker count is based on short-lived Redis heartbeats from running worker jobs.


This build also sets the API and worker jobs to use namespace-qualified Redis DNS names by default.


## Notes for this rebuild

This rebuild fixes the worker ScaledJob overlays so environment-specific Redis values are patched without replacing the full worker container spec.
