# xwatch-actions

X（@thsottiaux / @OpenAI / @elonmusk）原创帖监控，每 30 分钟跑一轮，命中额度/重置类关键词时推送企业微信群。

这是 `D:\AI_WORKSPACE\抓X上面的消息` 的云端替代运行方式（Plan C）：不依赖服务器，用 GitHub Actions 定时跑一轮 `watch.js --once`。

## 机制

| 项 | 做法 |
|---|---|
| 定时 | `cron: */30 * * * *`（Actions 常延迟 5-20 分钟，属正常） |
| 登录态 | `WATCH_COOKIES` secret（13 条 x.com cookie 的 JSON）→ `launch` 模式注入 |
| 配置 | `X_CONFIG` secret（config.json，含 webhook / DeepSeek key / 账号 / 阈值） |
| 去重状态 | `data/` 存成 Actions cache，下一轮 restore；首轮用 `X_STATE` secret 播种 |
| 浏览器 | playwright 1.64.1 的 Chrome for Testing 156，`~/.cache/ms-playwright` 缓存 |
| 推送 | 出网请求，无需入站端口 |

## 维护

- **cookie 失效**（日志 `NOT_LOGGED_IN`，群里收到「X 登录态失效」）：本机 `node export-cookies.js` → `gh secret set X_COOKIES < data/cookies.json`
- **改间隔/账号**：改 `config.json` → `gh secret set X_CONFIG < config.json`
- **改代码**：改 `watch.js` 后 push
- **手动跑一轮**：`gh workflow run xwatch.yml`

## 注意

- 仓库里**没有任何密钥**：config / cookies / state 全在 Actions secrets（加密，fork PR 拿不到）
- 仓库公开是为了拿无限 Actions 额度（私有仓库免费额度 2000 分钟/月，30 分钟一轮会超）
- 定时工作流在仓库 60 天无活动后会被 GitHub 停用
