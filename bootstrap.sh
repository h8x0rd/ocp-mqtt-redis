#!/usr/bin/env bash
set -Eeuo pipefail

GIT_URL="${GIT_URL:-}"
GIT_BRANCH="${GIT_BRANCH:-main}"
DEV_NS="${DEV_NS:-mqtt-demo-dev}"
TEST_NS="${TEST_NS:-mqtt-demo-test}"
PROD_NS="${PROD_NS:-mqtt-demo-prod}"
ARGO_NS="${ARGO_NS:-openshift-gitops}"
ARGO_CONTROLLER_SA="${ARGO_CONTROLLER_SA:-openshift-gitops-argocd-application-controller}"

log(){ printf '\n[%s] %s\n' "$(date +'%H:%M:%S')" "$*"; }
warn(){ printf '\n[WARN] %s\n' "$*" >&2; }
die(){ printf '\n[ERROR] %s\n' "$*" >&2; exit 1; }
need_cmd(){ command -v "$1" >/dev/null 2>&1 || die "Missing required command: $1"; }

apply_path() {
  local ns="${1:-}"
  local path="$2"
  [[ -e "$path" ]] || { warn "Path not found, skipping: $path"; return 0; }

  if [[ -d "$path" ]]; then
    if [[ -f "$path/kustomization.yaml" || -f "$path/kustomization.yml" || -f "$path/Kustomization" ]]; then
      log "Applying kustomize path $path ${ns:+into namespace $ns}"
      if [[ -n "$ns" ]]; then
        oc apply -n "$ns" -k "$path"
      else
        oc apply -k "$path"
      fi
    else
      log "Applying manifest path $path ${ns:+into namespace $ns}"
      if [[ -n "$ns" ]]; then
        oc apply -n "$ns" -f "$path"
      else
        oc apply -f "$path"
      fi
    fi
  else
    log "Applying file $path ${ns:+into namespace $ns}"
    if [[ -n "$ns" ]]; then
      oc apply -n "$ns" -f "$path"
    else
      oc apply -f "$path"
    fi
  fi
}

replace_repo_url() {
  local target="$1"
  [[ -e "$target" ]] || return 0
  grep -RIl "https://github.com/your-org/ocp-mqtt-demo.git" "$target" 2>/dev/null | while read -r file; do
    sed -i "s#https://github.com/your-org/ocp-mqtt-demo.git#${GIT_URL}#g" "$file"
  done
}

patch_namespace_references() {
  local target="$1"
  [[ -e "$target" ]] || return 0
  grep -RIl "mqtt-demo-dev\|mqtt-demo-test\|mqtt-demo-prod" "$target" 2>/dev/null | while read -r file; do
    sed -i "s#mqtt-demo-dev#${DEV_NS}#g; s#mqtt-demo-test#${TEST_NS}#g; s#mqtt-demo-prod#${PROD_NS}#g" "$file"
  done
}

ensure_project() {
  local ns="$1"
  if oc get namespace "$ns" >/dev/null 2>&1; then
    log "Project already exists: $ns"
  else
    log "Creating project: $ns"
    oc new-project "$ns" >/dev/null
  fi
}

wait_for_crd() { oc get crd "$1" >/dev/null 2>&1 || die "Required CRD missing: $1"; }

label_gitops_namespace_management() {
  local ns="$1"
  log "Labeling namespace $ns for OpenShift GitOps management"
  oc label namespace "$ns" argocd.argoproj.io/managed-by="$ARGO_NS" --overwrite >/dev/null
}

ensure_argocd_admin_rolebinding() {
  local ns="$1"
  local rb_name="argocd-admin"

  log "Ensuring Argo CD controller has admin in $ns"
  cat <<EOF_RB | oc apply -f -
apiVersion: rbac.authorization.k8s.io/v1
kind: RoleBinding
metadata:
  name: ${rb_name}
  namespace: ${ns}
subjects:
- kind: ServiceAccount
  name: ${ARGO_CONTROLLER_SA}
  namespace: ${ARGO_NS}
roleRef:
  apiGroup: rbac.authorization.k8s.io
  kind: ClusterRole
  name: admin
EOF_RB
}

ensure_argocd_limitrange_role() {
  local ns="$1"
  local role_name="argocd-limitrange-manager"

  log "Ensuring Argo CD controller has explicit LimitRange permissions in $ns"
  cat <<EOF_LR | oc apply -f -
apiVersion: rbac.authorization.k8s.io/v1
kind: Role
metadata:
  name: ${role_name}
  namespace: ${ns}
rules:
- apiGroups: [""]
  resources: ["limitranges"]
  verbs: ["get", "list", "watch", "create", "update", "patch", "delete"]
---
apiVersion: rbac.authorization.k8s.io/v1
kind: RoleBinding
metadata:
  name: ${role_name}
  namespace: ${ns}
subjects:
- kind: ServiceAccount
  name: ${ARGO_CONTROLLER_SA}
  namespace: ${ARGO_NS}
roleRef:
  apiGroup: rbac.authorization.k8s.io
  kind: Role
  name: ${role_name}
EOF_LR
}

verify_argocd_permission() {
  local ns="$1"
  local resource="$2"
  if oc auth can-i create "$resource" \
    --as "system:serviceaccount:${ARGO_NS}:${ARGO_CONTROLLER_SA}" \
    -n "$ns" >/dev/null 2>&1; then
    local result
    result=$(oc auth can-i create "$resource" \
      --as "system:serviceaccount:${ARGO_NS}:${ARGO_CONTROLLER_SA}" \
      -n "$ns")
    if [[ "$result" == "yes" ]]; then
      log "Verified: Argo CD can create $resource in $ns"
      return 0
    fi
  fi
  warn "Argo CD still cannot create $resource in $ns"
  return 1
}

setup_argocd_namespace_access() {
  local ns="$1"
  label_gitops_namespace_management "$ns"
  ensure_argocd_admin_rolebinding "$ns"
  ensure_argocd_limitrange_role "$ns"

  verify_argocd_permission "$ns" deployments.apps || true
  verify_argocd_permission "$ns" limitranges || true
  verify_argocd_permission "$ns" routes.route.openshift.io || true
  verify_argocd_permission "$ns" scaledobjects.keda.sh || true
}

need_cmd oc
need_cmd grep
need_cmd sed
[[ -n "$GIT_URL" ]] || die "Set GIT_URL, for example: export GIT_URL=https://github.com/YOUR_ORG/ocp-mqtt-demo.git"
[[ -d deploy ]] || die "Run this from the repo root. ./deploy is missing."
oc whoami >/dev/null 2>&1 || die "You are not logged in to OpenShift."
wait_for_crd applications.argoproj.io
wait_for_crd scaledobjects.keda.sh

ensure_project "$DEV_NS"
ensure_project "$TEST_NS"
ensure_project "$PROD_NS"

setup_argocd_namespace_access "$DEV_NS"
setup_argocd_namespace_access "$TEST_NS"
setup_argocd_namespace_access "$PROD_NS"

replace_repo_url deploy
patch_namespace_references deploy
apply_path "" deploy/applications

cat <<EOF2

Bootstrap complete.

Useful commands:
  oc get applications -n ${ARGO_NS}
  oc get all -n ${DEV_NS}
  oc get route frontend -n ${DEV_NS}
  oc get scaledobject,hpa -n ${DEV_NS}
  oc auth can-i create limitranges --as system:serviceaccount:${ARGO_NS}:${ARGO_CONTROLLER_SA} -n ${DEV_NS}
EOF2
