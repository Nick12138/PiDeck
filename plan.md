# PiDeck 上游功能复刻计划(1/2/3 三项)

> 背景:上游 Skitre/PiDeck 已发布 v0.2.2(另有 23 个未发版开发提交)。
> 本地从 v0.1.9 分叉,自研了大量功能(多会话后台保留、子代理系统、包市场分页等)。
> 本次只复刻 3 项,不直接同步上游。

## 执行顺序(用户指定)

**先做第 2 项 → 再做第 3 项 → 第 1 项暂缓**

- 第 2 项不依赖第 1 项(已验证本地 0.82.1 SDK 具备 `clearModel()` / `setThinkingLevel()` / `get extensionRunner()`,均为 public API)
- 第 3 项不依赖第 1 项
- 第 1 项(SDK 升级)**用户已决定暂时不做**,方案保留备查,需要时再重启

## 状态跟踪

- [x] 第 2 项:Provider 全禁用时不自动选回已禁用模型 — **已完成**
  - 新增 `packages/pi-host/src/no-model.ts` + `no-model.test.ts`(5 用例)
  - `provider-controller.ts` `reconcileIdleActiveSessionModel` allowNoModel 分支改用 `clearSessionModel` + 发布快照
  - 更新 `provider-controller.test.ts` 旧断言(禁用最后一 Provider → 会话清为 unknown 哨兵)
  - 复用 SDK 0.82.1 原生 `session.clearModel()`(无需升级 SDK)
- [x] 第 3 项:Host PATH 继承与 bundled 运行时隔离(简化版)— **已完成**
  - `pi_host.rs`:PATH = 用户 PATH 在前 + bundled Node/Git 追加兜底;新增 `build_host_path()`、`PiHostManager::bundled_bash_from_git()`
  - 新增 `PIDECK_BUNDLED_NODE/GIT/BASH` 描述符环境变量(进 RESERVED_ENV)
  - `packages/pi-host/src/internal-runtime.ts` + 测试;`git-service.ts` 默认 executable 优先 bundled git
  - `scripts/smoke-staged-host.mjs` 同步新 PATH/描述符行为
  - Rust 测试 76 全过(新增 3 个)、TS 测试 742 全过
- [ ] 第 1 项:Pi SDK 0.82.1 → 0.84.2 — **暂缓,不做**

---

## 第 2 项:Provider 全禁用时不自动选回已禁用模型

### 现状(代码定位)
- `packages/pi-host/src/provider-controller.ts` `reconcileIdleActiveSessionModel`(第 453 行)
- 无可用模型时本地行为:直接 `return`(第 503-505 行),注释「No SDK API to clear a model once set; the session keeps its current model」
- **实际 bug**:全禁用 Provider 后,闲置会话保留旧模型(可能已被禁用的),且不发布新快照,界面状态与实际不一致

### 方案(参考上游 v0.2.2 `no-model.ts`,0.82.1 兼容实现)
1. **新增 `packages/pi-host/src/no-model.ts`**:
   - `PIDECK_NO_MODEL` 哨兵模型(provider/id 均为 `"unknown"` 的冻结对象)
   - `isPideckNoModel(model)` 判断函数
   - `clearSessionModel(session)`:写入 `session.agent.state.model = PIDECK_NO_MODEL` + `setThinkingLevel("off")` + `extensionRunner.emit({type:"model_select",...})`
   - `publishIdleActiveSessionSnapshot(factory)`:复用现有 `buildSessionSnapshot`(本地已有,`session-snapshot.ts:166`),revision 不变,`server.emit("session.snapshot", snapshot)`
2. **改 `provider-controller.ts`**:`reconcileIdleActiveSessionModel` 的 `allowNoModel` 分支从 `return` 改为 `clearSessionModel(session)` + `publishIdleActiveSessionSnapshot(factory)`
3. **测试**:
   - 新增 `no-model.test.ts`(哨兵、clear、快照发布)
   - `provider-controller.test.ts` 增补用例:全部 Provider 禁用后,闲置会话模型为 unknown,并发出 `session.snapshot`

### 验收
- 关闭全部 Provider → 闲置会话显示"无模型",不会悄悄切到已禁用模型
- 重新启用 Provider → 正常选中模型,无残留状态
- `pnpm verify:quick` 通过

---

## 第 3 项:Host PATH 继承与 bundled 运行时隔离(简化版)

### 现状(代码定位)
- `apps/desktop/src-tauri/src/pi_host.rs` 第 1845-1862 行:
  Windows 发布版 Host PATH = bundled node 目录 + bundled `git/cmd` + `git/bin` + `git/mingw64/bin` + `System32`,**用户 PATH 被整体丢弃**(仅非 Windows / debug 构建才追加用户 PATH)
- 影响:
  - Agent Bash / 终端里找不到本机工具(mise、pnpm、uv、python 等)
  - `git` 固定是 bundled 便携版,版本/凭据/SSH 行为不可控
- 本地无 `PIDECK_BUNDLED_*` 环境变量机制(上游新增,本地没有)

