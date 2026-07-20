---
title: 'Useful Terraform commands: validate, fmt, show, providers, output, refresh and graph'
description: 'What each of these commands does, how to use them in practice, and which ones actually belong in a CI pipeline (and which do not).'
pubDate: 2026-07-21T12:00:00
tags: ['terraform', 'iac', 'ci', 'best-practices']
---

> **Note:** This post was written in Spanish and translated into English with AI assistance. [Read the original](/blog/terraform-commands/).

So far in the series we've been looking at configuration blocks: providers, variables, attributes, outputs. This post is different, it's about the Terraform CLI itself: commands that don't change infrastructure, but that you end up using every day to debug, format, and inspect what you've written.

## `terraform validate`

Checks that the HCL syntax and each block's arguments are correct, without going as far as planning anything. It doesn't need credentials or connectivity to the backend, just the providers already downloaded (`terraform init` beforehand).

```console
$ terraform validate
Success! The configuration is valid.
```

If you type an argument that doesn't exist, say `file_permissions` instead of `file_permission`, the error points at the exact line and suggests the right name:

```console
$ terraform validate
Error: Unsupported argument

  on main.tf line 9, in resource "local_file" "notice":
   9:   file_permissions = "0700"

An argument named "file_permissions" is not expected here. Did you mean "file_permission"?
```

