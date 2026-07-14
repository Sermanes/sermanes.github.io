---
title: 'From Snapshots to Infrastructure as Code'
description: 'Snapshots, Terminator broadcast and clicking around the GCP console. A short look back at how we used to provision servers, and why we ended up declaring infrastructure as code.'
pubDate: 2026-07-13
tags: ['terraform', 'iac', 'infrastructure', 'gcp']
---

> **Note:** This post was written in Spanish and translated into English with AI assistance. [Read the original](/blog/de-snapshots-a-infraestructura-como-codigo/).

There was a time when asking for three machines was a piece of paperwork.

I'm not exaggerating. The business wanted a new application. An analyst gathered the requirements and handed them to an architect, who drew up the deployment: two front-end servers, two back-end, a database, a load balancer. That design became a hardware list, and that list became a purchase order. And then the slow part began: waiting.

Weeks. Sometimes months. And when the boxes finally arrived, the process carried on: rack the hardware, install the operating system, configure the network, allocate the storage, apply the backup policies. Each step waiting on the one before it. Only at the end of all that (a full quarter after that first meeting) could the application be deployed.

And here's where I should be honest: I barely lived through that part. By the time I started, the cloud was already here. Of the full cycle (the purchase order, the boxes, the racking) what mostly reached me were the war stories of the people who did suffer it, plus some archaeological leftovers in the data centre that still needed maintaining. I got lucky.

What I did get was everything after that: virtual machines, snapshots and a lot of hand-editing configuration.

## What actually hurt

The serious problem was that **nobody knew how the servers were configured**. Not out of sloppiness: by construction.

Think about how you cloned a machine back then. You built one by hand, got it just right (packages, users, kernel limits, the monitoring agent, the log paths) and, once it worked, you took a snapshot. That was the good one, the final one, the one the next eleven machines would come out of.

In theory. Because then you'd look at the snapshot list and find `base-web-v1`, `base-web-v2`, `base-web-final`, `base-web-final-OK`, `base-web-final-GOOD-use-this-one`. And not one of the five had a note explaining how it differed from the last. The final image was never the most recent one; it was whichever one the guy on the previous shift told you to use, out loud.

And even so, it worked. On day 1.

On day 30 a CVE dropped. And that's when you found the trap: the snapshot was already a lie. Those twelve machines had been running in production for a month, and each had drifted on its own. One had a debug package installed during an incident that nobody ever removed. Another had a `sysctl` tweaked by hand on a Friday afternoon. A third rebooted halfway through an `apt upgrade`. The snapshot described how they were *born*, not how they *were*.

So you did the only thing you could: SSH into all twelve. And to stay sane, you opened **Terminator**, split the window into twelve panes, turned on broadcast, and typed once so that every keystroke landed in all twelve sessions at the same time.

That wasn't automation: it was typing faster. All it took was one `sudo` in the wrong pane, or one machine that wasn't in exactly the same state as the other eleven, and broadcast applied your mistake to all twelve at once.

And underneath all of it sat an uncomfortable truth: **the real state of your infrastructure only existed inside the machines**. It didn't exist in any document, any repository, anywhere you could read, review or diff. It existed on twelve disks, and to query it you had to go in and ask each one.

Then there was the model's other sin: because ordering hardware took months, you sized for peak. You bought for Black Friday and paid for the electricity of Black Friday the other 364 days of the year. Resources idling, just in case.

## The cloud didn't fix the problem. It moved it.

AWS, Azure and GCP showed up, and things genuinely changed. No waiting on a vendor: a VM in minutes. No racks, no disks, no cabling. And, this is the part that matters, **an API behind everything**.

But look at what we did with that API on day one: we opened the web console and started clicking.

And there's the contradiction. The cloud sells you elasticity: create and destroy at will, scale with demand. But if every creation is a human clicking through a form (what ended up being called **ClickOps**), you have recreated the same old problem with better latency: nobody knows why the staging instance has a 200 GB disk and production has 100, you can't review a change before it happens, and the twelve machines still can't be described without logging in to look. The only thing that improved is how fast you can get it wrong.

## The next attempt: scripts

The natural reaction was obvious: if there's an API, write scripts that call it. Bash with `gcloud`. Python with the SDK. And it worked, up to a point.

Right up until you ran the script twice.

Because a script is imperative: it describes **steps**, not **state**. You tell it "create an instance" and it creates one. Whether one already existed is not its problem: either it blows up with an error, or you end up with two. So you start defending yourself: check before creating, compare current config against desired config, decide whether to modify or recreate, handle dependency ordering... and suddenly your provisioning script is 400 lines and 80% of it is checks.

At that point you're not writing a script anymore. You're writing a reconciliation engine, badly.

