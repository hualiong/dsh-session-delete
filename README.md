# dsh-session-delete

**在 DeepSeek Harness 界面里安全地彻底删除会话。** 在侧栏会话行 "..." 菜单内添加"删除会话"项，点击后出现确认弹窗；确认后会删除会话日志、投影缓存与工作区记账；运行中的会话会有提示，若仍选择删除会停止运行并删除。可在web中使用，并且理论上兼容一切web套壳的客户端。

## 安装

```shell
dsh plugin --profile <profile> add github:hualiong/dsh-session-delete
```

或者你也可以在插件页面的“添加插件”，手动输入仓库地址来安装

## 功能

- 侧栏会话行 "..." 菜单原生"删除会话"项
- `RiskConfirmation` 确认弹窗
- 删除链路：会话目录 + 投影缓存 + 工作区记账（经活动 storageDomain，内存/磁盘一致）
- 删除仅限用户在界面操作：不注册任何 agent 工具

## 截图