`validate` doesn't catch everything: if the argument exists but the value is invalid for the provider's API (a machine type that doesn't exist in GCP, say), `validate` won't catch it, `plan` will, once it talks to the API.

## `terraform fmt`

Rewrites the `.tf` files in the current directory with Terraform's standard formatting: indentation, `=` alignment, spacing. It doesn't change logic, only style.

```console
$ terraform fmt -recursive
main.tf
```

The output lists the files it touched. With `-check` it doesn't rewrite anything, it just reports whether something would be misformatted and returns a non-zero exit code if so, which is how you use it in CI (more below).

## `terraform show`

Displays the current state: every resource Terraform manages, with its computed attributes.

```console
$ terraform show
# local_file.notice:
resource "local_file" "notice" {
    content              = "Office pet of the month: clever-lynx"
    directory_permission = "0777"
    file_permission      = "0777"
    filename             = "./notice.txt"
    id                   = "a1b2c3..."
}

# random_pet.office:
resource "random_pet" "office" {
    id        = "clever-lynx"
    keepers   = null
    length    = 2
    separator = "_"
}
```

With `-json` the same information comes out as JSON, meant for another tool to consume rather than a human:

```console
$ terraform show -json | jq '.values.root_module.resources[0].values.filename'
"./notice.txt"
```

This JSON form is what tools like Sentinel, OPA, Checkov, or tfsec consume to review the plan before the `apply`: instead of parsing text, they parse a stable structure.

## `terraform providers`

Lists which providers the configuration needs and which ones are already in the state, without having to open `versions.tf` by hand.

```console
$ terraform providers
Providers required by configuration:
.
├── provider[registry.terraform.io/hashicorp/local]
└── provider[registry.terraform.io/hashicorp/random]
```

It has a useful subcommand for environments without internet access: `providers mirror` downloads the provider binaries to a local directory, so another machine (or the CI runner) can run `init` pointing there instead of at `registry.terraform.io`.

```console
$ terraform providers mirror ./mirror
- Mirroring hashicorp/local...
- Mirroring hashicorp/random...
```

This ties into what we covered in the [providers post](/blog/terraform-providers/): `.terraform.lock.hcl` pins versions and hashes, `providers mirror` is for when those binaries can't be downloaded directly from the registry.

## `terraform output`

We already covered this in the [attributes and outputs post](/blog/terraform-resource-attributes-outputs/).

```console
$ terraform output
office-pet = "clever-lynx"

$ terraform output office-pet
"clever-lynx"

$ terraform output -json office-pet
"clever-lynx"
```

## `terraform refresh` (and `-refresh-only`)

Syncs the state with what's actually deployed, without changing any resource. By default there's no need to call it separately: `plan` and `apply` already refresh the state in memory before computing the diff.

```console
$ terraform plan
random_pet.office: Refreshing state... [id=clever-lynx]
local_file.notice: Refreshing state... [id=a1b2c3...]

No changes. Your infrastructure matches the configuration.
```

The standalone `terraform refresh` command has been deprecated since Terraform 1.x in favor of `terraform apply -refresh-only`, which does the same thing but shows a plan of the changes it's about to persist to the state first and asks for confirmation, instead of writing directly:

```console
$ terraform apply -refresh-only
random_pet.office: Refreshing state... [id=clever-lynx]

Terraform will perform the following actions:
  ...
Would you like to update the Terraform state to reflect these detected changes?
```

It makes sense when someone has touched something outside of Terraform (a console click, a stray script) and you want the state to reflect reality without touching the infrastructure. If you want the opposite, for `plan`/`apply` to skip checking the real state, there's `-refresh=false`; useful for speeding up a `plan` when you know nothing changed outside, but with the risk that the state no longer reflects reality and the plan comes out wrong.

## `terraform graph`

Generates the dependency graph in DOT format.

```console
$ terraform graph
digraph {
  compound = "true"
  newrank = "true"
  subgraph "root" {
    "[root] local_file.notice (expand)" [label = "local_file.notice", shape = "box"]
    "[root] random_pet.office (expand)" [label = "random_pet.office", shape = "box"]
    "[root] local_file.notice (expand)" -> "[root] random_pet.office (expand)"
    ...
  }
}
```

Raw DOT doesn't say much at a glance. With Graphviz installed (`apt install graphviz`), you can turn it into an image:

```console
$ terraform graph | dot -Tsvg > graph.svg
```

For two resources like this lab the graph is trivial, but in a module with dozens of resources it's the fastest way to see what depends on what without reading through all the code.

## Which of these commands belong in CI

Not all of them. A typical CI pipeline for a Terraform repo does this, in this order:

```console
terraform fmt -check -recursive
terraform init -input=false -lockfile=readonly
terraform validate
terraform plan -input=false -out=plan.tfplan
terraform show -json plan.tfplan > plan.json   # optional, for policy checks
terraform apply -input=false plan.tfplan       # only after approval, in a separate job
```

- **`fmt -check -recursive`**: `-check` doesn't rewrite anything, it just checks and returns an error if something isn't formatted; `-recursive` also looks at subdirectories (local modules, for example), not just the current directory. It doesn't need `init` or credentials, so it's the pipeline's first step.
- **`init -lockfile=readonly`**: uses the repo's `.terraform.lock.hcl` as is, without touching it. If someone needs a different provider version, they change it locally and commit it; CI shouldn't rewrite the lock file on its own.
- **`validate`**: fast, no real backend or extra credentials needed, a good filter before spending time on a `plan`.
- **`plan -out=plan.tfplan`**: the plan gets saved as an artifact. The later `apply` uses that exact file (`apply plan.tfplan`), it doesn't plan again. That way, what gets approved in review is exactly what gets applied, without asking the API again in case something changed in the meantime.
- **`show -json`**: if you use OPA, Checkov, tfsec, or Sentinel to review changes, the entry point is the plan in JSON, not the `.tf`. It evaluates the real change, not just the static code.
- **`-input=false`** on every command: there's no interactive terminal in CI to answer a prompt; if a variable with no default is missing, it's better for the command to fail explicitly than to hang waiting for input.
- The `TF_IN_AUTOMATION=true` environment variable tells Terraform it's running in a pipeline: it tweaks some messages (for example, it stops suggesting interactive commands in errors) but doesn't change the actual behavior of any command.

What normally does **not** go in the pipeline:

- **standalone `refresh` / `apply -refresh-only`**: if the state and reality have drifted apart, that's a signal something changed outside Terraform, and that gets investigated by hand, not fixed automatically on every pipeline run.
- **`graph`**: it's for a person to debug a module by eye, it adds nothing inside an automated pipeline.
- **`providers mirror`**: only needed if the CI runner has no access to `registry.terraform.io`; in that case `init` points at the local mirror instead of `registry.terraform.io`.

## Summary

- `validate` checks syntax and arguments without planning; `fmt` normalizes style; both are cheap and come first in any pipeline.
- `show` (with `-json`) inspects the state or a saved plan; it's the format consumed by OPA, Checkov, tfsec, or Sentinel.
- `providers` lists which providers the configuration uses; `providers mirror` covers the case with no direct access to the registry.
- `output` queries exposed values without applying anything again.
- `refresh` is deprecated in favor of `apply -refresh-only`; neither one belongs in a pipeline, they're for syncing the state by hand when something changed outside.
- `graph` visualizes dependencies, useful for debugging a large module, not for CI.
- A reasonable CI pipeline: `fmt -check` → `init -lockfile=readonly` → `validate` → `plan -out=` → (approval) → `apply` of the saved plan, all with `-input=false`.

The full example is in the [terraform-zero-to-hero](https://github.com/sermanes/terraform-zero-to-hero) repository, in the `labs/06-terraform-commands` folder.
