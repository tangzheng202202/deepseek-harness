# Agent Note: 固定 Koffi 版本以验证缺少可选依赖时的打包安装

Status: implemented

[English](2026-10-02-pin-koffi-for-packed-install.md) | 中文

## Problem

六个 dsh 包依赖 Koffi。[打包安装验证](../../../../scripts/release/verify-packed-install.ts)省略可选依赖，以验证 Landlock 入口在缺少平台包时仍可启动。全新的 npm 消费端可能根据 `^3.1.0` 选择 Koffi 3.3.2，而非工作区锁文件中的 3.1.1；缺少可选平台二进制时，3.3.2 在 Linux 的 Node 24 环境中编译 `src/koffi/src/uv.cc` 失败。

## Decision

六个包的 manifest 均将 Koffi 精确指定为 `3.1.1`，与工作区锁文件一致。打包安装验证继续省略可选依赖。变更 Koffi 版本时，六个 manifest 和锁文件一并更新，并在发布前运行 Linux Node 24 打包安装作业。

## Alternatives considered

**在打包安装验证中安装可选依赖。** Koffi 会使用平台二进制，但验证将不再覆盖 Landlock 入口缺少可选平台包时的启动行为。

**保留 semver 版本范围。** 即使工作区锁文件仍选择 3.1.1，全新的 npm 消费端也可能选中未经验证的 Koffi 版本。

## Consequences

当 Koffi 的可选二进制不可用时，发布验证仍会检查源码安装。升级 Koffi 需要明确修改 manifest 和锁文件。打包安装作业通过时，只证明在该 Linux runner 上可安装且 CLI 能报告版本；并未覆盖所有使用 Koffi 的运行时操作。
