---
title: 'Data sources in Terraform'
description: 'What a data source is in Terraform, how its reading works internally (plan or apply), and why an explicit depends_on is sometimes needed.'
pubDate: 2026-07-28T12:00:00
tags: ['terraform', 'iac', 'data-sources']
---

> **Note:** This post was written in Spanish and translated into English with AI assistance. [Read the original](/blog/terraform-data-sources/).

The [previous post](/blog/infraestructura-mutable-vs-inmutable/) covered the `lifecycle` block and why Terraform replaces resources instead of modifying them. This one is about something different: reading, with the `data` block, information that Terraform doesn't manage.

## What a data source is

Every lab so far has been built on resources that Terraform creates and controls end to end: you declare them, they show up in the state, and if you delete them from the `.tf` Terraform destroys them. But not everything a configuration needs was created by Terraform. It could be a file someone wrote by hand, a bucket another team provisioned, or the output of a script that runs outside the `apply`.

A `data` block reads that kind of information without trying to manage it. It looks like a `resource` in syntax, but it doesn't create or destroy anything: it only queries and exposes the attributes it returns, so the rest of the configuration can use them.

```hcl
data "local_file" "manual_note" {
  filename = "${path.module}/external/office-notice.txt"
}
```

`external/office-notice.txt` isn't created by Terraform, it's a file that already exists in the repo before anything runs. `data.local_file.manual_note.content` exposes its content for use anywhere, for example in a regular `local_file`:

```hcl
resource "random_pet" "office" {
  length    = 2
  separator = "-"
}

resource "local_file" "notice" {
  filename = "${path.module}/notice.txt"
  content  = "${data.local_file.manual_note.content}\nOffice pet of the month: ${random_pet.office.id}"
}
```

## How reading works: plan or apply

`data.local_file.manual_note` doesn't depend on any resource, so Terraform can read it as soon as `plan` starts, before it even refreshes the rest of the state:

```console
$ terraform plan
data.local_file.manual_note: Reading...
data.local_file.manual_note: Read complete after 0s [id=851aa948bd3298e2b35bb52de6520c2c5994b02c]
random_pet.office: Refreshing state... [id=workable-serval]
local_file.notice: Refreshing state... [id=3c1ff6d0c2cbb035871b37f6fbc7c14b8c3323ec]
null_resource.audit_log: Refreshing state... [id=4088150487710460202]
data.local_file.audit_entry: Reading...
data.local_file.audit_entry: Read complete after 0s [id=9f6eef55d5ecd61d632c2751227184d337ca97f7]

No changes. Your infrastructure matches the configuration.
```

That only works if every argument in the `data` block is a value Terraform already knows without creating anything. If one of them depends on an attribute that only exists after an `apply` (a generated id, an IP assigned when an instance is created), Terraform can't resolve the data source during plan and defers the read to apply. The lab has a second data source that forces exactly that case, because its path includes the id `random_pet` generates:

```hcl
data "local_file" "audit_entry" {
  filename   = "${path.module}/audit/audit-${random_pet.office.id}.log"
  depends_on = [null_resource.audit_log]
}
```

On a `plan` against fresh infrastructure, Terraform marks it like this:

```console
  # data.local_file.audit_entry will be read during apply
  # (config refers to values not yet known)
 <= data "local_file" "audit_entry" {
      + content  = (known after apply)
      + filename = (known after apply)
      + id       = (known after apply)
        # (6 unchanged attributes hidden)
    }
```

The comment `(config refers to values not yet known)` is literal: the path can't be computed until `random_pet.office` has an id, so the read is postponed to apply, at the same point where Terraform would resolve any other pending value.

## When a data source needs `depends_on`

`null_resource.audit_log` simulates something that happens outside Terraform's dependency graph: a `local-exec` that writes an audit file when the pet is created.

