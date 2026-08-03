---
title: 'Provisioners in Terraform'
description: 'What creation-time and destroy-time provisioners do, what happens when they fail, and why HashiCorp treats them as a last resort compared to each provider''s native alternatives.'
pubDate: 2026-07-30T12:00:00
tags: ['terraform', 'iac', 'provisioners']
---

> **Note:** This post was written in Spanish and translated into English with AI assistance. [Read the original](/blog/terraform-provisioners/).

The [previous post](/blog/terraform-count-for-each/) covered `count` and `for_each`. This one is different: instead of a mechanism for managing resources, a provisioner runs a command when a resource is created or destroyed. HashiCorp recommends using them only when there's no other option, and it's worth understanding why before reaching for them.

## Creation-time provisioner

`provisioner "local-exec"` runs a command on the machine executing Terraform (not on the resource itself), right after it's created:

```hcl
resource "null_resource" "bootstrap" {
  provisioner "local-exec" {
    command = "echo 'bootstrap started' > ${path.module}/bootstrap.log"
  }
}
```

```console
$ terraform apply
null_resource.bootstrap: Creating...
null_resource.bootstrap: Provisioning with 'local-exec'...
null_resource.bootstrap (local-exec): Executing: ["/bin/sh" "-c" "echo 'bootstrap started' > ./bootstrap.log"]
null_resource.bootstrap: Creation complete after 0s [id=8614855501740043963]

$ cat bootstrap.log
bootstrap started
```

`null_resource` doesn't represent anything real, it only exists as a place to attach the provisioner. In a real case it would be the `provisioner` inside an actual resource, an instance for example.

## Destroy-time provisioner

With `when = destroy`, the command runs right before Terraform destroys the resource, not after creating it:

```hcl
resource "null_resource" "bootstrap" {
  provisioner "local-exec" {
    command = "echo 'bootstrap started' > ${path.module}/bootstrap.log"
  }

  provisioner "local-exec" {
    when    = destroy
    command = "echo 'bootstrap torn down' > ${path.module}/bootstrap.log"
  }
}
```

```console
$ terraform destroy
null_resource.bootstrap: Destroying... [id=8614855501740043963]
null_resource.bootstrap: Provisioning with 'local-exec'...
null_resource.bootstrap (local-exec): Executing: ["/bin/sh" "-c" "echo 'bootstrap torn down' > ./bootstrap.log"]
null_resource.bootstrap: Destruction complete after 0s

$ cat bootstrap.log
bootstrap torn down
```

This makes sense for de-registering something from an external system before the resource stops existing, for example taking an instance out of a load balancer before deleting it. The destroy-time provisioner only runs while the resource is still present in the state; if you delete it by hand from the `.tf` and apply without going through `destroy`, or the resource is already tainted for another reason, it never runs.

## What happens when it fails

By default, if a provisioner's command fails, Terraform marks the resource as tainted and the `apply` ends in an error:

```hcl
resource "null_resource" "flaky" {
  provisioner "local-exec" {
    command = "echo 'flaky ran' > ${path.module}/does-not-exist/flaky.log"
  }
}
```

```console
$ terraform apply
null_resource.flaky: Provisioning with 'local-exec'...
null_resource.flaky (local-exec): /bin/sh: can't create ./does-not-exist/flaky.log: nonexistent directory

Error: local-exec provisioner error

  with null_resource.flaky,
  on main.tf line 13, in resource "null_resource" "flaky":
  13:   provisioner "local-exec" {

Error running command 'echo 'flaky ran' > ./does-not-exist/flaky.log': exit
status 1. Output: /bin/sh: can't create ./does-not-exist/flaky.log:
nonexistent directory
```

The resource itself was created fine, but being tainted means the next `plan` marks it for replacement:

```console
$ terraform plan
  # null_resource.flaky is tainted, so must be replaced
-/+ resource "null_resource" "flaky" {
      ~ id = "5499867266902719923" -> (known after apply)
    }

Plan: 1 to add, 0 to change, 1 to destroy.
```

