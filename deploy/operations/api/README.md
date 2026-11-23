# Production API

The API runs as a Dokploy application from a container image. GitHub Actions builds the image; the server only pulls it.

| Step                   | Where                                                                   | What happens                                                                                               |
| ---------------------- | ----------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| A push to `main`       | [Deploy API](../../../.github/workflows/deploy-api.yml), job `image`    | Builds [`packages/api/Dockerfile`](../../../packages/api/Dockerfile) and publishes it to `ghcr.io`         |
| The image is published | Same workflow, job `deploy`                                             | Calls Dokploy's API (`POST /api/application.deploy`): Dokploy pulls the image and restarts the application |
| The container starts   | [`packages/api/docker/start.sh`](../../../packages/api/docker/start.sh) | Runs the database migrations, then starts the server                                                       |

The workflow runs when the API, one of its workspace dependencies (`deploy-contract`, `preview-contract`, `preview-runtime`, `speech-contract`), the lockfile or the patches change. To deploy anything else, or again, run **Deploy API** from the Actions tab.

It does not wait for CI. The build is its own gate: an image that does not build is never published. To approve each deployment by hand, add required reviewers to the `api-production` environment.

## Images

| Tag                                | Use                                      |
| ---------------------------------- | ---------------------------------------- |
| `ghcr.io/rchrp/blame-api:latest`   | What Dokploy deploys                     |
| `ghcr.io/rchrp/blame-api:<commit>` | Every published build, to go back to one |

The image carries its commit: `BLAME_API_REVISION` in the container's environment and the `org.opencontainers.image.revision` label.

To go back to an earlier version, set the application's image to that commit's tag in Dokploy and deploy. Set it back to `latest` afterwards, or the next push deploys nothing new. Going back does not undo migrations: an earlier image starts on the newer schema.

## Migrations

`start.sh` runs `node ace.js migration:run --force` before the server. Lucid holds a database lock while it migrates, so several replicas starting together migrate once. If a migration fails, the container stops and Dokploy keeps the previous version.

While a new version starts, the previous one still serves requests on the migrated schema for a moment. A migration that drops what the previous version reads makes those requests fail until the switch.

Set `BLAME_API_MIGRATE_ON_START=false` to run the migrations yourself, for example when restoring a database with ingress closed (see [retention](../retention/README.md)).

## Set up once

In GitHub:

1. Run **Deploy API** once from the Actions tab (or push a change to the API). It publishes the image; the deploy job says Dokploy is not configured yet.
2. Open the `blame-api` package (the repository's **Packages**) → **Package settings**. Either make it public, or keep it private and give Dokploy a registry login (below).
3. In **Settings → Environments → api-production**, add:
   - variable `DOKPLOY_URL`: the address of the Dokploy panel, for example `https://dokploy.example.com`;
   - variable `DOKPLOY_API_APPLICATION_ID`: the API application's id;
   - secret `DOKPLOY_API_KEY`: a key from Dokploy, **Profile → API/CLI Keys → Generate New Key**.

In Dokploy:

1. If the package is private: **Registry → Add**, with `ghcr.io`, your GitHub user name and a classic token with the `read:packages` scope only.
2. In the API application, change the source from the Git repository to **Docker**, image `ghcr.io/rchrp/blame-api:latest` (and the registry, if private). The environment variables, volumes, domains and health check stay as they are.
3. Deploy once from Dokploy to check that the image starts, then run the workflow again: the deploy job must show a new deployment in the application's **Deployments** tab.

The application id is in the application's URL in the panel, or in `GET <DOKPLOY_URL>/api/project.all` with the header `x-api-key: <key>`.

Optional variable `API_IMAGE_PLATFORMS` (repository level): the platforms to build, `linux/amd64` by default. Set it to `linux/arm64`, or both separated by a comma, for an Arm server.