```hcl
resource "null_resource" "audit_log" {
  triggers = {
    pet = random_pet.office.id
  }

  provisioner "local-exec" {
    command = "mkdir -p ${path.module}/audit && printf 'audit entry for %s\\n' '${random_pet.office.id}' > ${path.module}/audit/audit-${random_pet.office.id}.log"
  }
}
```

The path in `data.local_file.audit_entry` already includes `random_pet.office.id`, so Terraform knows it has to wait for the pet to exist. What it can't infer is that the file itself is written by `null_resource.audit_log`: there's no attribute from that resource in the `data` block, so there's no implicit dependency on it. Without `depends_on`, Terraform starts reading the data source in parallel with the `null_resource` being created, and the file might not exist yet:

```console
$ terraform apply
random_pet.office: Creating...
random_pet.office: Creation complete after 0s [id=fancy-beetle]
data.local_file.audit_entry: Reading...
null_resource.audit_log: Creating...
null_resource.audit_log: Provisioning with 'local-exec'...
null_resource.audit_log (local-exec): Executing: ["/bin/sh" "-c" "mkdir -p ./audit && printf 'audit entry for %s\n' 'fancy-beetle' > ./audit/audit-fancy-beetle.log"]
local_file.notice: Creating...
null_resource.audit_log: Creation complete after 0s [id=6557584006655975306]
local_file.notice: Creation complete after 0s [id=c81deaa15b5acebe4672f1b3d9e587da0b781d41]

Error: Read local file data source error

  with data.local_file.audit_entry,
  on main.tf line 33, in data "local_file" "audit_entry":
  33: data "local_file" "audit_entry" {

The file at given path cannot be read.

Original Error: open ./audit/audit-fancy-beetle.log: no such file or
directory
```

`data.local_file.audit_entry: Reading...` starts before `null_resource.audit_log` finishes writing the file. Adding `depends_on = [null_resource.audit_log]` to the data source makes Terraform wait for the `null_resource` to complete before attempting the read:

```console
$ terraform apply
random_pet.office: Creating...
random_pet.office: Creation complete after 0s [id=workable-serval]
null_resource.audit_log: Creating...
null_resource.audit_log: Provisioning with 'local-exec'...
null_resource.audit_log (local-exec): Executing: ["/bin/sh" "-c" "mkdir -p ./audit && printf 'audit entry for %s\n' 'workable-serval' > ./audit/audit-workable-serval.log"]
local_file.notice: Creating...
null_resource.audit_log: Creation complete after 0s [id=4088150487710460202]
local_file.notice: Creation complete after 0s [id=3c1ff6d0c2cbb035871b37f6fbc7c14b8c3323ec]
data.local_file.audit_entry: Reading...
data.local_file.audit_entry: Read complete after 0s [id=9f6eef55d5ecd61d632c2751227184d337ca97f7]

Apply complete! Resources: 3 added, 0 changed, 0 destroyed.
```

`depends_on` on a data source only guarantees ordering: that Terraform won't attempt the read until the resource it depends on has finished. It doesn't guarantee that what it finds is what you expect. If the `null_resource`'s script had failed silently or written an empty file, `depends_on` wouldn't have caught it, it only avoids the race between the write and the read. Use it only for that specific case: when the file or resource the data source reads is created by something else (a script, a `local-exec`) that doesn't leave a trace in any attribute. Adding it without need hides real dependencies and makes the graph harder to read.

## Summary

- `data` reads information Terraform doesn't manage; it doesn't create or destroy anything, it only exposes attributes.
- If every argument of the data source is known without creating anything, Terraform reads it during plan, before refreshing the rest of the state.
- If an argument depends on an attribute that only exists after an apply, the read is deferred to apply.
- Referencing an attribute in the data source is enough for Terraform to infer the order; depending on a side effect with no attribute (a script, a `local-exec`) needs an explicit `depends_on`.
- `depends_on` on a data source only ensures ordering, not that the result is correct.

The full lab is in the [terraform-zero-to-hero](https://github.com/sermanes/terraform-zero-to-hero) repository, under `labs/08-data-sources`.
