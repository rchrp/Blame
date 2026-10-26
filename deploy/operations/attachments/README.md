# Production attachment storage

Use the private `blame-prod-attachments-gra` bucket in Gravelines. Keep it separate from both the backup bucket and `blame-prod-workspace-gra`: conversation attachments follow message, project, and account deletion, while managed preview workspaces have their own short retention and security policy.

Configure the API with the `ATTACHMENTS_*` variables documented in `packages/api/.env.example`. The S3 credentials require permission to read, write, inspect, and delete objects only inside this bucket. Do not expose these credentials to the desktop application.

Apply the bucket CORS configuration before enabling direct uploads:

```sh
aws --endpoint-url "$ATTACHMENTS_S3_ENDPOINT" s3api put-bucket-cors \
  --bucket "$ATTACHMENTS_S3_BUCKET" \
  --cors-configuration "file://$PWD/deploy/operations/attachments/ovh-s3-cors.json"
```

The wildcard origin is required by packaged desktop renderers whose origin is not a stable HTTPS origin. Upload URLs are short-lived, object-specific, and signed. Browser clients never receive the S3 credentials.

The policy must allow **all** headers in the signed PUT, including
`x-amz-checksum-sha256` and `x-amz-server-side-encryption`. A policy allowing only
`content-type` and `x-amz-meta-checksum-sha256` rejects the browser preflight and
surfaces as `Failed to fetch`, even when local previews work. Check OPTIONS with
the complete header list after changing the signing configuration.

If a direct PUT fails at the network/CORS layer, clients retry once through the
authenticated `POST /attachments/:id/content` API. It accepts only the original
bytes for an upload already owned by the user, verifies its size and SHA-256,
and uses the same encrypted object storage. No attachment content is kept in
the database. Correct bucket CORS remains preferable to avoid proxying bytes.

Keep public access disabled. Do not apply the backup bucket's 80-day expiration policy to this bucket. The hourly `accounts:purge-closed` operation removes unattached objects after the configured grace period. Bucket lifecycle rules may independently abort incomplete multipart uploads, but must not expire attached objects.

Deploy in this order:

1. Apply the bucket CORS configuration.
2. Add the production `ATTACHMENTS_*` values to the API service.
3. Run database migrations.
4. Deploy the API and desktop client.
5. Run `node ace attachments:migrate-to-s3`.
6. Run the command again and verify it reports no remaining owners.
7. Verify creation, display, agent consumption, account export, message undo, and account deletion.

The application continues to read legacy inline attachments and accepts inline uploads from older desktop clients during the rollout. Keep the legacy JSON columns until every production row has been migrated and supported old clients have aged out.
