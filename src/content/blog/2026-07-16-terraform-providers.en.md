---
title: 'What Terraform providers are and how to use them'
description: "What a Terraform provider actually is, why you should pin its version with required_providers, what the .terraform.lock.hcl file is for, and how to configure the Google Cloud provider without putting credentials in your code."
pubDate: 2026-07-16T12:00:00
tags: ['terraform', 'iac', 'gcp', 'best-practices']
---

> **Note:** This post was written in Spanish and translated into English with AI assistance. [Read the original](/blog/terraform-providers/).

If you've followed the previous posts, you've already run `terraform init` a few times. And if you paid attention to the output the first time, you may have seen a warning like this:

```console
The following providers do not have any version constraints in configuration,
so the latest version was installed.

To prevent automatic upgrades to new major versions that may contain breaking
changes, we recommend adding version constraints in a required_providers block
in your configuration, with the constraint strings suggested below.

* hashicorp/local: version = "~> 2.5"
```

Terraform is warning us about something important: we're using a provider without saying which version we want, so it installed the latest one available. Today it works. The day the provider ships a new version with incompatible changes, the very same code that passes `plan` cleanly today can start failing without you having touched anything. This post is about avoiding that, and along the way understanding exactly what `terraform init` is downloading.

## What a provider is

The Terraform binary, on its own, doesn't know how to talk to any cloud. It knows how to read `.tf` files, work out differences and manage the state, but it has no idea how a bucket gets created in Google Cloud or an instance in AWS. That job belongs to **providers**: plugins that Terraform downloads and that translate declared resources into calls against each platform's API.

It's a plugin architecture: each provider is a separate executable that Terraform downloads into `.terraform/providers/` when you run `init`. That's why the Terraform binary stays small, and why there are providers for hundreds of platforms: the three big clouds, but also GitHub, Cloudflare, Kubernetes, Datadog... even something as mundane as the `local` provider we used to create files on disk in the [installation post](/en/blog/instalar-terraform/).

