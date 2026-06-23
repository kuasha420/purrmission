# Passkey Soft-Fork Workflow

Status: Draft  
Last updated: 2026-06-24  
Related epic: [Passkey-Aware Access](../epics/passkey-aware-access.md)  
Related design: [Passkey-Aware Access](../design/passkey-aware-access.md)

## Purpose

The passkey/WebAuthn work is a multi-sprint experimental effort. It needs room
for architecture spikes, security review, companion-app experiments, and
compatibility testing before it is useful enough for the public OSS release.

For that reason, the initial development track runs in the private
`purrfectsoft/purrmission` repository. The public OSS repository remains the
stable home for released Purrmission behavior, while the private soft-fork holds
early passkey work until it is ready for a deliberate merge-back.

## Repository Roles

| Remote         | Repository                                        | Role                                                                 |
| -------------- | ------------------------------------------------- | -------------------------------------------------------------------- |
| `origin`       | `https://github.com/kuasha420/purrmission`        | Public OSS source and release line.                                  |
| `purrfectsoft` | `https://github.com/purrfectsoft/purrmission.git` | Private experimental soft-fork for Passkey-Aware Access development. |

The private repository is a soft-fork, not a permanent product fork. The goal is
to incubate the experimental epic safely, then merge back once the work has a
clear security model, tests, documentation, and compatibility story.

## Current State

As of 2026-06-24:

- `purrfectsoft` is configured as a second git remote.
- `purrfectsoft/master` has been seeded from the OSS checkout.
- The experimental source-of-truth docs have been pushed to
  `purrfectsoft/master`.
- The public `origin` remote has not received the passkey planning commits.

## Local Setup

For a checkout that does not already have the private remote:

```bash
git remote add purrfectsoft https://github.com/purrfectsoft/purrmission.git
git fetch purrfectsoft
```

To confirm the local remote map:

```bash
git remote -v
```

Expected remotes:

```text
origin       https://github.com/kuasha420/purrmission (fetch)
origin       https://github.com/kuasha420/purrmission (push)
purrfectsoft https://github.com/purrfectsoft/purrmission.git (fetch)
purrfectsoft https://github.com/purrfectsoft/purrmission.git (push)
```

## Development Workflow

1. Pull public OSS updates from `origin` when starting a passkey work session.
2. Integrate those updates into the private track before starting new feature
   work.
3. Create feature branches for private work using the epic issue IDs when
   available, for example `paa/003-chromium-webauthn-proxy`.
4. Push experimental branches only to `purrfectsoft`.
5. Open private PRs against `purrfectsoft/master` for review and sprint
   tracking.
6. Keep public `origin` untouched unless a change is explicitly approved for
   OSS merge-back.

Suggested branch commands:

```bash
git fetch origin
git fetch purrfectsoft
git switch master
git merge origin/master
git push purrfectsoft master:master
git switch -c paa/003-chromium-webauthn-proxy
```

When a private feature branch is ready:

```bash
git push purrfectsoft paa/003-chromium-webauthn-proxy
```

## Sprint Workflow

The sprint structure lives in the
[Passkey-Aware Access epic](../epics/passkey-aware-access.md). Each sprint
should produce one of the following:

- A merged private implementation PR.
- A documented spike result with clear next decisions.
- A compatibility or threat-model finding that changes the plan.

Sprint notes should update the epic tracker, design doc, or a dedicated report
under `docs/reports/` so decisions do not live only in chats or PR comments.

## Documentation Workflow

The private track should keep docs close to implementation:

- Update [the design doc](../design/passkey-aware-access.md) when architecture,
  security assumptions, or custody modes change.
- Update [the epic tracker](../epics/passkey-aware-access.md) when sprint scope,
  issue IDs, or graduation criteria change.
- Add `docs/reports/YYYY-MM-DD-*.md` for spike outcomes, compatibility testing,
  and threat-model reviews.
- Update public-facing docs only when a behavior is ready to merge back.

## Security Rules

- Do not treat the private repo as a secret store.
- Do not commit real passkeys, private keys, tokens, recovery codes, `.env`
  files, local databases, browser profiles, or device-exported credentials.
- Keep all passkey work behind an experimental flag until graduation.
- Purrmission Core must not be able to sign WebAuthn assertions without a
  companion device.
- Guardian approval must grant a short-lived lease, not permanent background
  signing permission.
- Local user verification must remain a separate requirement from guardian
  approval.

## Keeping the Soft-Fork Fresh

Public OSS changes should continue to flow into the private track:

```bash
git fetch origin
git fetch purrfectsoft
git switch master
git merge origin/master
git push purrfectsoft master:master
```

If the private track develops long-running feature branches, rebase or merge the
latest `purrfectsoft/master` into those branches during each sprint to keep
merge-back cost visible.

## Merge-Back Workflow

When the epic is ready to leave experimental status:

1. Confirm the graduation criteria in the epic tracker.
2. Run the full test suite and any companion-app/browser compatibility suites.
3. Write or update the public threat model.
4. Split the private work into reviewable OSS PRs.
5. Remove private-only notes, credentials, compatibility artifacts, and
   implementation dead ends.
6. Open public PRs against `origin` with clear migration notes and limitations.

The expected merge-back should be boring: no mystery architecture, no hidden
state, and no "trust us" security claims. Every important decision should be
traceable to the design doc, epic tracker, private PR history, or spike reports.
