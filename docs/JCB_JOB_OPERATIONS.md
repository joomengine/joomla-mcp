# JCB job storage and recovery

An MCP client can inspect a job and download its verified artifacts using the
same site alias and authenticated principal that submitted it. Job status and
artifact reads leave grants, claims and files untouched. An operator who
manages the service host can also inspect the private job directory.

The server derives the job ID from the **site alias, principal and idempotency
key**. Reusing that combination returns the original receipt, including after
restart. A different principal, or a different alias for the same Joomla
installation, represents a separate submission. Configure one canonical alias
for each writable installation and use the same job directory for every
process serving that alias. All principals on that alias share its execution
claim.

## Inspect an outstanding claim

The following Bash commands use the `builder` alias and directory from the
[JCB setup example](JCB.md). Run them as the service account on its host. Enter
the 64-character job ID shown by `joomla_write_apply` or
`joomla_jcb_job_get`. The commands read the selected receipt and claim.

```bash
set -euo pipefail
job_root=/var/lib/joomla-mcp/jcb-jobs
site_alias=builder
read -rp 'JCB job ID: ' job_id
[[ "$job_id" =~ ^[0-9a-f]{64}$ ]]
job_dir="$job_root/$job_id"
receipt="$job_dir/job.json"
site_hash="$(printf '%s' "$site_alias" | sha256sum | cut -d' ' -f1)"
claim="$job_root/active-$site_hash"
jq -e --arg site "$site_alias" --arg id "$job_id" '
  select(.site == $site and .jobId == $id) |
  {site,jobId,action,status,workerHost,workerPid,createdAt,updatedAt,outcome,failurePhase,reasonCode,message}
' "$receipt"
if [[ -f "$claim" ]]; then
  jq '{site,kind,jobId,action,workerHost,workerPid,createdAt}' "$claim"
fi
```

If available, `failurePhase` identifies preflight, native dispatch or archive
retention. The bounded `reasonCode` can distinguish a native error such as
`JCB_ARCHIVE_MISSING` from a transport timeout (`CLI_TIMEOUT`). Original PHP
output, paths and credentials stay outside the job receipt.

A JCB claim points to the initial receipt. Its queued status reflects when the
claim was taken. Read `job.json` for subsequent progress. A claim with
`kind: "write"` belongs to a synchronous Joomla write and has no JCB job ID.
A different job ID identifies another operator’s work on the same alias.

## Reconcile an interrupted command

1. Stop admission and stop all service instances and local stdio clients that
   can write this alias. On the recorded worker host, confirm that both Node
   and the PHP compiler/package command have exited. A stopped Node process
   alone is insufficient to establish that its PHP child has exited.
2. Record the job ID, original plan, command, and evidence. For a compile,
   check the produced ZIP and manifest. For package operations, compare the
   selected definitions and linked records in Joomla with the configured
   repository, branch and commit. Record which effects happened, including any
   partial changes. An `uncertain` result can follow a completed mutation.
3. With writers still stopped, use the block below to release this job’s claim
   after reconciliation. It first checks both identities and the receipt
   state. A mismatch or missing claim stops the sequence. If writers are
   already stopped and the claim belongs to a synchronous write, investigate
   that separate operation using its audit events.

```bash
(
  set -euo pipefail
  [[ -f "$receipt" && ! -L "$receipt" && -f "$claim" && ! -L "$claim" ]]
  jq -e --arg site "$site_alias" --arg id "$job_id" '
    .site == $site and .jobId == $id and
    (.status == "uncertain" or .status == "queued" or .status == "running")
  ' "$receipt" >/dev/null
  jq -e --arg site "$site_alias" --arg id "$job_id" '
    .site == $site and .jobId == $id
  ' "$claim" >/dev/null
  read -rp 'Re-enter the reconciled job ID to release its execution claim: ' confirmed
  [[ "$confirmed" == "$job_id" ]]
  rm -- "$claim"
)
```

Keep the receipt and reconciliation evidence. Releasing the claim permits
other writes on the alias. It leaves the original job outcome and
idempotency key intact. If the intended changes still need to be made, inspect
current state and obtain a fresh plan and operator approval.

## Retain receipts and rotate successful ZIPs

Give the job directory a storage quota or dedicated filesystem, monitor both
free bytes and inodes, and reserve space for an in-flight compile and its
retained copy. A full volume can prevent recording the outcome of native work.
Track private storage growth with `du -sh "$job_root"`, `df -h "$job_root"`
and `df -i "$job_root"`. Set the archive retention period to match your
operators’ download window and backup policy. Each durable receipt preserves
the owner, command fingerprint and idempotency claim. Removing a complete job
directory discards that replay protection.

To free space for one completed compile, select it with the inspection block
above. Check that its users have finished downloading it and stop writers and
downloads for the maintenance window. The following Bash block archives only
the ZIPs listed on a **succeeded, verified compile**. Supply an existing
private archive directory on a separate volume. The block creates a unique
destination, verifies each archived copy against the original receipt, and
asks for the exact job ID before removing the corresponding local ZIPs.

```bash
(
  set -euo pipefail
  umask 077
  read -rp 'Private archive directory on a separate volume: ' archive_root
  [[ -d "$archive_root" && -w "$archive_root" ]]
  [[ "$(stat -c %d "$archive_root")" != "$(stat -c %d "$job_root")" ]]
  [[ -f "$receipt" && ! -L "$receipt" && ! -e "$claim" ]]
  jq -e --arg site "$site_alias" --arg id "$job_id" '
    .site == $site and .jobId == $id and .action == "jcb.compile.component" and
    .status == "succeeded" and .outcome.verification == "verified" and
    (.outcome.artifacts | length > 0)
  ' "$receipt" >/dev/null
  backup="$(mktemp -d -- "$archive_root/$job_id.XXXXXXXX")"
  cp -- "$receipt" "$backup/job.json"
  jq -r '.outcome.artifacts[] | [.sha256, .name] | @tsv' "$backup/job.json" > "$backup/archives.tsv"
  while IFS=$'\t' read -r hash name; do
    [[ "$hash" =~ ^[a-f0-9]{64}$ && "$name" =~ ^[A-Za-z0-9][A-Za-z0-9._-]*\.[Zz][Ii][Pp]$ ]]
    file="$job_dir/artifacts/$name"
    [[ -f "$file" && ! -L "$file" ]]
    cp -- "$file" "$backup/$name"
    (cd -- "$backup" && printf '%s  %s\n' "$hash" "$name" | sha256sum --check --status -)
  done < "$backup/archives.tsv"
  printf 'Verified archive: %s\n' "$backup"
  read -rp 'Re-enter the archived job ID to remove its local ZIPs: ' confirmed
  [[ "$confirmed" == "$job_id" ]]
  while IFS=$'\t' read -r hash name; do
    rm -- "$job_dir/artifacts/$name"
  done < "$backup/archives.tsv"
)
```

After rotation, clients can still inspect the receipt. Retrieve the ZIP from
the archive to use it again. Keep uncertain jobs, their workspaces and their
claims available for investigation. A status request, a client disconnect or
a retention deadline never authorizes another execution.