## Declaring instead of commanding

The idea that changes everything is to stop issuing commands and start describing the outcome.

Instead of saying *"create an instance"*, you say *"I want this instance to exist, like this"*. And you let the tool work out what to do to get there: create it if it doesn't exist, modify it if it differs, leave it alone if it's already right.

That's infrastructure as code, and that's what Terraform does. It ships as a single binary and talks to platforms through **providers**, plugins that translate to each platform's API. And it's not just clouds: there are providers for GCP, AWS and Azure, of course, but also for DNS, Cloudflare, Datadog, GitHub, PostgreSQL and Auth0. If it has an API, it can be declared.

A GCP instance is described like this:

```hcl
resource "google_compute_instance" "web" {
  name         = "web-01"
  machine_type = "e2-medium"
  zone         = "europe-southwest1-a"

  boot_disk {
    initialize_params {
      image = "debian-cloud/debian-12"
    }
  }

  network_interface {
    network = "default"
  }
}
```

That's HCL, Terraform's configuration language, and it doesn't describe a sequence of calls. It describes a fact: this instance exists, it's called this, it's this size, it boots from this image.

Now go back to the earlier scenario. You want to bump the machine to `e2-standard-2`. You change one line. No snapshot cloning, no rebuilding an image, no Terminator. And if you need twelve identical machines, you don't open twelve tabs: it's a `count` or a `for_each`, and all twelve come from exactly the same definition. There is no "that one weird machine someone touched on a Friday", because there's no manual path to touch it through.

## Init, plan, apply (and why `plan` is the part that matters)

Terraform's workflow has three phases:

- **`init`** downloads the providers your configuration needs.
- **`plan`** compares what you declared against what actually exists, and tells you what it's going to do.
- **`apply`** executes it.

Of the three, the middle one is what changed how I work.

`terraform plan` tells you what's going to happen before it happens: I'm going to create this, modify that, and destroy this other thing. And that third verb is the reason to read the whole plan, every time, even when the change looks like a one-liner.

Here's an example. Bumping the machine from `e2-medium` to `e2-standard-2` is an in-place change: Terraform stops it, changes the type, starts it again. A `1 to change`. Now imagine what you touch instead is the boot disk image, from `debian-12` to `debian-13`. It's one line, and in the diff the two edits look almost identical. But the plan answers with something else entirely:

```text
  # google_compute_instance.web must be replaced
-/+ resource "google_compute_instance" "web" {
      ~ boot_disk {
          ~ initialize_params {
              ~ image = "debian-cloud/debian-12" -> "debian-cloud/debian-13"
                # forces replacement
            }
        }
    }

Plan: 1 to add, 0 to change, 1 to destroy.
```

**`forces replacement`.** That field can't be modified on an existing machine, so Terraform has only one route: destroy the instance and create a new one. And in production that means very concrete things: anything on that disk is gone, the internal IP may change, and there's a window of downtime between one machine dying and the next coming up.

It's exactly the same damage you used to cause by accident, back when you rebuilt a machine "because the snapshot was out of date" and took down something that only existed on that disk. The difference is *when* you find out.

You used to find out afterwards. Now `plan` shows you before anything is touched, while production is still standing, and you get to decide: accept the replacement with a maintenance window, or change approach.

And this is what I find beautiful about `plan`: it doesn't ask you to know by heart which fields of a GCP instance are immutable and which aren't. It tells you, for your specific case, with your configuration in front of it, and without having touched anything yet. The `forces replacement` and the `1 to destroy` on the last line are the tool explaining the consequences of your change in a language you can read, while you can still change your mind.

None of the earlier ways of working had that. Not the console, not the scripts, and certainly not Terminator's broadcast.

## In short

Three things I take away from all this:

- **The problem was never how slow the hardware was.** It was that the real state of the infrastructure only existed inside the machines, with no way to read it, review it or diff it without logging into each one.
- **The cloud didn't fix it on its own.** Provisioning by clicking through a console solves the waiting, but leaves the manual work, the inconsistency and the not-knowing-what's-running entirely intact. Faster, sure, but just as opaque.
- **What changes the game is declaring instead of commanding.** You describe the state you want, and the tool works out how to get there. The code becomes the source of truth, and `plan` shows you the consequences before you apply them.

Terraform isn't magic: it's a binary, some providers, and a cycle of `init`, `plan` and `apply`. It isn't the only option either: OpenTofu, Pulumi, CloudFormation and Crossplane play in the same league, each with its own trade-offs. I went with Terraform simply because it's the most widely used, but the underlying idea, declaring instead of commanding, is the same in all of them.

And that idea is what matters. After years of juggling snapshots and Terminator panes, being able to open a file and *read* what's running still strikes me as an enormous change.
