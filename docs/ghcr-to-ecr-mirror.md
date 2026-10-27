# GHCR-to-ECR mirror dry-run

`.github/workflows/mirror-ghcr-to-ecr.yml` validates one promoted arm64 digest
and maps it to a fixed ECR repository name. It does not log in to GHCR/ECR,
assume an AWS role, upload manifests, or issue an ECR write. Do not add runtime
publishing to this workflow; that requires a separate owner-authorized stage
and isolated dev account.

Manually dispatch with a successful `build-images.yml` run ID and attempt from
`main`, plus exactly one component. The workflow checks that run through the
GitHub Actions API, downloads the component's `promoted-<component>` artifact
from that same run and attempt, then verifies the promotion record matches the
selected GHCR repository and has exactly one valid `linux/arm64` digest. The
planner emits JSON containing the source `ghcr.io/cwdcwd/vector-sigma/<component>@sha256:…`,
the explicit target repository, architecture and unchanged digest. Invalid,
missing or ambiguous values fail closed. The action's permissions are limited
to reading repository contents and workflow artifacts.

The source record's registry digest is the immutable identity preserved by a
future copy; this workflow only validates that identity and target mapping.
It does not assert that a real ECR copy has occurred.