### 方案(只做核心,不做上游的 git-service 大重构)
1. **`pi_host.rs`**:
   - Host 子进程**不再设置 PATH**(继承桌面启动环境的用户 PATH),或在 Windows 也改为「用户 PATH 在前 + bundled 目录在后」
   - bundled node/git/bash 通过显式环境变量传给 Host:`PIDECK_BUNDLED_NODE` / `PIDECK_BUNDLED_GIT` / `PIDECK_BUNDLED_BASH`(参考上游 `host_child_explicit_env` 设计,新增一个 `host_child_explicit_env` 辅助函数)
   - 保留 `strip_verbatim_prefix` 处理(`\\?\` 前缀问题)
2. **`packages/pi-host` 侧**:
   - 新增 internal-runtime 风格的小模块(读取 `PIDECK_BUNDLED_GIT` 等环境变量,导出内部工具路径描述符)
   - 定位本地 Agent Bash 启动点(当前 `packages/pi-host/src/` 无 `agent-bash*` 文件,需先确认 bash 从哪启动),改为:优先用户 PATH 的 bash → 找不到再回退 `PIDECK_BUNDLED_BASH`
   - 内部 git/npm/node 子进程(包安装、git 操作)显式用 bundled 路径;`git-service.ts` 最小改动:优先环境变量描述符,退化到 PATH 查找
3. **测试**:
   - `pi_host_tests.rs`:验证 Host 继承用户 PATH、bundled 描述符 env 正确注入
   - pi-host 侧:用户 PATH 优先 / 回退 bundled bash 的用例

### 验收
- Windows 发布包:Agent Bash 里 `git --version` / `mise` 等能看到本机版本与工具
- 干净 Windows(无系统 Git Bash):Agent Bash 仍可用(bundled 回退)
- 内部 npm/git 操作不受影响(仍走 bundled)
- `pnpm verify:p0` 通过(含 Rust 测试)

### 注意
- 不照搬上游 `git-service.ts` 315 行重构,保持本地实现最小改动
- `npm.cmd` 对 PATH 的可解析要求仍要满足

---

## 第 1 项:Pi SDK 0.82.1 → 0.84.2(最后做,工程最大)

### 现状
- 本地依赖 `@earendil-works/pi-coding-agent` / `@earendil-works/pi-ai` 均为 0.82.1
- 本地 patch `patches/@earendil-works__pi-coding-agent@0.82.1.patch` **720 行**,涉及:
  - `dist/core/agent-session.*`(子代理系统核心)
  - `dist/core/extensions/*`(runner/wrapper/types — 扩展机制)
  - `dist/core/package-manager.*`、`dist/core/sdk.*`、`dist/core/resource-loader.js`、`dist/index.d.ts`
- 上游 0.84.2 自己的 patch 409 行(上游适配内容,与本地 patch 不同)

### 方案
1. **准备阶段**
   - 梳理本地 patch 720 行,按功能分类(子代理 / 扩展 / 包管理 / SDK)
   - 梳理上游 0.82.1→0.84.2 接口变化(参考上游 patch、`pi-ai/compat` 的 `ProviderHeaders` 等新类型、上游 changelog)
   - 新建独立实验分支 `pideck-sdk-0.84.2`(不在 main 上直接动)
2. **升级步骤**
   - `packages/pi-host/package.json` 提升 `pi-ai`、`pi-coding-agent` 到 0.84.2
   - `pnpm install` 刷新锁文件与 patch hash
   - **移植本地 patch**:逐块对新版 dist 重写 720 行 patch(不能直接套用)
   - **合并上游 0.84.2 patch 适配点**:只取与本地功能相关的部分,不照搬上游全部
   - 适配接口变化(`ProviderHeaders` 等),涉及 `provider-controller.ts`、`sdk-adapters/*`
   - 刷新 `scripts/release-runtime.lock.json` / `release-sdk-evidence` 证据
3. **验证(重点回归)**
   - 子代理系统:暂停/继续、运行面板、回退模型
   - 扩展 UI / 扩展机制、Provider 设置、模型 thinking profiles
   - 会话快照、后台任务保留(第 2 项成果)
   - `pnpm verify:p0` 全量

### 风险
- 本地 patch 720 行重移植工作量大,可能多处冲突
- 0.84.2 内部行为变化(会话快照、extension runner)可能导致本地自研回归
- patch hash 变化影响锁文件与 release 证据,发布前必须刷新
- 若重移植中发现 0.84.2 无收益点,可暂停并回退分支(本项为可选升级)

### 验收
- 依赖全部 0.84.2,`pnpm verify:p0` 通过
- 第 2、3 项成果在 0.84.2 上行为不变
- 子代理/扩展机制全量回归通过

---

## 明确不做(记录在案)
- extension UI surfaces(浮窗拖拽/独立 OS 窗口):上游未发版、方案未定型,等发版后评估
- 用量页活动 dashboard、工作区/会话可拖动分隔等 UI 打磨:非本次范围
- 上游 `git-service.ts` 全量重构:第 3 项用简化方案替代
