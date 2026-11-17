# ChatGPT Web 400K 路线与 1M 可检索历史：集成及验收计划

审查日期：2026-11-18。基线：magpie-chatgpt-web 0.5.7，提交 `8af059659f152e5f601be4579f44b68c2dc27cbe`，参考运行时 `codex-chatgpt-web` v6.1.18。本文记录源码审查与已有历史证据，不代表本次重新执行了在线试验。计划中的实现与验收不能作为已交付能力。

## 结论与对外表述

**用户最新确定两条并行交付主线：保留 Web 登录，按官方 Pro Reasoning 400K 总窗口目标重新核验具体 Web Pro 路由，同时实现至少 1M 可检索历史（逻辑记忆）。约 100K 不作为最终交付窗口。** 原生 1M 不再是本轮交付前提，但不能用逻辑记忆取代 400K 路线调查。必须自动保存压缩前 canonical history，按账户和 thread 隔离，允许模型按需查询原文，并在检查点恢复及 daemon 重启后继续读取。本文只设计接口和实验，主 agent 负责集成，存储 agent 负责加密存储。

**当前仍没有实现或验证 ChatGPT Web 原生 1M 上下文，不能无修饰地声称“完成 1M”。** 逻辑记忆功能在集成与验收之前也不能标为已交付。既有证据只证明有限输入规模的工具工作流、认证摘要交接和部分重启续接；约 206K 与 275K 的历史大输入试验已经出现显著信息恢复失败。

修改 `context_window`、提高压缩阈值、增加分段数、累计发送一百万 token，或保留浏览器页面，均不能证明上游模型获得了一百万 token 的同时可用上下文。现有生产 guard 只是等待重新验证的暂时边界，不是最终目标；隔离探针可以调整本地实验预算以区分本地拦截与上游行为，但不能把解除本地拦截后的发送成功当作容量验收。

当前约 100K 是本地保守 guard、目录发布映射及宿主预留共同作用的结果，不是已测得的 Web 上游硬上限。400K 路线必须分别核验传输、召回与压缩，成功后据实际证据调整生产预算；失败时报告具体层次和硬阻塞，不能用旧 100K 限额代替调查。官方 API 的长窗口能力只作为产品边界参照；本轮不切换 API，也不将其作为已交付方案。

## 术语与验收对象

本文的 1M 指 **1,000,000 token**，必须注明所用 tokenizer、目标模型及计算范围，不指字符数、文件字节数或累计计费 token。

| 能力 | 含义 | 能否称为 Web 原生 1M |
| --- | --- | --- |
| 原生 1M 输入 | 在同一次目标推理中，至少 1M token 的原始目标内容可用；还须为系统、工具、推理与输出满足相应预算 | 只有目标 Web 路由具备能力且通过对应验收后才可声称 |
| 标称 1M 总窗口 | 输入与其他上下文／生成预算共享一个标称窗口 | 不能直接等同于 1M 用户输入 |
| 1M 逻辑记忆 | 外部持久存储保存至少 1M 原文，模型分次读取相关片段 | 否；当前单次推理仍受原有窗口限制 |
| 滚动摘要／压缩 | 用摘要及保留消息继续执行更长任务 | 否；摘要可能丢失信息 |
| 1M 累计处理 | 多次请求的输入或输出合计超过 1M | 否；不能相加为一次推理窗口 |
| multipart 完整送达 | 多条消息完整写入同一会话，收到回显或确认 | 否；会话保存范围不等于最终推理纳入范围 |

原生容量和任务正确率还须分开：容量声明不保证所有问题都能正确回答，而少量标记恢复成功也不能单独证明完整原文均进入推理。

## 0.5.7 当前路径与边界

### Fresh input

Native fresh 路径编译完整 canonical history，执行完整输入、物理消息与传输检查，再取得页面并提交。Pro 输入达到 `112193` token 拒绝；Pro-capable 账户上的 Sol 输入达到 `111193` token 拒绝。检查覆盖工具结果轮次以及 compaction 裁剪之前的完整历史，不能用一个很小的 resume delta 掩盖完整输入超限。

基线 compaction 还受参考实现 `110000` 字节 inline 约束。必要时可尝试两段、再六段传输，必须保留完整记录；只有明确的 fit 错误允许尝试另一分配方式。拆分解决的是消息封装问题，不扩大服务端推理窗口。

源码：[runtime guards](../src/native/runtime.mjs)、[compaction transport](../src/native/compaction-transport.mjs)。历史解释：[完整历史防裁剪检查与传输](verification-0.5.6.md)。

普通文本路径另有本地估算上限：Instant `41000`、Reasoning `90000`、Pro `111001`，包含 `8192` token 产品预留及相应图片预留。这些是保守发送保护，不是官方精确上游容量；不能与 Native 数字混用。源码：[文本预算](../src/usage/context.mjs)、[发送前检查](../src/loader.mjs)。

### Retained compaction

Retained 路径在本进程持有的确切源页面上发送短摘要控制消息，经原有认证 broker 接受 handoff 后生成续接检查点。0.5.7 让此路径先于 fresh-request 大小检查；完整 canonical history 仍计入估算 usage，但不会因此重新作为完整浏览器消息发送。

仅计量路径由私有 `Symbol` 控制，序列化请求不能选择它。源页面不可用时，fresh fallback 仍必须通过完整历史 guard；超限不能悄悄删历史。源页面要求与认证 handoff 不能放宽为“找到相同 URL”或“模型声称已生成摘要”。

页面注册表默认最多 8 页，空闲复用资格 300 秒，按 exact Page handle 管理；导航、关闭、过期、所有权冲突或进程退出会使复用不可用。已认证的检查点可以持久化，页面本身不能跨进程恢复。

源码：[retained budget](../src/native/retained-budget.mjs)、[managed host](../src/native/retained-host.mjs)、[页面注册表](../src/native/retained-pages.mjs)。离线回归源码：[retained fixture](../test/fixtures/native-retained-host-fixture.mjs)，覆盖伪造 count-only、超限 fresh fallback 和缺失源页面；本文没有重新运行这些测试。

### 目录、压缩与持久化

