---
name: Vector Sigma GHCR image exposure remediation plan
about: Review the plan for correcting deployment metadata in public images and retiring old artifacts.

title: "docs: plan Vector Sigma image cleanup"
labels: documentation, security
assignees: ""
---

## Review request

Please review [`docs/ghcr-image-exposure-plan.md`](../blob/main/docs/ghcr-image-exposure-plan.md) for technical correctness and completeness before implementation.

This is a plan-only PR. It does not change images, publish/delete GHCR artifacts, rotate credentials, or change balena deployments. The owner has said a full VS redeploy is acceptable if needed, but persistent data must be inventoried and deliberately preserved or backed up before a destructive path.

Key review questions:
- Is the boundary between portable application/queue contracts and deployment-specific topology correct?
- Is the runtime config approach feasible with balena Supervisor constraints, especially `extra_hosts` and the Tailscale serve config?
- Are image/package inventory, layer inspection, rollout, persistence, rollback, and GHCR retirement gates complete?

The current GHCR package list, versions, visibility, download counts, and external consumers must be verified before deletion targets are named. No rollout/deletion is authorized by this document.
