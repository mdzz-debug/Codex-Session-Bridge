# Codex Session Bridge v1.0.0

Codex Session Bridge 是一个用于远程操控本机 Codex 会话的桌面客户端与本地 daemon。每台电脑安装客户端后，本机服务会在本地读取 Codex 会话，并主动通过中转站 WSS 连接服务器，不需要把本机端口暴露到公网。

## 本版定位

v1.0.0 是第一个可发布的桌面版本，包含 macOS 与 Windows 安装包、本地 daemon、桌面配置界面、菜单栏/托盘后台行为，以及面向 Web 控制台的远程会话基础能力。

## 核心功能

- 本地 daemon 只监听 `127.0.0.1`，负责读取本机 Codex 会话、历史记录和执行远程请求。
- 桌面端提供轻量配置窗口，用于管理中转站登录、WSS 地址、daemon 端口和后台运行行为。
- 支持中转站账号登录，登录后使用 token 进行设备注册和 WSS 鉴权。
- 支持自定义中转站 API Base 和 WSS 地址，公共仓库默认不内置任何私有域名。
- 支持 daemon 开启、停止、重启。
- 支持本地 daemon 端口配置，默认端口为 `8787`，修改端口时会提示确认并重启 daemon。
- 支持启动后自动连接中转站 WSS。
- 支持开机自动启动。
- 支持关闭窗口后隐藏到菜单栏/托盘，daemon 可继续在后台运行。
- macOS 支持隐藏 Dock 图标，使客户端更接近常驻 agent 的使用方式。
- 菜单栏/托盘中可以快速查看 daemon 和 WSS 当前连接状态。
- 支持浅色、暗黑、跟随系统三种主题。
- 支持 GitHub Releases 更新检查。
- 支持打开系统文件访问权限入口，并可手动选择项目文件夹触发系统授权流程。

## Web 控制台能力

- ZhiChun-web 中新增 Codex 远程入口。
- 用户可以选择自己的在线设备、项目和会话。
- 支持查看某个 Codex 会话的历史记录。
- 历史记录采用分页读取，上滑加载更早内容，避免一次性拉取过大消息导致 WebSocket `1009 message too big`。
- 支持向指定设备上的指定 Codex 会话发送消息。
- 发送后会显示待处理状态，并轮询刷新会话历史，等待 Codex 回复出现在页面中。
- 支持停止正在处理的远程请求。
- 移动端 Codex 远程页面支持左侧抽屉菜单，可以在手机上查看项目和聊天记录列表。
- Codex 远程页面提供桌面客户端下载入口，跳转到 GitHub Releases 下载 macOS 和 Windows 包。

## 安装包

本版已生成以下桌面安装包：

- macOS Apple Silicon DMG：`release/Codex Session Bridge-1.0.0-arm64.dmg`
- macOS Apple Silicon ZIP：`release/Codex Session Bridge-1.0.0-arm64-mac.zip`
- Windows x64 安装包：`release/Codex Session Bridge Setup 1.0.0.exe`

## 发布脚本

根目录新增发布脚本：

```bash
npm run release:desktop -- -all
```

也可以只打单个平台：

```bash
npm run build:desktop -- -mac
npm run build:desktop -- -win
npm run build:desktop -- -all
```

`release:desktop` 会执行检查、构建桌面包、创建版本标签并尝试发布 GitHub Release。如果本机安装并登录了 `gh`，脚本会自动上传 `release/` 下的安装包；否则会保留本地产物，手动上传到 GitHub Releases 即可。

## 安全与隐私

- 默认不包含任何私有中转站域名，用户需要自行填写 API Base 和 WSS 地址。
- 本地 daemon 默认只绑定 `127.0.0.1`，不会直接暴露到公网。
- Codex/OpenAI 等本机凭据保留在本机，远程请求通过本地 daemon 执行。
- macOS 文件访问权限无法由应用静默授权，需要用户在系统隐私与安全性中确认。
- Windows 文件系统访问同样遵循系统权限设置，客户端提供入口但不会绕过系统安全策略。

## 已验证

- `npm run check` 通过。
- ZhiChun-web `npm run build` 通过。
- macOS DMG 已通过 `hdiutil verify` 校验。
- macOS 与 Windows 安装包均已成功生成。

## 已知说明

- macOS 当前为 ad-hoc 签名，尚未 notarize，首次打开时可能出现系统安全提示。
- Windows 安装包为 x64 架构。
- GitHub Release 上传需要本机 GitHub 凭据或 `gh` 登录状态。