- Native Pro/Sol 在上述账户能力下发布 `105556`，映射 `95000` 的参考压缩目标；历史 Codex 有效显示为 `100278`。目录窗口、有效显示与触发阈值不是上游能力证明，90% 也不是固定摘要压缩率。[源码](../src/native/models.mjs)
- `gpt-5.6-luna` 的 `1050000` 目录值属于独立 rolling-checkpoint 路径；项目说明其普通 Free 浏览器预算为 `28000`，不能据此宣称 Pro 或所有 Web 模型支持 1M。[说明](../README.md#context-windows-and-compaction-in-codex)
- 检查点存储最多 256 条，序列化明文最多 32 MiB，使用账户绑定的加密状态。它用于已认证续接，不是通用无损原文档案；条目和字节上限也不是模型 token 容量。[源码](../src/native/checkpoints.mjs)

## 历史容量证据

以下 token 数主要为本地编译／传输估算，不是上游 tokenizer 实测，也不是账户剩余额度。不同试验的封装与是否使用工具有差异，不能合并为同一个容量测量。

| 历史试验 | 结果 | 允许的结论 |
| --- | --- | --- |
| 0.5.4 约 275–276K，六段；另有无工具、全 Pro staging 对照 | 均只恢复 4/12 标记 | 工具执行或 effort 切换不是失败的唯一原因；大窗口未通过 |
| 206283，cut109 | stage 0/7，commit 5/5 | 大输入保留失败 |
| 206285，cut108 | stage 0/6，commit 6/6 | 跨界标记进入末段后才恢复，呈现边界相关性 |
| 206283，High→High | 5/12 | 统一 effort 不足以修复 |
| 206283，Pro→Pro | 5/12 | 统一为 Pro 不足以修复；这是冻结 high-compiled 字符串的选择器对照，不是 fresh Pro compiler 验收 |
| 减少 filler 至 92610，仍保留 214 条记录与原始关联 | 12/12 | 较小输入对照通过，不是大窗口验收 |
| 第一段约 100K 保持不变，只缩短最后一段；合计 116459 | stage 7/7，commit 5/5 | 原始第一段可以被后续请求利用；失败与后续载荷大小／内容有关，不能推出精确阈值 |
| 两个 Pro 模型约 76.6K 初始输入，retained compaction 后重启续接 | 检查点及续接均 12/12，其中十项初始未询问 | 这两个基线样本的 retained handoff 与续接通过 |
| 0.5.7 自动 compaction，历史计量 113550 | 检查点及最终答案 12/12，后续三项测试通过 | 已存历史的压缩续接通过，不是 113550 fresh 输入容量或 1M 证明 |

本地可审阅来源：

- [0.5.4 验证报告](verification-0.5.4.md)：包含宿主截断导致无效的早期样本、六段失败与撤回 Pro 扩窗的原因。
- [0.5.6 验证报告](verification-0.5.6.md)：包含分段、大小、同 effort、同 Pro、短 commit 对照以及约 76.6K retained/restart 样本。
- [分段试验证据投影](evidence/context-partition-0.5.6.json)：记录各 arm 的模型、估算、回忆结果、覆盖／父链与源文件哈希。
- [Retained compaction 证据投影](evidence/retained-compaction-0.5.6.json)：区分 GPT-6 显式重启与 GPT-5.6 已停止后重新启动。
- [0.5.7 自动 compaction 证据](evidence/automatic-compaction-0.5.7.json)：明确大型工具输出在进入历史前被 Codex 截至约 40K 字符。`113550` 是 retained 历史计量，不能解释成等量 fresh payload 被送入模型。

大输入对照记录了完整片段送达、服务器回显和同会话父链；这些排除了部分本地丢包／分支错误解释，但没有观测上游实际推理内容。当前不能断言“已证明服务端截断”，也不能断言“只是模型忘记”。每个 arm 的有限样本不足以建立通用容量阈值。

## 官方资料与 Web 真实 1M 硬阻塞

官方资料在 2026-11-18 查阅；产品和账户能力可能变化，应在未来验收时重新记录快照日期。

1. [ChatGPT 官方价格页](https://chatgpt.com/pricing/)列出 Pro Instant 总窗口 128K、Reasoning 总窗口 400K。其输入容量脚注说明，用户输入还要与系统指令、工具、记忆和内部处理共享窗口，实际输入空间会变化。该页面不能作为当前 Web 路由 1M 输入的保证，也不等于某个账户内部模型 slug 的精确上限。
2. [ChatGPT 官方发布说明](https://help.openai.com/en/articles/6825453-chatgpt-release-notes)的 2026-02-20 条目将 Thinking 256K 总窗口明确拆为 128K 输入和 128K 最大输出。这是历史产品说明，不是当前 GPT-6 Pro 的精确容量。
3. [GPT-6 官方 ChatGPT 模型说明](https://help.openai.com/en/articles/20001354-gpt-6-and-other-models-in-chatgpt)在本次查看中未提供上下文窗口数字；不能从模型名称或 Pro 可选性推导 1M。
4. [GPT-5.4 官方 API 模型页](https://developers.openai.com/api/docs/models/gpt-5.4)标注 1050000 context window、128000 max output。API 产品的能力不能转移解释为 ChatGPT Web 的能力；它不构成本项目已交付的替代方案。

| 硬阻塞 | 当前证据 | 解除条件 |
| --- | --- | --- |
| 目标 Web 路由没有已确认的原生 1M 输入能力 | 官方 Web 资料未提供此保证；本地 `proAvailable` 只判断可选模型／effort | 取得与目标账户、模型、产品路由对应的明确容量依据，并验证实际行为 |
| 上游实际推理纳入范围不可观测 | 大输入全部送达且父链一致，仍丢失多数前段标记 | 获得可支持纳入范围的上游证据，并通过重复功能验收；仅 ACK／回显不够 |
| 现有扩窗功能验收失败 | 约 206K、275K 对照失败，同 Pro 也不能修复 | 解释并修复失败，完成分层回归；不能靠隐藏失败或删原文通过 |
| 完整性链路存在已知截断风险 | 旧 additionalContext 大条目及 0.5.7 大工具输出曾被宿主截断；参考 compaction 有 fit-recovery 风险 | 在截断前后核对完整性，超界显式失败；所有目标原文须可追踪 |
| 本地发送与续接边界不允许直接扩为 1M | guards、消息大小、封装、模型选择、retained 生命周期及认证都独立存在 | 在上游能力得到支持后逐项审计与验收；不能只改目录数字 |

历史账户目录曾记录 `gpt-6-pro.max_tokens=410000`、Thinking `262144`，但字段语义及有效输入权益未验证；不能将其当成精确输入容量，也不能依据 plan `prolite` 猜测隐藏限额。见 [0.5.6 的 Same-account upstream catalogue metadata](verification-0.5.6.md)。

2026-11-18 主 agent 提供的新同机 Bridge 真实账户 `models` 读取结果：`gpt-6-pro` 和 `gpt-5-6-pro` 的 `max_tokens` 均为 `410000`；`gpt-6-thinking` 和 `gpt-5-6-thinking` 均为 `262144`；返回对象没有 `context_window` 或 `input_token_limit` 字段。本次文档审查未独立发起该账户请求，尚未收到对应证据文件路径，因此标注为主 agent 新提供的观察，不冒充已经写入旧 JSON 投影。该结果加强了重新探测当前 400K 路线的必要性，但未确定 `max_tokens` 是输入、总窗口还是其他目录预算；不能直接开放 410K 输入，也不能假定 400K/410K 差异仅由十进制／二进制换算造成。

## 阶段计划与验收表

以下为待执行计划。当前交付主线是 P0/P1/P2/P5、W1–W4（下文 400K 路线）与 L1/L2；P3/P4 的原生 1M 研究不作为本轮交付前提。两条已接受主线分别报告状态，逻辑记忆通过不代表 400K 路线完成。本文不新增在线请求、账户或运行配置修改授权；后续执行遵循主任务的明确授权范围。

| 阶段 | 最小工作 | 验收与产物 | 当前状态／停止条件 |
| --- | --- | --- | --- |
| P0 定义与基线 | 固定 1M 定义、版本、模型、账户能力、tokenizer、数据集和评分规则；区分 fresh、retained、逻辑记忆 | 可复现 manifest、原文哈希、预算定义；沿用失败证据，不能只保留成功样本 | 本文完成定义与历史盘点；新基准未执行 |
| P1 离线完整性审计 | 对 canonical history、additionalContext、工具结果、summary replacement、序列化和 multipart 做无网络回放 | 对目标记录逐条比较顺序、标识、内容哈希；不丢／改记录；超界明确报错；权限和认证负例仍拒绝 | 待独立验收；离线通过不代表 Web 容量通过 |
| P2 续接正确性 | 在现有预算内验证 retained、fresh fallback、模型切换、过期和进程重启 | 明确每次使用的路径；摘要只能由认证 handoff 接受；源不可用时按规则拒绝；历史关联与真实工具结果核验 | 既有基线样本部分通过；模型切换后的 502 线索仍待主任务查明 |
| P3 Web 容量前置门 | 核实目标 Web 路由的输入／总窗口／输出预算与账户能力；准备分层探针 | 有足以支持目标容量的依据；冻结预算及测试环境；每层通过后才进入更大规模 | 当前硬阻塞；不能修改 guards 强行宣布通过 |
| P4 原生 1M 功能验收 | 在取得执行授权和容量依据后，分层到 1M 原文；随机化位置与跨段关联；禁止摘要或检索代替原文 | 每个数据层至少三个预先固定的独立随机种子；原文完整性 100%；声明的精确关联任务全对，另报跨段推理结果；记录所有失败与实际模型；fresh 与 retained 分开报告 | 未执行；功能通过仍须与上游容量证据共同解释，不保证任意任务无损 |
| P5 生命周期验收 | 独立验证压缩、工具执行、模型切换、页面失效与 daemon 重启后的行为 | 检查点与原文来源可追溯；无静默回退、重复发送或认证放宽；明确压缩后不再等同原生完整 1M | 未执行；小样本续接不能替代 P4 |
| L1 已接受的逻辑记忆 | 新增独立无损原文存储、索引、分段读取、版本及来源引用；自动保存压缩前已收到的 canonical history | 去重后的文本原文至少 1M token，可按记录重建；不依赖摘要恢复原文；存储、检索和预算失败显式可见；宿主预先截断的部分明确不在覆盖范围 | 主 agent 集成、存储 agent 实现；本文不声明完成 |
| L2 逻辑记忆质量与恢复 | 在当前发送预算内做未知查询、跨片段任务、压缩及重启恢复 | 分别报告检索命中、答案质量、来源正确性、当前发送量与累计原文量；重启后原文哈希不变 | 待实现；只能标注逻辑记忆能力 |

P4 的 oracle 应置于模型无法读取的位置。标记问题应在数据提交后提出，避免前序答案或摘要泄露全部目标值；同时保留非标记任务，避免把一个特定 needle 测试当成通用长上下文质量保证。精确评分器应拒绝错配、重复、部分值和无关联的裸值，并能正确处理 Markdown 表格转义和换行。

每份验收记录至少包含：源版本、宿主版本、实际请求模型与 effort、完整原文规模、tokenizer、预算预留、原文／编译后哈希、实际分段、物理 Send、回显与父链、观察缺口、评分器版本、压缩情况、工具是否读取外部原文、检查点来源以及清理结果。不得用累计 usage 替代单次规模，也不得把本地估算标为上游精确计量。

## 逻辑记忆的最小架构边界

L1/L2 使用独立、可恢复的原文存储，不将现有有界检查点 registry 当作档案库。原文先保存并计算哈希，再生成摘要和索引；摘要仅用于导航。模型通过明确的读取／检索工具取得有限片段，所有返回内容携带来源与版本，并受当前 fresh-input 预算约束。

续接检查点可携带档案版本、引用和任务状态，不能伪造环境权限、工具能力或 broker 授权。重启后应从原文档案恢复检索能力，而不是假定浏览器页面仍存在。若宿主在插件接收前已经截断工具结果，必须在宿主／工具输出边界提供完整原文存储或可验证引用；下游插件不能重建从未收到的字节。

界面与报告应分别展示“累计保存原文”“本次发送”“摘要”“本次检索覆盖”，不得合成一个误导性的 1M 模型窗口。没有选择为本轮输入的档案内容不属于该轮原生上下文。

## 最小生产集成：选择现有 Native broker 扩展

### 选择依据与已核实接点

| 路线 | 已核实条件 | 判断 |
| --- | --- | --- |
| Plugin `tool` 注册 | `src/index.mjs:createHooks` 当前没有 tool hook；本机宿主源码支持 `tool: {name: {description,args,execute}}`，但 `internal/plugin/host.js:1927` 的执行上下文将 `sessionID`、`messageID`、`callID` 均置空，只有 agent 标签 | 注册本身简单，但缺少可信账户／thread 绑定。不能靠模型传入 thread/account 或“最近活跃聊天”补足；若走此路还需额外能力通道，不是当前最小方案 |
| Native broker 内置历史工具 | 现有 `codex_tool_inventory` / `codex_tool_call` 已通过 broker 的 claim/binding 获取环境及调用；已具备账户 daemon、turn token、binding 和撤销生命周期 | **采用此路线**：增加三个有界只读工具，在已验证 binding 上本地执行，不转交外层 Codex host |

本机只读检查依据：`C:/Users/Administrator/orca/scratch/magpie-verification-host-source/internal/plugin/tools.go:22`、`internal/plugin/host.js:1927`、`internal/gateway/tools_mcp.go:296`（后两者均相对同一宿主源码根）。这是已检查的本机宿主版本，不声称所有 Magpie 版本都缺少 thread 元数据。

参考 bundle：`C:/Users/Administrator/.config/magpie/chatgpt-web-native/runtime-6.1.18/payload/app/cli.js`，本次只读校验 SHA-256 为 `df24ed1df556e0f51470ad13e48ebded6a4efa345afa165f0f64ead4a3fe87c1`。下述 minified 符号仅对该 checksum 有效；补丁必须检查唯一 anchor 并在漂移时失败。

| 接点 | 当前行为 | 拟集成动作 |
| --- | --- | --- |
| `src/native/hooks.mjs:onRequest` → `provenance.prepare` | 暂存宿主转换前请求，内存有界；完成后撤销 | 保持捕获和校验，不在未确认账户／thread 时直接落盘 |
| `src/loader.mjs:makeLoader` 内 `restore(nativeRequest, current.profile, ...)` | 校验 account/route proof 并恢复 detached canonical 请求 | 作为完整原始输入来源；不在此仅凭模型传来的 thread 字段授权档案读取 |
| pinned adapter `runTurn` 的 `D=m.resolve(f)`，即 `Vu.resolve` | 解析可信执行环境，失败时返回 missing cwd 等错误 | 校验成功后捕获 `f._rawBody.input` 的文本记录，并绑定已验证 thread；必须审计 compaction 分支覆盖，见下文 |
| `ue(f).threadId` | 从 raw metadata 提取 thread ID，本身不是认证函数 | 只能在可信 rollout／请求来源证明通过后使用；模型、effort、summary 内容不构成存储 scope |
| `Broker.register` / `updateEnvironment` | 注册、刷新 channel；内部复制 environment | 将私有 scope 传播到 channel，并对有效工具列表追加三个描述；不修改 canonical raw body |
| `Broker.dispatch` 的 binding 检查之后、compaction 分流之后、普通调用排队之前 | 原实现将普通调用加入 `invocations` 和 `queuedCallIds`，由 host 执行 | 对三个保留 wire name 做严格校验和本地只读处理；其余调用逐字保留原路径 |
| 编译器 `Xt` 的受控输入／指令构造 | 现有 guards 与 usage 依赖真实编译结果 | 在所有计量及编译之前一致加入简短检索说明；不在估算后附加文本 |
| `src/native/runtime.mjs` preload | 校验 checksum 后安装 retained、discovery 等变换 | 新增独立 history 变换／安装函数，保持失败关闭与可离线测试性；本文不新增该代码 |
| `src/native/index.mjs:identity`、`NativeDaemon.home` | 账户目录为 `accounts/<profile>` | 加密 store 由当前 daemon home 创建；不接受请求指定存储路径 |

[工具发现变换](../src/native/tool-discovery.mjs)目前只改变工具搜索结果展示，**不注册工具**；不能只在该文件加入名称就认为工具可调用。真实调用链的离线参考在 [broker/discovery 测试](../test/native-tool-discovery.test.mjs)：`register → claim → invoke → nextToolBatch → completeTool`。历史内置工具应在 invoke 排队前返回，因此还要验证它们不会进入 `nextToolBatch` 或被发给 Codex 执行。

### 主 agent 拟实现方案的结构审查

方案方向可行，但以下事项是集成门槛，不应假设现有封装自动处理：

1. **仅在 `D=m.resolve(f)` 后捕获，不能自动保证所有 compaction 都覆盖。** 该语句受 `if(y.localTools)` 控制；参考 runTurn 还会为 compaction 构造 `localToolsEnabled:false` 的能力视图。逐项证明 retained、fresh read-only compaction、显式 `/compact` 和工具结果后自动压缩都已完成归档。最小实现可在每个已认证普通请求增量保存，并在 compaction 入口检查本次完整 source manifest 已持久化；若有新记录必须通过同等 canonical/rollout 认证后补存。不得为补存关闭 `Vu.resolve` 检查，也不得将 `ue(f)` 的字段读取当成认证成功。
2. **WeakMap 原对象绑定不足。** `Broker.register` 保存 `{...environment}`；`updateEnvironment` 再次复制；外部 owner 的 `fl()` 还执行 `structuredClone`。将 scope 从私有 `WeakMap<environment, scope>` 传播到 `WeakMap<channel, scope>`，或账户 broker 私有 token→scope 表；成功更新后传播到新 environment。外部 owner、safe 模式、未知环境对象没有映射时不得自动获得历史。scope 不作为可序列化 environment 字段暴露；每次更新显式拒绝跨 thread。`Mm(environment)` 只比较 cwd/roots/writableRoots/sandboxPolicy，不替你检查 thread。
3. **wire name 不是点号语法。** pinned `It(namespace,name)` 返回 `namespace + '__' + name`。面向说明可写 `magpie_history.search/read/stats`，实际注册为 `namespace:'magpie_history', name:'search'|'read'|'stats'`，预期 wire name 为 `magpie_history__search/read/stats`（分别为三个完整名称）。以真实 inventory 输出和 `mt()` 为准；不要额外接受猜测的别名。与已有工具重名时显式报错，不能覆盖 host 工具。
4. **dispatch 的既有 binding 检查不是新工具参数校验器。** 原普通调用会排队交给 host；拦截后需自己验证严格 JSON schema、只读操作、参数上限、当前 scope 和工具实际注册状态。只处理 native invoke，拒绝 freeform、额外 thread/account/path 字段；不能在 `dispatch` 顶部抢先返回。保留 safe/completion/compaction/撤销控制；异步读取结束前再次确认 binding 未失效，取消后不返回原文。
5. **32 MiB 是字节预算，不是 1M token 证明。** 通常文本可能容纳，但 UTF-8、JSON 转义、记录元数据、加密封装、索引和重复历史都会占空间。必须对去重后的目标语料按指定 tokenizer 计数，测量实际持久化预算；不能靠 `bytes/常数` 宣称精确 1M。索引可重建但原文不能静默淘汰；写入超限时明确 `history_capacity_exceeded`，压缩不得在未保存所需原文时被报告成功。
6. **文本捕获不能只取 user.content 字符串。** 至少保存 message 的全部文本块及顺序、assistant 文本、function/tool call 参数文本和 `function_call_output` 的文本／结构化输出（包括 `agent` additionalContext）；保留 item/turn/call/source 标识和类型。不要对原文 trim、归一化换行或只存摘要。多模态原始二进制不在文本 1M 声明中，必须标记缺口／引用。raw body 里已被宿主截断的部分不能事后恢复。
7. **修改 parsed.context 时防止归档与身份漂移。** 原始 `f`、`_rawBody`、canonical revision、checkpoint hash 和环境认证保持不变；优先在专用编译输入副本或稳定的 compiler guidance 接点加入说明。所有预算预检和物理编译使用相同确定性说明，追加应幂等，不能每轮重复增长；不能给压缩控制轮加入“现在调用历史工具”而违背 summary-only 合约。
8. **本地工具结果也占推理预算。** 不经 host 意味着不能假定宿主会截断、计量、压缩这些结果。限制每次返回及每 turn 累计返回，记录已返回量；达到预算时拒绝继续读并引导正常续轮，不自动增加窗口。将必要的读取引用／审计写入独立 ledger，不能把派生检索结果当作新的原始事实无限重复归档。

### 交给加密存储 agent 的最小内部接口

以下为建议接口，**不是现有导出**。函数名可适配存储 agent 的实现，但语义与认证边界应保持：

```ts
// accountHome 仅由 daemon owner 提供；不来自模型参数。
const store = openHistoryStore({ accountHome, maxBytes: 32 * 1024 * 1024 });

// scope 只由集成层在可信来源验证之后构造；模型不持有此对象。
type Scope = { threadId: string };
await store.capture(scope, {
  captureId, turnId, sourceRevision, // 幂等键、可信来源与版本
  records,                         // 有序原始文本记录，带 kind/id/hash
  coverage,                        // received-canonical；已知截断/非文本缺口
}); // 返回 {manifestId, revision, addedRecords, uniqueTextTokens, tokenizerId}

await store.flush(scope, manifestId); // source manifest 持久化屏障
await store.search(scope, { query, limit, cursor });
await store.read(scope, { recordId, revision, offset, maxChars });
await store.stats(scope);
await store.linkCheckpoint(scope, { summaryHash, manifestId });
```

- `capture` 的幂等性以稳定 item ID／turn ID／内容 hash／source revision 组合实现；无 ID 时使用有序 source manifest 和稳定 occurrence 身份，不能用本轮索引跨请求盲目合并。相同内容可共用 blob，但不同来源、不同位置的记录引用仍保留；同 ID 内容变化保存新版本，不能覆盖旧原文。
- 按账户 home 隔离加密密钥及档案；scope 还必须包含可信 thread ID。文件名使用安全 hash／内部 ID，不能将 thread 字符串直接当路径。加密与索引协议由存储 agent 实现；不在此规定算法细节或复用 checkpoint 私钥。
- `capture → flush → compaction → linkCheckpoint`：写档案失败或容量不足时，开启可靠历史功能的压缩应明确失败，不允许默默退回丢历史模式。压缩失败时已保存原文仍可保留；只有原有摘要认证接受后才写 summaryHash 关联。
- `linkCheckpoint` 是档案侧附加索引，不改变原 checkpoint 加密格式，也不使摘要文本成为读档案的授权。进程重启后用当前可信 thread 重建 scope；同 thread 切换模型仍读原档案，不以模型 slug 分库。不同账户／thread／子代理默认不能互读，缺少 current thread proof 时拒绝。
- 已发生压缩且未曾归档的旧历史不能被当前 summary 补写成“原文”；stats 报告覆盖起点和缺口。MVP 不主动扫描任意旧 rollout 或文件系统来填补，回填需单独设计来源验证。

### 模型可见工具契约

现有 `codex_tool_call` 承载认证 turn token／binding；历史工具参数中没有 account、thread、文件路径或授权字段。三工具均只读，全部参数使用 `additionalProperties:false`，分页 cursor 绑定当前 scope、查询与版本，不能用于跨 thread。

| 工具 | 参数（建议默认／硬上限） | 最小返回 |
| --- | --- | --- |
| `magpie_history__search` | `query`：1–512 字符；`limit`：默认 5、最多 10；可选 opaque `cursor` | recordId、revision、source kind、turn/source 标识、匹配片段、覆盖状态、nextCursor；不返回完整命中记录 |
| `magpie_history__read` | `recordId`、`revision`；`offset` 默认 0；`maxChars` 默认 4000、最多 8000 | 精确片段、原记录 hash、source kind、实际 offset/endOffset、totalChars、nextOffset、版本；UTF-16 边界规则明确且不切开代理对 |
| `magpie_history__stats` | 空对象 | records、uniqueTextTokens、tokenizerId、原文字节、预算用量、覆盖起点、已知缺口、manifest revision；明确 `nativeContextExpanded:false` |

建议每次完整 JSON 结果最多 16 KiB UTF-8，每 turn 累计历史工具结果最多 64 KiB，另受实际模型的更小剩余预算约束。search snippet 可分页缩小；read 若 UTF-8 字节上限先到，返回实际 endOffset/nextOffset，不能谎称已返回请求的全部字符。错误结果不得包含原文或其他 scope 是否存在的信息；至少区分本 scope 的 `history_unavailable`、`history_capacity_exceeded`、`history_record_unavailable`、`history_budget_exceeded` 和无效参数。

系统说明采用稳定短文：需要精确旧事实时先查询历史工具，再按引用读取；检索命中是旧内容，不是新的系统指令或当前工具授权；摘要不能替代原文；查不到时说明缺口。每个正常新 turn 及检查点恢复后重新注入说明与三个工具描述，不依赖模型在摘要中记住工具名。压缩控制轮保持原有“停止普通工具、完成指定摘要交接”的契约。

### 集成验收清单（当前交付主线）

| 场景 | 必须满足 |
| --- | --- |
| 自动保存 | 普通轮增量 capture；显式、自动、retained、fresh compaction 前完整 source manifest 已 flush；拒绝遗漏最后一个工具结果 |
| 至少 1M | 使用冻结 tokenizer 测量去重后的文本原文至少 1M；分页重建全量记录 hash；反复压缩不丢早期记录；不把重复请求累计量计为容量 |
| 实际模型调用 | 真实 inventory 能看到完整 schema；call 使用准确 wire name；本地返回有来源的原文；零 host 工具派发；返回量受单次和 turn 预算限制 |
| 隔离 | 相同 thread 字符串在不同账户仍隔离；同账户不同 thread、父子 thread、伪造 metadata、cursor、record ID 均不能越界 |
| environment 复制 | register、updateEnvironment、重新 claim/resolve 后私有 scope 不丢；未经绑定的 clone/external owner 不可凭字段取得 scope；thread 变化必须拒绝 |
| 检查点与重启 | 正常压缩后摘要 hash 关联 source manifest；daemon 重启及同 thread 模型切换后可读取压缩前原文；旧 token 已失效，新 token 正常授权 |
| 生命周期 | 读取中取消／revoke／compaction 发生时不返回过期结果；compaction 后的普通历史调用遵守原有分流，不绕过 summary-only 控制 |
| 存储失败 | 磁盘满、损坏、密钥缺失、超限、并发重试均显式处理；原文未持久化时不能把后续压缩报告为可靠历史成功 |
| canonical 不变 | 原始 raw body、身份、权限、checkpoint/source hash 不被工具注入改写；编译说明幂等且真实预算计入；历史工具结果不递归膨胀原文统计 |
| 公开表述 | 仅在上述集成通过后发布“保留 Web 登录，至少 1M token 可检索历史”；原生窗口与已存档容量分别报告 |

## 官方 400K 路线：新交付目标与最小实验

`112193 / 111193` 是项目在历史召回失败后采用的本地安全边界；`105556` 是目录映射，`100278` 是历史 Codex 有效显示。三者均不能解释为“官方 Web 只能 100K”。daemon config 中的 `contextWindow:256000` 同样不能推翻具体模型 guards 或证明该容量可用。

**最终目标不是维持约 100K。** 以官方 400K 总窗口和新读取的 Pro `max_tokens:410000` 为依据重新探查当前 Web Pro 路由；需要确定可用输入份额、传输路径和压缩行为，再决定生产发布值。官方总窗口与目录字段是两类证据，均不保证 380K 用户原文必然可输入。历史 116459 对照通过也不是普遍容量保证。

### Pinned runtime 的实际预算与 bytes 边界

以下直接读取 checksum 固定的 v6.1.18 原始 bundle，不是修改或运行本机账户后的结果。源码变量保留用于精确复现：

| 层次／函数 | 实际数值或公式 | 对约 380K 探针的影响 |
| --- | --- | --- |
| `xn` | `8192` | `Nt()` 对完整事务加一次产品预留；是本地预算假设，不是上游实测隐藏用量 |
| `Ad`、`Pd` | `104000`；`Pd=Ad+8192+1=112193` | Pro 单个物理消息可见 token 上限 104000；单段基线输入边界 112193 |
| `Ir`、`at()` 的 Pro Bigger 分支 | `Ir=3`，`112193*3=336579` | 原始六段仍被 336579 聚合预算挡住，增加分段不能直接达到 380K |
| `y_()` 聚合检查 | `p=min(at(...Bigger).contextWindow, ($t(...)+8192+1)*parts)`；只有 `inputTokens < p` 通过 | 原始两段 ceiling 224386，六段 ceiling 336579；实际候选从 400000 总预算扣除 16384 输出余量后，六段为 383616，两段仍为 224386 |
| `rn()` Pro max | 104000 message tokens，`Ww=1635000` composer characters | 六段各约 62K 可见 token 有预算空间，但仍需逐段实测转义后字符数，不能直接假设满足 |
| `rn()` Pro-capable low / medium–high | 103000 tokens；low 545000 字符、reasoning 500000 字符 | 默认 `v_()` 优先选 low，容易混入较小模式；主实验应明确每段实际 Pro/max |
| `Xt()` → `Zx()` / `Kx()` | 只支持 2 或 6 段；按每条 JSON record 的 tokens/chars 分配；不拆单条 record | 不能把整个 380K 文档作为一条 user record；需预先生成多条完整、有序且带 ID 的较小记录 |
| `Fx=110000`、`rf(text)` | `Buffer.byteLength(JSON.stringify(text),'utf8')`，即字符串再次 JSON 编码后的字节数 | 这是非 multipart compaction inline 限制，不是普通请求全局 110KB 限制；六段 compaction 走 token ceiling，不应把 Fx 全局调大 |
| `Nt()` | `8192 + ΣPe(每个完整物理消息) + ΣPe(stage ACK) + images + skills` | 阶段 wrapper、最终 commit、回执、工具说明必须计入；不是只量数据文件 |
| `Pe()` | 使用 `o200k_base`，按 4096 个 UTF-16 单位分块且保护代理对 | 这是参考本地计量；还需完整字符串 tokenizer 对照，不能宣称即上游准确计量 |

容量主实验先用纯文本、无图片、无 skills、无本地工具、无历史检索，排除检索或摘要回填造成的假阳性。`Qi()` 另对普通／original 图片预留 4096／8192，最终消息还要扣除 skills；后续工具生产路线须加入真实额外开销重新验证，不能套用纯文本结果。

### 隔离探针可改的三个唯一匹配锚点

本次只读检查确认下列每个原始 anchor 在上述 checksum bundle 中都恰好出现一次。**仅用于独立导入的实验副本／内存变换，不写安装目录、不加载当前 production preload、不改账户配置。** 导入前还须按已有离线测试惯例移除唯一 CLI startup `Rk().catch(...)`，仅导出纯编译／计量函数；移除 startup 是防执行的 harness 步骤，不是额外容量放宽。不能直接 import 未去 startup 的 CLI。

| 编号 | 原始精确 anchor | 最小实验修改与范围 |
| --- | --- | --- |
| A：聚合预算 | `return tn(o.contextWindow*Ir,o.autoCompactTokenLimit*Ir)` | 实际候选要求 model 为 Wn、family 为 6/5.6、max effort、Pro capability 和显式 `experimentalWindowPolicy:true`。总预算取 `min(400000, accountCatalogMaxTokens)`，再扣输出预留；默认编译输入必须小于 383616。其他分支保持原值。此位置同时影响 worker `y_()` 与 compiler multipart compaction 的 ceiling，不改变 104000 单段上限 |
| B：同模型 staging | `let o=e===Ie?["low"]:t.proAvailable?["low","medium","max"]:["low","medium"];` | 在仅运行 GPT-6 Pro/max 的隔离 worker 中，让 `e===Wn && t.proAvailable` 使用 `["max"]`，其余原路径不变；保留后面的 token/char fit 检查。driver 必须断言目标确为 family 6/max；该函数没有 family 参数，不可作为全局生产替换 |
| C：禁止压缩删除原文 | `while(b()&&T.length>1){let y=_===0?1:0;` | 在循环前仅对本 probe 的 family 6/max 加 `if(b()) throw ...context_length_exceeded...`，随后保留原循环；明确使用完整输入 preflight。通过时 `trimmedCompactionMessages` 必须为零或不存在，超预算直接失败，不能进入旧 fit-recovery 删除记录 |

A 的预算口径（实际源变换见 [window-policy.mjs](../src/native/window-policy.mjs)）：

```js
const totalWindowCeiling = Math.min(400000, accountCatalogMaxTokens);
const outputReserveTokens = 16384; // 显式实验分配，非已验证上游要求
const inputTokenCeilingExclusive = totalWindowCeiling - outputReserveTokens;
// Nt 已含 8192 产品预留；不重复扣除。
// 默认 Nt < 383616；不能把 400K 总窗口直接当成 400K 输入预算。
```

默认保留原 `285000` auto-compact 元数据只是为了隔离变量（若新 ceiling 更小则相应限界），**不代表 400K 的最终生产压缩阈值**。首轮直接调用隔离 worker，不经 Codex 自动压缩调度，后续另做真实客户端集成。候选已分别测试 family `6` 和 `5.6` 的离线 arm，不把任何一方的离线结果转移成另一方 live 成功。

这三个改动让约 380K 的六段载荷有机会通过本地预算并禁止本地裁剪，**不能保证上游接受、保留或正确回答**。不能关闭 `Iu/y_`、把计量改为零、无条件 return，或提高所有账户和模型的消息限制。原始生产路径还有 [runtime.mjs](../src/native/runtime.mjs) 的三处防护接点：worker `proContextGuard`、每轮 `proRoundGuard`、compiler `solCompileGuard`／`solTrimGuard`；隔离副本不加载这些生产扩展，因此本实验不是已安装插件的 380K 验收。生产修改必须在探针通过后统一设计目录、每轮检查、compiler 与 worker 的模型预算来源，不能只删某一处 guard。

### 离线检查实际编译 payload：先证明没有本地丢失

以下离线步骤现已由真实 pinned 编译器探针执行，结果见下节；**在线探针仍未由本审查任务执行**。保留步骤作为复现契约，不能把离线通过写成 Web 接收或召回通过：

1. 固定 bundle hash 与变换 hash，断言每个 anchor 唯一；拒绝缺失／重复。关闭 startup、浏览器获取、网络、账户发现和配置写入，复用已有 pinned fixture 的纯函数导出方式。使用原 parser/compiler，不重写 serializer。
2. 目标定义为 `Nt(compiled)` 约 380000（建议不超过 380000），**已经包含 8192、本地 wrapper 和 ACK**。无图／skills 时可见消息与 ACK 合计不超过约 371808；380K 不是原文净 token 数。400K 与 380K 之间的约 20K 只是实验余量，不是已知足够的上游 reasoning/output 额度。若用户另要求净 380K 原文，应作为不同 arm，重算完整预算，不能偷换计数口径。
3. 构造多条有序文本记录和隐藏 oracle，按真实 `Pe` 迭代校准 filler；调用 `Xt(parsed, capabilities, undefined, {experimentalMultipartParts:6,...})`，保持纯只读能力、max effort 与正确 family。既有 [离线语料探针](../scripts/context-capacity-probe.mjs) 当前用 bytes/4、没有 380K tier，不能直接作为真实 380K tokenizer 证据；需独立校准或由主 agent 扩展，本文不修改它。
4. 读取 `Ai(compiled)` 的六条完整消息；对每条记录 `Pe`、完整字符串 `o200k_base` token 数、UTF-16 length、UTF-8 bytes、JSON 编码 bytes、payload hash。另记录 `Nt`、`gs`、`fs`、ACK token 数、最终指令与 attachments 开销。计量占位 transaction ID 与实际 ID 可能改变 token 数，发送前对实际 ID 的完整消息再计数并保留余量。
5. 解码所有 `compiled.multipart.parts[*].records`，按 system/message index 重建原输入，核对记录数、顺序、角色、标签、原始文本 hash 和所有关联。禁止掉记录、重复记录、只保留最后一段或改变 oracle 值；`trimmedCompactionMessages` 非零即失败。
6. 使用真实 `v_`、`y_` 对每个 stage/final token、char、image 参数执行 preflight；两段 380K 必须失败、六段未修改参考必须失败于 336579、修改后六段完整载荷应通过。其他负例包括单条 record 超界、单段超 104000、超 composer 字符、事务达到候选输入边界 383616、非 Pro、错误 family 和未 opt-in。负例应在浏览器边界前失败。
7. 对同一份完整原文构建 `_compactionRequest` 六段变体，单独记录实际编译量，确认无裁剪；摘要指令改变时须重算，不能复用普通请求估算。纯编译通过后才进入 W2；它不证明浏览器粘贴、服务接收或召回。

### 400K 路线分阶段验收

| 阶段 | 最小实验 | 成功判据与边界 |
| --- | --- | --- |
| W1 离线 380K | 原始参考负对照与 A/B/C 隔离变换；六段真实编译、重建、完整消息计量 | 原始参考明确失败于本地聚合 budget；实验副本完整通过，所有单段与原文完整性检查通过；只证明本地可发送 |
| W2 Web 传输与召回 | 在主任务授权下使用隔离 owned page；先 116K/206K 对照，再约 300K/380K；各段实际 Pro/max；无工具／检索／压缩 | 六条 outgoing payload 与编译结果一致，准确 ACK、同会话父链、无观察缺口；标记覆盖全部 stage/final、early/middle/late；至少三个独立种子，报每段得分；接收和推理召回分别判定 |
| W3 压缩与续接 | 在已通过规模上依次检查 retained handoff 与完整 fresh compaction 对照，再重启恢复 | 源原文先归档；摘要及恢复后的未知查询正确；记录摘要损失与 path；source 不可用时不得裁剪成“成功”；不靠历史工具掩盖原生召回失败 |
| W4 生产对齐 | 用实际 Native/宿主路由加入真实工具 schema、系统说明、工具结果、压缩调度和模型切换 | 每轮输入、单段、总预算与目录显示一致；达到官方路线可验证上限而非永久 100K；已安装代码复验、错误边界明确，400K 总窗口与可用输入分别表述 |

W2/W3 的完整接收证据仍不直接证明服务器推理纳入了所有字节；若新的 380K 样本失败，需按本地 preflight、浏览器提交、上游错误、召回、压缩分别定位，不仅重复“旧 100K guard”。新 Bridge metadata 支持再次调查，但不能冲销既有失败样本。

### 当前客户端额外预留与显示

- Native reference `Nt` 的 8192 预留已计入编译输入，不应在计算 `Nt` 后再次相加；stage ACK、prompt wrappers、skills/images 独立计入。官方隐藏系统／内部处理是否等于该预留未知。
- 本项目 `publishedWindow()` 用 `min(context_window, ceil(auto_compact/0.9))`。当前 `95000` 压缩目标导致发布 `105556`。若未来仍保留该目标，即使底层实验总预算改成 400K，目录仍不会自动显示 400K。
- 历史 Codex 对 `105556` 再按 95% 显示约 `100278`。已检查本机客户端源码 `C:/Users/Administrator/orca/scratch/codex-verification-client-source/codex-rs/core/src/session/context_window.rs:84`：full limit 为 `resolved_context_window * effective_context_window_percent / 100`，且达到限制会触发压缩。若发布 400000 且同样 95%，有效值是 380000；**这只是客户端规则，不是上游授予 380K 输入**。
- 项目现有契约按 Codex 默认约 90% 映射 auto-compaction；发布 400K 时默认触发点约 360K，可能早于目标 380K。实际客户端还可有 token budget fallback buffer、prefix/body scope 和显式阈值，应读取目标进程的有效配置／模型描述验证，不能仅按一个常数预测。首轮隔离 worker 探针避免这一干扰，W4 必须重新覆盖真实客户端。
- 不在本机全局配置写 `model_context_window=400000/410000` 来宣布交付，也不把主 agent 读到的 `max_tokens:410000` 直接映射成输入上限。新的生产值需要同时协调原文／系统工具输入、输出余量、预留、触发点与实际召回结果。

## 已执行的真实 pinned 离线探针

2026-11-18 执行 `node --test test/native-window-probe.test.mjs`，4 项测试全部通过，零失败、零跳过，约 69 秒。子进程使用安装位置的 checksum 固定原始 CLI 和其自带 tokenizer；移除 CLI startup，拦截网络、socket、外部进程与 Worker 浏览器入口，未加载生产 runtime preload，未连接真实账户。候选 `src/native/window-policy.mjs` **尚未接入生产**。

| family | 目标完整输入 | 实际 `Nt` | 原参考六段 preflight | 候选六段 preflight |
| --- | ---: | ---: | --- | --- |
| 6 | 100000 | 99880 | 通过 | 通过 |
| 6 | 128000 | 127882 | 通过 | 通过 |
| 6 | 256000 | 255931 | 通过 | 通过 |
| 6 | 380000 | 379856 | `context_length_exceeded` | 通过 |
| 5.6 | 100000 | 99969 | 通过 | 通过 |
| 5.6 | 128000 | 127878 | 通过 | 通过 |
| 5.6 | 256000 | 255888 | 通过 | 通过 |
| 5.6 | 380000 | 379918 | `context_length_exceeded` | 通过 |

两个 family 的 128K 两段也通过；380K 两段拒绝。当前普通 reference 112193 基线只接受 100K arm，拒绝其余完整输入。候选所有普通六段和 compaction 六段均保留完整原文；原参考的 380K compaction 在两个 family 上均删除了 25 条旧记录，分别降至 336305／336429，探针将其标为 `completeHistory:false`，不记作通过。候选保留全部记录的对应 compaction 输入为 379717／379781。候选的超预算 compaction 和超 inline bytes compaction 在删除历史前拒绝。

真实检查包括：两种 source 变换的 canonical／multipart record hash 一致、每条文本与顺序精确重建、Unicode/JSON 转义、两种 tokenizer 计量、单段和最终段限制、输出及图片预留、错误 family、无 Pro／无 opt-in、单条超大 record，以及错配／缺失／额外 oracle 答案拒绝。原始编译器及 canonical 输入保持不变。离线矩阵不测任何模型回答质量。

独立 CLI 也执行成功：`node scripts/native-window-probe.mjs --out C:\Users\Administrator\orca\scratch\magpie-native-window-probe-20261118`。本机完整 [report.json](/C:/Users/Administrator/orca/scratch/magpie-native-window-probe-20261118/report.json) 与 `reference/`、`candidate/` 下的合成输入／oracle／编译／物理 payload／manifest 共 81 个文件已保留；这是本机复现产物，不保证存在于其他 clone。实际 `ctx_aaaa...` transaction 的输入计量较 `Nt` 零占位 ID 少 147 token，报告分别记录，preflight 采用两者较大值。后续 scorer 增加了拒绝重复 JSON key（含 Unicode 转义别名）的检查，独立 focused test 通过；未为此重跑不受影响的编译矩阵。

可复用接口：

- [native-window-probe.mjs](../scripts/native-window-probe.mjs)：导出 `runNativeWindowProbe` 和 `defaultProbePaths`；CLI `--out NEW_DIRECTORY` 保存合成 request、私有 oracle、compiled、六条完整物理消息及 report。输出目录必须不存在。
- [native-window-probe-core.mjs](../scripts/native-window-probe-core.mjs)：`preparePinnedProbeSource(source,{mode:'candidate'|'reference',accountCatalogMaxTokens,outputReserveTokens})` 只处理源码、不执行。导出映射包括 `Cs→Worker`、`Xt→compile`、`Nt→tokens`、`Ai→messages`、`Pe→textTokens`、`ht→mode`，另有 parser、route、stage/final formatter 和 preflight。
- `calibrateProbe(native,{family,targetInputTokens,corpusSeed,challengeSeed})` 返回 `source.request`、独立 `source.oracle`、`parsed`、`compiled`、实际 `inputTokens`；live 使用新私有 seeds，只发送 request/compiled，绝不发送 oracle。
- `compileProbe(native,source,{parts:2|6,capabilities,compaction})`、`verifyProbeRecords(bundle)`、`preflightProbe(native,bundle,{transactionId})`、`physicalProbeMessages(native,compiled,transactionId)` 分别负责真实编译、原文校验、本地限额检查和完整物理封装。`parts:null` 仅用于 inline 负例。
- `scoreProbeAnswer(text,oracle)` 只判定精确 JSON 抽查，不自动提供服务器接收证明；返回始终包含 `canClaimWebCapacity:false`。

主 agent 的 live driver 应单独管理 owned page、只在内存使用登录状态、校验每段实际 Pro/max、保存真实发送与父链证据。它可复用公共源码处理函数，但不得复用离线 fixture 的网络禁用环境去尝试 live；也不得移除单段 fit checks。实际 transaction ID 的完整 payload 在发送前再计量，不能只使用占位 ID 的结果。

## 并行问题：模型切换后 missing cwd / 502

本节仅记录 2026-11-18 主任务提供的调查状态，**本次未独立复现或确认根因**：切换模型触发新 summary context 后出现 `missing cwd`，关注 pinned Store `Vu.resolve`；主任务在 `scratch/web-pro-057-continuity/inspect-environment.mjs` 离线重建“原始 compacted + 第一条新 user”，观察到 `Jh` 失败而 `Uh` 成功，仍在继续定位。

该线索应归入 P2 的环境来源／续接正确性调查，不能先判为上游容量不足，也不能据此放宽可信 cwd、canonical rollout 或摘要认证检查。主任务完成最小复现和路径判定后，再记录具体根因、修复与负例回归；本文不重复深入调试。

## 发布判定

- 当前可以说明：0.5.7 修复了认证 retained compaction 被 fresh-input guard 误拦截的问题，并有有限规模的压缩续接证据。
- 当前不能说明：已支持 Web 原生 1M、已解决大窗口信息丢失、摘要无损，或改一个 context 数字即可获得能力。
- L1/L2 及其生产接入、生命周期验收通过后，交付用户已接受的“保留 Web 登录，至少 1M token 可检索历史”；W1–W4 另行验收官方 400K 路线，约 100K 不是最终交付目标。P3/P4 的原生 1M 不属于本轮必要条件，未通过时仍不得声明原生 1M。
- 外部 API 的模型窗口、未来可选 provider 或离线容量探针，都不能作为已经完成的 ChatGPT Web 1M 交付。