With `on_failure = continue`, the same failure doesn't interrupt the apply, it just gets logged and Terraform moves on:

```hcl
resource "null_resource" "flaky" {
  provisioner "local-exec" {
    on_failure = continue
    command    = "echo 'flaky ran' > ${path.module}/does-not-exist/flaky.log"
  }
}
```

```console
$ terraform apply
null_resource.flaky: Provisioning with 'local-exec'...
null_resource.flaky (local-exec): /bin/sh: can't create ./does-not-exist/flaky.log: nonexistent directory
null_resource.flaky: Creation complete after 0s [id=255365187768406900]

Apply complete! Resources: 1 added, 0 changed, 1 destroyed.
```

`continue` makes sense for steps that are genuinely optional, notifying an external system that might be down without that blocking the infrastructure. For anything the rest of the configuration depends on, the default (`fail`) is what stops you from moving forward with something half-done.

## Why they're a last resort

Terraform plans by comparing the desired state against the attributes it knows about each resource. A provisioner can run any command, a script, a call to another tool, and that falls outside what Terraform can see: it doesn't show up in the plan, it isn't recorded in the state, and there's no way to know whether the command was idempotent or left the system in a half-done state if it fails partway through.

`remote-exec` (the equivalent for running the command inside the resource itself, not on the machine running Terraform) adds another layer: it needs a `connection` block with credentials and a way to connect, and that access has to be available at the exact moment of the apply. If the resource doesn't have networking ready yet, or the credentials are only generated afterward, the provisioner fails for reasons that have nothing to do with what the script does.

## The alternative: the resource's native features

Almost every provider already has a way to pass initial configuration when creating the resource, without depending on a later connection. In GCP, `google_compute_instance` accepts `metadata_startup_script`: the provider delivers it as instance metadata and the VM's own boot process runs it, without Terraform ever having to connect to anything.

```hcl
resource "google_compute_instance" "web" {
  name         = "web"
  machine_type = "e2-micro"
  zone         = "europe-southwest1-a"

  boot_disk {
    initialize_params {
      image = "debian-cloud/debian-12"
    }
  }

  network_interface {
    network = "default"
  }

  metadata_startup_script = <<-EOF
    #!/bin/bash
    apt-get update
    apt-get install -y nginx
  EOF
}
```

`metadata_startup_script` is a regular resource attribute: Terraform sees it in the plan like any other change, and if you modify it, the diff tells you exactly what changed in the script, something a `provisioner` never gives you.

For boots that take minutes to install dependencies, the better move isn't a bigger script, it's not booting from scratch at all: build an image with Packer that already has the software installed, so the instance only has to boot from that image.

```hcl
resource "google_compute_instance" "web" {
  name         = "web"
  machine_type = "e2-micro"
  zone         = "europe-southwest1-a"

  boot_disk {
    initialize_params {
      image = "projects/my-project/global/images/web-nginx-v3"
    }
  }

  network_interface {
    network = "default"
  }
}
```

Neither of these two GCP examples is applied in this post's lab (they'd need a project and credentials), but the comparison is the point: `metadata_startup_script` replaces the creation-time `provisioner` for the typical case, and a pre-built image replaces the script for anything that can be baked in ahead of time.

## Summary

- A creation-time provisioner runs after the resource is created, a destroy-time one runs right before it's destroyed; the destroy-time one only runs if the resource is still in the state at the moment of `destroy`.
- By default a failing provisioner marks the resource as tainted and stops the apply; `on_failure = continue` lets it proceed, useful only for steps that are genuinely optional.
- Terraform can't plan or validate what a provisioner does: it can run any command, and that stays outside the state.
- `remote-exec` adds the need for a `connection` block with access available at the exact moment of the apply.
- There's almost always a provider-native alternative (`metadata_startup_script` in GCP) that Terraform can see in the plan, and for heavy bootstraps, a pre-built image with Packer.

The full lab is in the [terraform-zero-to-hero](https://github.com/sermanes/terraform-zero-to-hero) repository, under `labs/10-provisioners`.
