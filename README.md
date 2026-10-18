# dsh-session-delete

**在 DeepSeek Harness 界面里安全地彻底删除会话。** 在侧栏会话行 "..." 菜单内添加"删除会话"项，点击后出现确认弹窗；确认后会删除会话日志、投影缓存与工作区记账；运行中的会话会有提示，若仍选择删除会停止运行并删除。可在web中使用，并且理论上兼容一切web套壳的客户端。

## 安装

```shell
dsh plugin --profile <profile> add @hualiong/dsh-session-delete
```

也可以直接从仓库安装：`dsh plugin --profile <profile> add github:hualiong/dsh-session-delete`，或在插件页面的“添加插件”里手动输入包名／仓库地址。

## 功能

- 侧栏会话行 "..." 菜单原生"删除会话"项
- `RiskConfirmation` 确认弹窗
- 删除链路：会话目录 + 投影缓存 + 工作区记账 + pin 记录（经活动 storageDomain，内存/磁盘一致）
- **级联删除**：删除一个会话时，其全部子代理后代（任意深度）一并删除；任一后代在运行则会整体拒绝，不会留下半棵树
- 删除后向客户端广播 `api-session/removed`，侧栏对应行立即消失
- 删除**当前**会话后与原生归档行为一致：调用 `uiWorkspace.clearMain()` 清空主视图，界面停在空会话（选择工作区那一页），而不是自动新开一个会话
- 可选暴露两个 agent 工具（默认开启，可在下面说的详细页里开关）：
  - `session_list`：按工作区分组浏览可见会话，可钻取到单个工作区的会话列表
  - `session_delete`：删除会话；拒绝删除调用者自己、拒绝删除运行中的会话
- **本插件自己的详细页开关**：插件页 → **会话删除** 所在行右侧 **Configure** → "向 Agent 暴露会话工具"，拨动即生效。行页的 key 是 `<bundle 包名>#<行 id>`，本插件按两种发行形态各登记一次（套件内为 `@hualiong/dsh-plugin-suite#chameleon-session-delete`，单独安装为 `@hualiong/dsh-session-delete#chameleon-session-delete`）；未被行认领的 key 不会产生任何界面
- 界面删除路径始终可用，不受 `exposeAgentTools` 影响

## 运行时依赖

宿主半边 `src/index.js` 静态 import 两个由 DSH 运行时提供的包，按官方工具插件的口径声明为**可选 peerDependencies**（不从 registry 安装，由 DSH 的安装体解析表提供）：

- `@deepseek-ai/dsh-home-paths`：**普通 dependencies**（`0.2.0-rc.2`）。它曾被放在 `devDependencies` 里，从 registry 安装套件时触发 `ERR_MODULE_NOT_FOUND`（详见套件 README 的 `0.3.6` 记录），因此留在 `dependencies`。
- `@deepseek-ai/schemastery`（`Config` schema）与 `@deepseek-ai/dsh-tools`（`defineTool`）：参考已发布的第三方插件（如 `dsh-rewind-plugin`）的写法，写在 `peerDependencies` + `peerDependenciesMeta.optional`，由 DSH 侧解析。

客户端半边用 `window.__ModuleLoader__` 的 `require` 取 `react` / `@deepseek-ai/dsh-client-store` / `@deepseek-ai/dsh-client-ui-primitives`，这些同样由 DSH 的客户端模块表提供，不经过 npm 解析。

本插件依赖较新的 DSH：级联删除用的 `api-session/removed` 事件与配置页用的 `plugins.row.config` 槽位都是近期才有的。

## 截图

<table>
  <tr>
    <td><img width="571" height="387" align="center" src="https://github.com/user-attachments/assets/56a43ac4-c18d-4b16-ae43-e05004c8e081" /></td>
    <td><img width="764" height="571" align="center" src="https://github.com/user-attachments/assets/a97b9e2f-ba8d-415c-b836-2399e636e77c" /></td>
  </tr>
</table>


