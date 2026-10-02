# Agent Note: Pin Koffi for packed installation without optional dependencies

Status: implemented

English | [中文](2026-10-02-pin-koffi-for-packed-install.zh.md)

## Problem

Six dsh packages depend on Koffi. The [packed-install probe](../../../../scripts/release/verify-packed-install.ts) omits optional dependencies so it can verify that the Landlock entry starts without its platform packages. In a fresh npm consumer, `^3.1.0` can resolve to Koffi 3.3.2 instead of the workspace lockfile's 3.1.1; without its optional platform binary, 3.3.2 fails to compile on Linux with Node 24 at `src/koffi/src/uv.cc`.

## Decision

The six package manifests specify Koffi `3.1.1` exactly, matching the workspace lockfile. The packed-install probe continues to omit optional dependencies. A Koffi version change updates all six manifests and the lockfile together and runs the Linux Node 24 packed-install job before release.

## Alternatives considered

**Install optional dependencies in the packed-install probe.** Koffi would use its platform binary, but the probe would no longer exercise the Landlock entry without its optional platform packages.

**Keep a semver range.** A fresh npm consumer can select an unverified Koffi release even while the workspace lockfile continues to select 3.1.1.

## Consequences

The release probe keeps exercising source installation when Koffi's optional binary is unavailable. Koffi upgrades require an explicit manifest and lockfile change. Passing the packed-install job verifies installation and the CLI version on its Linux runner; it does not exercise every Koffi-backed runtime operation.
