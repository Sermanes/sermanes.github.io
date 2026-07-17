---
title: 'How to declare variables in Terraform'
description: "How to declare Terraform variables with type and description, the four ways to assign them a value (default, -var, TF_VAR_, tfvars files), and the precedence order when several of them compete for the same variable."
pubDate: 2026-07-17T12:00:00
tags: ['terraform', 'iac', 'gcp', 'best-practices']
---

> **Note:** This post was written in Spanish and translated into English with AI assistance. [Read the original](/blog/terraform-variables/).

In the [providers post](/blog/terraform-providers/) we pinned down the versions, but the code still has another problem: the GCP project name and the bucket names are hard-coded in `main.tf` and `provider.tf`. If someone else wants to try the lab, they have to go file by file changing strings, or ask an AI to do it. If you want to deploy the same infrastructure to a test project and a production one, you have to keep two copies of the code around. Variables solve this: they take those values out of the code and turn them into parameters you pass in at run time.

## Declaring a variable

A variable is declared with a `variable` block, usually in a separate file called `variables.tf`:

```hcl
variable "bucket_prefix" {
  description = "Prefix used to build the bucket names."
  type        = string
  default     = "mycompany-lab04"
}
```

Three fields, none of them required by Terraform, but it's good practice to always write all three:

- **`description`**: what the variable represents. Terraform doesn't need it to work, but three months from now you won't remember what `region_2` was either.
- **`type`**: what shape of data it accepts (`string`, `number`, `bool`, `list(string)`, `map(string)`, `object({...})`...). Without `type`, Terraform tries to infer it from whatever value it receives, and if someone passes the wrong type the failure can show up later, sometimes in the middle of an `apply`. With `type` declared, the failure shows up the moment you assign the value.
- **`default`**: the value used if nobody says otherwise. If you leave it out, a value has to be passed in from outside; otherwise Terraform asks for it.

The variable name follows the same convention as the rest of Terraform: lowercase with underscores (`bucket_prefix`, not `bucketPrefix` or `bucket-prefix`).

To use the variable in a resource, reference it with the `var.` prefix:

```hcl
resource "google_storage_bucket" "primary" {
  name     = "${var.bucket_prefix}-primary"
  location = var.primary_location
}
```

## Required variables

If a value has no reasonable default (the GCP project is the typical case: there's no "default" project that makes sense for anyone but you), the variable is declared without `default`:

```hcl
variable "project" {
  description = "GCP project where the buckets are created."
  type        = string
}
```

If you run `terraform plan` or `terraform apply` without having given `project` a value through any of the available means, Terraform stops and asks for it interactively. In any automated environment (CI, a script) that prompt blocks execution indefinitely, so in practice the value always has to be passed in one of the following ways.

## The four ways to assign a value

Besides the `default` in the block itself, there are three more ways to give a variable a value from outside the code.

**The `-var` flag on the command line**, one per variable you want to set:

```bash
terraform apply -var "project=my-project" -var "bucket_prefix=lab04"
```

**Environment variables**, prefixed with `TF_VAR_` followed by the exact variable name:

```bash
export TF_VAR_project="my-project"
export TF_VAR_bucket_prefix="lab04"
terraform apply
```

**Variable definition files**, with a `.tfvars` extension. Terraform automatically loads a file called `terraform.tfvars`, and also any file ending in `.auto.tfvars`:

```hcl
# terraform.tfvars
project       = "my-project"
bucket_prefix = "lab04"
```

If the file has a different name, you need to point to it explicitly with `-var-file`:

```bash
terraform apply -var-file="production.tfvars"
```

## Precedence: which value wins when several are used at once

This post's lab (`labs/04-variables`) ships with two variable files on purpose, so precedence can be seen in action instead of just in theory:

```hcl
# terraform.tfvars
project       = "my-project"
bucket_prefix = "mycompany-lab04"
```

```hcl
# prefix.auto.tfvars
bucket_prefix = "mycompany-lab04-auto"
```

Both load on their own, without asking for them with any flag. And even though `terraform.tfvars` is read first, `prefix.auto.tfvars` is read after and wins, so a `make plan` in this lab creates buckets with the prefix `mycompany-lab04-auto`, not `mycompany-lab04`:

```console
$ cd labs/04-variables
$ make plan
...
  + resource "google_storage_bucket" "primary" {
      + name     = "mycompany-lab04-auto-primary"
      ...
```

If you also pass `-var "bucket_prefix=lab04-manual"` when running it, that value wins over both files. The full order, from lowest to highest precedence, is this:

| Precedence | Source | Example |
| --- | --- | --- |
| 1 (lowest) | `default` in the `variable` block | `default = "mycompany-lab04"` |
| 2 | `TF_VAR_` environment variable | `export TF_VAR_bucket_prefix=...` |
| 3 | `terraform.tfvars` | `bucket_prefix = "mycompany-lab04"` |
| 4 | `*.auto.tfvars` files (alphabetical order) | `bucket_prefix = "mycompany-lab04-auto"` |
| 5 (highest) | `-var` or `-var-file` on the command | `-var "bucket_prefix=lab04-manual"` |

The practical rule that comes out of this table: the closer to the command you run, the higher the priority. And each level has its own natural use case:

- **`default`**: the everyday value, the one that works in the normal case without anyone touching anything.
- **`TF_VAR_`**: data from the environment where Terraform runs (a CI that already has the project in its own environment variable, for example), without touching any file in the repository.
- **`terraform.tfvars`**: the usual values for whoever works with the project day to day, kept alongside the code.
- **`*.auto.tfvars`**: overrides that load on their own for a specific case (a test machine, a particular environment) without touching the base `terraform.tfvars`.
- **`-var` / `-var-file`**: the one-off exception, a different value just for this run, leaving no trace in any file.

## Best practices when declaring variables

- **`description` and `type` on every variable, no exceptions.** It's the difference between a `terraform plan` that fails with a clear message ("expected string, got number") and one that fails later, against the provider's API, with an error that's much harder to trace back to its real cause.
- **Lowercase names with underscores, plural when the type is a list or a map** (`bucket_names` for a `list(string)`, not `bucket_name`).
- **No `default` for anything that must be decided explicitly per environment** (the project, the account, any identifier that changes between test and production). Setting a "reasonable" `default` in these cases is the most common way to end up deploying against the wrong project by mistake.
- **Never a `default` for secrets.** A password or API key variable carries no default value, which forces it to always be passed from outside the code (an environment variable or a secrets manager), never written into a file that could end up committed.

## Summary

- A **variable** is declared with `variable "name" { description, type, default }`, and used with `var.name`.
- Without `default`, the variable is **required**: Terraform asks for it interactively if you don't supply it another way, which blocks any automated run.
- There are three ways to assign a value from outside the code: the **`-var`** flag, **`TF_VAR_`** environment variables, and **`.tfvars` files** (`terraform.tfvars` and `*.auto.tfvars` load on their own; anything else needs `-var-file`).
- **Precedence**, from weakest to strongest: `default` → `TF_VAR_` → `terraform.tfvars` → `*.auto.tfvars` → `-var`/`-var-file`.
- Every variable carries **`description`** and **`type`**; values that change between environments (project, secrets) go **without `default`**.

The full example is in the [terraform-zero-to-hero](https://github.com/sermanes/terraform-zero-to-hero) repository, in the `labs/04-variables` folder.
