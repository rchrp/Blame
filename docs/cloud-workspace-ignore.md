# Cloud workspace exclusions

The root `.blameignore` controls which project files Blame transfers to cloud previews. It applies to the sanitized Git bundle, source overlays, workspace hashes, live updates, and changes synchronized back from the cloud. Excluded files remain on the computer and keep their local Git tracking.

The syntax follows `.gitignore`, with case-sensitive matching. Rules add to the project's `.gitignore` files and Blame's built-in secret/build exclusions; a `!` exception cannot restore a Git-ignored or forbidden file. Only the root `.blameignore` is read. The control file itself and reachable `.gitignore` files are synchronized so both sides use the same rules.

## Project analysis

Preview Environment analysis receives the existing control file and a bounded inventory of the largest discovered files and directories. The analyst submits `cloudPreviewIgnore` rules with an exact rooted path and an evidence-based reason. It must keep installation inputs, source, scripts, migrations, runtime assets, and other preview dependencies. Size alone does not justify an exclusion.

After an accepted analysis, Blame replaces only the block between `# BEGIN BLAME GENERATED CLOUD EXCLUSIONS` and `# END BLAME GENERATED CLOUD EXCLUSIONS`. It reads the latest file before saving, preserves everything outside that block, and puts generated rules first. A malformed block stops the update without modifying the file. An empty generated list removes only that block. Older analysis results without the field leave the file unchanged.

Put manual rules outside the generated block, preferably below it. They are retained across analyses and take precedence:

```gitignore
# BEGIN BLAME GENERATED CLOUD EXCLUSIONS
# Updated by project analysis. Put manual rules below this block; they take precedence.
# Historical experiment outputs unused by build or runtime.
/experiments/results/**
# END BLAME GENERATED CLOUD EXCLUSIONS
# Manual exceptions and additional exclusions:
!/experiments/results/reference.json
/recordings/
```

Normal Gitignore parent-directory rules apply: to restore a nested file, restore any ignored parent directories too. Using `/experiments/results/**` instead of `/experiments/results/` allows the direct child exception above. Manual content is editable; content inside the generated block belongs to analysis and is regenerated.

Changes to `.blameignore` alter the workspace identity and invalidate incompatible baselines. Adding an exclusion locally removes the corresponding remote copy on the next sync; an exclusion received from the cloud preserves the local original. Concurrent local edits still produce a sync conflict instead of being overwritten.

## Deployment

This behavior uses the versioned `blameignore-v1` snapshot policy. The runner continues to read `legacy` and `gitignore-v1` artifacts, and rejects unknown policies. The API handshake requires support for the current policy instead of letting an old runner produce mismatched hashes.

Publish sandbox runner **0.3.1**, update the API's pinned image to the published digest with the existing runner release workflow, deploy the API, and rebuild the desktop application. The source version bump does not publish an image or change the current API pin. An older runner cannot run new-policy workspaces.