Providers are distributed through the [Terraform Registry](https://registry.terraform.io), organized into three tiers depending on who maintains them:

- **Official**: maintained by HashiCorp. AWS, Azure and the `local` provider live here. Google is an interesting case: it's maintained by both Google and HashiCorp.
- **Partner**: maintained by the company that owns the platform, after going through HashiCorp's verification process. Datadog, Cloudflare or DigitalOcean, for example.
- **Community**: maintained by community contributors, without verification. Some are excellent, but before using one it's worth checking whether the repository is still active.

Each provider is identified with an address following this format: `namespace/name`: `hashicorp/google`, `hashicorp/local`, `datadog/datadog`. The full address includes the registry hostname (`registry.terraform.io/hashicorp/google`), but since the public registry is the default, it's almost never written out.

## Pinning the version: required_providers

Back to the warning at the start. Terraform's own suggested fix is to declare the providers the project uses, with their version, in a `required_providers` block inside the `terraform` block:

```hcl
terraform {
  required_providers {
    google = {
      source  = "hashicorp/google"
      version = "~> 7.0"
    }
  }
}
```

Each provider takes two fields:

- **`source`**: the provider's address in the registry. We hadn't declared it so far and things worked the same, because when it's missing, Terraform assumes `hashicorp/<name>`. For HashiCorp's own providers that's fine; for anything else (a `datadog/datadog`, say) `source` is required, because Terraform has no way to guess the namespace.
- **`version`**: which versions of the provider this project accepts. Not an exact version, a constraint.

The constraint accepts the usual comparison operators (`= 7.40.0`, `>= 7.0`, `< 8.0`, combinable by separating them with commas), but in practice almost everyone uses one: `~>`, the pessimistic operator. It means "this version or higher, without changing the last number I wrote":

- `~> 7.0` accepts any `7.x` (7.1, 7.40...), but not 8.0.
- `~> 7.40.0` accepts any `7.40.x` (patches only), but not 7.41.

Why is this the usual operator? Because providers follow semantic versioning, and incompatible changes only land in major versions. With `~> 7.0` you get improvements and fixes across the whole 7 series without the risk of an `init` sneaking in the jump to 8, which is where things can break. You decide when to take the major jump, after reading the changelog.

The general recommendation is simple: **every project declares `required_providers` with a version constraint for every provider it uses**. No exceptions.

## While we're at it: the Terraform version

The same `terraform` block accepts another constraint worth writing down, the one for Terraform's own version:

```hcl
terraform {
  required_version = ">= 1.10"

  required_providers {
    google = {
      source  = "hashicorp/google"
      version = "~> 7.0"
    }
  }
}
```

If someone runs the project with an older Terraform than declared, the command fails instantly.

If you use the Docker Makefile from the previous posts this might look redundant, since the Makefile's `TF_VERSION` already fixes which binary runs. But they play different roles: the Makefile decides which version *you* use; `required_version` protects the project from anyone running it any other way. It's redundant on purpose: `required_version` travels with the code to any place the Makefile doesn't reach.

## The lock file: from "what I accept" to "what I'm using"

With `version = "~> 7.0"` we've narrowed the range, but there's still room inside it: today `init` would install 7.40, next month 7.43. The same problem still exists, just smaller, and that's where a file that may have already shown up in your directory comes in: `.terraform.lock.hcl`. Terraform creates (or updates) it on every `init`, and inside it records the **exact** version of every provider it installed, along with their checksums:

```hcl
provider "registry.terraform.io/hashicorp/google" {
  version     = "7.40.0"
  constraints = "~> 7.0"
  hashes = [
    "h1:mV0Y0BLevn5QIYuKpxHkTNhTpKgCjbBLdmqrqTLtNXk=",
    ...
  ]
}
```

From that point on, any `terraform init` (yours, a teammate's, CI's) installs exactly that version, even if a newer one that also satisfies the constraint exists. Each file plays a different role:

- The `required_providers` constraint says **which versions you're willing to accept**.
- The lock file says **which one you're using right now, exactly**.

For this to work as a team there's one rule: **`.terraform.lock.hcl` gets committed to the repository**. It's the equivalent of npm's `package-lock.json` or Python's `poetry.lock`, and the reason is the same: without it, every machine resolves the version on its own and "works on my machine" comes back into the conversation. Watch out, because it's easy to drop it into `.gitignore` by accident: the `.terraform/` folder does get ignored (those are downloaded binaries), but the `.terraform.lock.hcl` file doesn't.

Checksums are the other half of the file: on every `init`, Terraform checks that the downloaded binary matches the recorded hash, the same idea as the `sha256sum` we ran by hand when [installing Terraform](/en/blog/instalar-terraform/), but automatic. If the registry ever returned a different binary than the one the team validated, `init` fails.

So how do you upgrade a provider? Using this command:

```bash
terraform init -upgrade
```

That command looks for the newest version satisfying the constraints, installs it and updates the lock file. Then, a `terraform plan` to check for surprises, and if everything looks good, the updated lock file gets committed. The version bump ends up recorded in a commit, gets reviewed like any other change, and if something goes wrong it gets reverted with `git revert`. In larger projects this work is usually delegated to tools like Renovate or Dependabot, which open the version-bump pull request for you; but the underlying flow is the same.

One detail that saves a headache in CI: by default the lock file only stores checksums for the platform where `init` ran. If you work on a Mac with Apple Silicon and CI runs on Linux, CI can end up missing the hashes for its platform and `init` fails. It's fixed by registering every platform the team uses:

```bash
terraform providers lock \
  -platform=linux_amd64 \
  -platform=darwin_arm64
```

With the series' Makefile there's no issue, since everything (your machine and CI) runs the same Linux container. But if your team mixes different systems, this command saves you from the checksum error.

## Configuring the Google provider

So far we've talked about which provider and which version. What's missing is the provider's own configuration: the `provider` block, where it gets the default values it's going to work with:

```hcl
provider "google" {
  project = "my-project"
  region  = "europe-west1"
}
```

With this, any resource in the project that doesn't say otherwise gets created in that GCP project and region, no need to repeat it resource by resource. Every provider has its own arguments (AWS asks for `region`, Datadog asks for its API key...), all documented on the provider's page in the registry.

And here comes the point where the most damage can be done: **credentials**. The Google `provider` block accepts a `credentials` argument pointing to a service account key. Don't use it like this:

```hcl
# NO: the path gives away that there's a loose key lying around, and
# the next step is usually committing it "just to test"
provider "google" {
  project     = "my-project"
  credentials = file("my-key.json")
}
```

Credentials in code end up in the repository, and a committed secret is considered compromised even if you delete it in the following commit (it stays in the history). The rule is that **code declares infrastructure; the environment supplies the credentials**. With Google, in practice:

- **Locally**: Application Default Credentials, the same ones we set up in the [remote state post](/en/blog/terraform-state-remoto/) with `gcloud auth application-default login`. The provider finds them without anything needing to be declared in the block.
- **In CI**: Workload Identity Federation, which lets the pipeline authenticate against GCP with short-lived tokens, with no stored key at all. If your CI doesn't support it yet, plan B is a service account key stored in CI's secrets manager, never in the repository.

Notice that the `provider` block above, the good one, doesn't contain a single sensitive value: project and region are public information to anyone with access to the repository. That's how it should stay.

## Same provider, several configurations: aliases

One last scenario remains: what if you need the same provider with two different configurations? The typical case is deploying to two regions (say, the main infrastructure in `europe-west1` and a backup copy in another region), or touching two GCP projects from the same code. You can't just declare two `provider "google"` blocks, because Terraform wouldn't know which one to use. That's what **aliases** are for:

```hcl
provider "google" {
  project = "my-project"
  region  = "europe-west1"
}

provider "google" {
  alias   = "backup"
  project = "my-project"
  region  = "europe-southwest1"
}
```

The first block, with no alias, is the default configuration: every resource uses it unless it says otherwise. To create a resource with the second one, it's requested explicitly with `provider =`:

```hcl
resource "google_storage_bucket" "backups" {
  provider = google.backup

  name     = "mycompany-backups"
  location = "EUROPE-SOUTHWEST1"
}
```

Give the alias a name that means something (`backup`, `madrid`, `network_project`) instead of a generic `google2`, because that name is the only thing whoever reads the resource will see. And using aliases isn't the common case: most projects live perfectly well with a single `provider` block and no alias.

## In summary

- A **provider** is a plugin that translates declared resources into calls to each platform's API. They're downloaded from the registry with `terraform init`.
- Every project declares its providers in **`required_providers`**, with `source` and a version constraint. The `~>` operator is the usual one: it accepts improvements within the same series and blocks the major jump, which is where things break.
- **`required_version`** does the same for Terraform's own version.
- **`.terraform.lock.hcl`** pins the exact version in use and its checksums, and always gets committed. Version bumps are done on purpose with `terraform init -upgrade`, reviewed with a `plan`, and good practice is to commit them on their own.
- The **`provider`** block carries project and region, and **never credentials**: locally, Application Default Credentials; in CI, Workload Identity or a secrets manager.
- **Aliases** let you use the same provider with several configurations (two regions, two projects). Useful in specific cases, not in most projects.

The full example lives, as always, in the [terraform-zero-to-hero](https://github.com/sermanes/terraform-zero-to-hero) repository, under `labs/03-providers`.
