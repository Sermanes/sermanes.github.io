---
title: 'count vs for_each in Terraform'
description: 'Differences between the count and for_each meta-arguments, when to use each one, and the problem with count on indexed lists.'
pubDate: 2026-07-29T12:00:00
tags: ['terraform', 'iac', 'meta-arguments']
---

> **Note:** This post was written in Spanish and translated into English with AI assistance. [Read the original](/blog/terraform-count-for-each/).

The [previous post](/blog/terraform-data-sources/) covered the `data` block. This one goes back to meta-arguments we've already been using without fully explaining: `count`, which has shown up since the very first lab to create a single `random_pet`, and `for_each`, its alternative for when an element's position shouldn't matter.

## count: resources by index

`count` creates N copies of a resource. Each copy is identified by its position, `count.index`, starting at 0:

```hcl
variable "environments" {
  type    = list(string)
  default = ["dev", "staging", "prod"]
}

resource "local_file" "count_demo" {
  count = length(var.environments)

  filename = "${path.module}/generated/count-${var.environments[count.index]}.txt"
  content  = "Environment: ${var.environments[count.index]}"
}
```

`terraform apply` creates three resources, `count_demo[0]`, `count_demo[1]` and `count_demo[2]`, each with the filename that matches its position in the list.

## The problem: removing an element shifts the indices

If you remove `"dev"` from the list, `count_demo[0]` stops being dev and becomes staging, `count_demo[1]` stops being staging and becomes prod, and `count_demo[2]` no longer has a matching element. Terraform doesn't know you removed the first one: it only sees that the content and filename of indices 0 and 1 changed, and that index 2 is left over.

```console
$ terraform plan
  # local_file.count_demo[0] must be replaced
-/+ resource "local_file" "count_demo" {
      ~ content  = "Environment: dev" -> "Environment: staging" # forces replacement
      ~ filename = "./generated/count-dev.txt" -> "./generated/count-staging.txt" # forces replacement
        # (8 unchanged attributes hidden)
    }

  # local_file.count_demo[1] must be replaced
-/+ resource "local_file" "count_demo" {
      ~ content  = "Environment: staging" -> "Environment: prod" # forces replacement
      ~ filename = "./generated/count-staging.txt" -> "./generated/count-prod.txt" # forces replacement
        # (8 unchanged attributes hidden)
    }

  # local_file.count_demo[2] will be destroyed
  # (because index [2] is out of range for count)
  - resource "local_file" "count_demo" {
      - content  = "Environment: prod" -> null
      - filename = "./generated/count-prod.txt" -> null
        # (8 unchanged attributes hidden)
    }

Plan: 2 to add, 0 to change, 4 to destroy.
```

The only resource that should disappear is the dev one. Instead, Terraform replaces staging and prod (destroys and recreates the file, even though its final content is the same it already had) and also destroys a third resource that no longer has an index. With a `local_file` this is harmless. With a database instance or a persistent disk indexed by `count`, removing an element from the middle of the list can destroy infrastructure that had nothing to do with the change.

## for_each: resources by key

`for_each` identifies each instance by a key, not a position. It accepts a map or a set of strings, not a list, so if you start from a list you need to convert it with `toset()`:

```hcl
resource "local_file" "foreach_demo" {
  for_each = toset(var.environments)

  filename = "${path.module}/generated/foreach-${each.value}.txt"
  content  = "Environment: ${each.value}"
}
```

Now each instance is called `foreach_demo["dev"]`, `foreach_demo["staging"]`, `foreach_demo["prod"]`. Removing `"dev"` from the list gives a very different plan:

```console
$ terraform plan
  # local_file.foreach_demo["dev"] will be destroyed
  # (because key ["dev"] is not in for_each map)
  - resource "local_file" "foreach_demo" {
      - content  = "Environment: dev" -> null
      - filename = "./generated/foreach-dev.txt" -> null
        # (8 unchanged attributes hidden)
    }

Plan: 0 to add, 0 to change, 1 to destroy.
```

Only `foreach_demo["dev"]` gets destroyed. `staging` and `prod` don't show up in the plan because their key didn't change: they were `"staging"` and `"prod"` before and after, and `for_each` doesn't depend on where they sit in the original list.

`toset()` has its own trap: if the list has duplicate values, the set silently keeps only one. Two identical elements that would produce two separate resources with `count` end up as a single resource with `for_each`. For data that might repeat, a map with explicit keys is a better choice than `toset()` on a list.

## count as a toggle

There's one use of `count` that doesn't have as direct a replacement in `for_each`: creating a resource only if a condition holds, by setting `count` to 0 or 1.

```hcl
variable "enable_canary" {
  type    = bool
  default = false
}

resource "random_pet" "canary" {
  count  = var.enable_canary ? 1 : 0
  length = 2
}
```

With `enable_canary = false` the resource doesn't exist. With `true`, it exists as `random_pet.canary[0]`, and you have to reference it with that index (or with `try(random_pet.canary[0].id, null)` in an output, so it doesn't break when the resource isn't there). This is the usual pattern for an optional resource when there are only two possible states, it exists or it doesn't, and there's no need to identify several instances by key.

## Differences

| Aspect | `count` | `for_each` |
| --- | --- | --- |
| Input type | number | map or set of strings |
| Instance identity | position (`count.index`) | key (`each.key` / `each.value`) |
| Removing an element from the middle | replaces the following ones, destroys the leftover | destroys only the missing one |
| Accessing an instance | `resource[0]`, `resource[1]`... | `resource["key"]` |
| Output shape | list | map |
| Good use case | identical copies, 0/1 toggle | named resources that can change over time |

## Summary

- `count` numbers by position; if the list feeding it changes order or loses an element in the middle, the indices shift and Terraform replaces resources that shouldn't have been touched.
- `for_each` numbers by key; only the instance whose key disappears gets destroyed, the rest never notice the change.
- `for_each` requires a map or a set, not a list: `toset()` is the quick conversion, but it silently drops duplicates.
- `count` is still the simplest choice for fungible copies or for the "0 or 1 resource" pattern based on a condition.

The full lab is in the [terraform-zero-to-hero](https://github.com/sermanes/terraform-zero-to-hero) repository, under `labs/09-count-for-each`.
