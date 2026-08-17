# 🔐 acme-panel — 宝塔面板 SSL 证书自动管理面板

<p align="center"><strong><a href="#english">English</a></strong> | 中文</p>

基于 `acme.sh` 的 SSL 证书管理 Web 面板，专为**宝塔面板**环境设计：申请、续签、部署全部自动完成，且**不破坏宝塔对证书的管理权**——部署使用宝塔原生格式（`#SSL-START ... #SSL-END#` 标记块 + 标准证书目录），宝塔面板里依然可以正常查看、续签、关闭 SSL。

## ✨ 功能

- **一键申请 + 部署**：DNS / Webroot 两种验证方式，申请后自动部署到站点并重载 Nginx
- **中英文界面切换**：面板界面支持 中文 / English 一键切换（默认中文，选择自动记忆）
- **多域名合并证书（SAN）**：输入多个域名（逗号分隔）自动合并为一张证书，站点新增域名后可重新申请合并证书覆盖
- **强制 HTTPS**：部署时默认开启 80→443 跳转（宝塔同款 `#HTTP_TO_HTTPS_START#` 写法），可手动关闭
- **全托管模式**：自动扫描宝塔所有站点，检测缺失 SSL 的域名，一键批量申请
- **自动续期**：内置 crontab 定时续签（默认每天凌晨 3 点），支持自定义时间
- **证书管理**：查看证书剩余天数（openssl 解析真实 `notAfter`，与宝塔面板显示一致）、手动续签、部署到其他站点
- **删除证书**：支持删除有效期内的证书；若仍被站点引用，会提示并自动回退该站点 SSL（恢复 HTTP）
- **证书清理**：清除无站点/已吊销的证书（对合并证书做 SAN 级判断，不会误删）

## 🧩 支持的 DNS 服务商

| 服务商 | 环境变量 |
|---|---|
| 阿里云 DNS | `Ali_Key, Ali_Secret` |
| 腾讯云 DNSPod | `DP_Id, DP_Key` |
| Cloudflare | `CF_Token, CF_Account_ID` |
| GoDaddy | `GD_Key, GD_Secret` |
| 华为云 DNS | `HUAWEICLOUD_AccessKeyId, HUAWEICLOUD_SecretAccessKey` |

## 🚀 快速安装

### 环境要求

- Linux 服务器 + **宝塔面板**（Nginx）
- Node.js ≥ 14（宝塔「软件商店」可安装 Node 版本管理器）
- `openssl`、`nginx`、`curl`

### 一键安装

```bash
# 下载并解压项目后，在项目目录执行：
sudo bash install.sh
```

脚本会自动完成：

1. 部署文件到 `/opt/acme-panel`
2. `npm install` 安装依赖
3. 创建并启动 `acme-panel` systemd 服务（默认端口 `16789`）
4. 安装 `acme.sh`（首次申请证书时也会自动安装）

安装完成后访问 `http://<服务器IP>:16789` 即可使用。

### 手动安装

```bash
cp -r . /opt/acme-panel
cd /opt/acme-panel && npm install --omit=dev
cp acme-panel.service /etc/systemd/system/
systemctl daemon-reload
systemctl enable --now acme-panel
```

## 📖 使用说明

1. **配置 DNS 密钥**（推荐）：在面板「DNS API 密钥」中选择服务商并填写密钥，用于 DNS 验证（支持通配符域名）
2. **申请证书**：
   - 单个域名：输入 `www.example.com`，选择站点
   - 合并证书：输入 `example.com, www.example.com, api.example.com`（逗号分隔，自动合并）
   - 验证方式：DNS 验证（需已配置密钥）或 Webroot（站点根目录）
3. **全托管**：点击「扫描」查看所有站点的 SSL 状态，有 DNS 密钥时可「一键全自动申请」
4. **自动续期**：开启后每天凌晨 3 点自动续签并重载 Nginx，可在「自动续期」卡片修改 cron 表达式
5. **删除证书**：证书列表点「删除」；若证书仍被站点引用，会提示确认后自动关闭该站点 SSL（回退 HTTP）

## 🗂 目录结构

```
acme-panel/
├── server.js            # Express 服务与全部 API
├── src/
│   ├── acme.js          # acme.sh 封装：申请/续签/吊销/删除/清理
│   └── nginx.js         # 宝塔 Nginx 配置管理：部署/移除 SSL、站点扫描
├── public/
│   └── index.html       # 单页前端面板
├── acme-panel.service   # systemd 服务模板
└── install.sh           # 一键安装脚本
```

## ⚠️ 安全提示

- 面板**默认无鉴权**，请勿直接暴露到公网。建议：
  - 只监听内网（服务文件 `Environment=PORT` 不变，通过防火墙限制访问来源）
  - 或使用宝塔「反向代理」+ 面板登录鉴权前置
- `dns-config.json`（DNS API 密钥）**不要提交到仓库**，已加入 `.gitignore`

## 🔄 与宝塔面板的兼容性

本项目**不修改宝塔自身任何配置**，仅按宝塔原生格式写入站点配置：

- 证书存放在 `/www/server/panel/vhost/cert/<域名>/`（`fullchain.pem` + `privkey.pem`）
- SSL 开启标记 `#SSL-START ... #SSL-END#`，强制跳转标记 `#HTTP_TO_HTTPS_START#`
- 宝塔面板 UI 中证书状态、到期时间、续签、关闭 SSL 全部正常可用

## 📄 License

[MIT](LICENSE)

---

<a id="english"></a>

<h1 align="center">🔐 acme-panel — SSL Certificate Auto-Management Panel for BaoTa (aaPanel)</h1>

<p align="center">English | <strong><a href="#">中文</a></strong></p>

A web panel built on `acme.sh` for managing SSL certificates on **BaoTa (aaPanel)** servers: issue, renew, and deploy fully automated — while **keeping BaoTa's full management control**. Deployments use BaoTa's native format (`#SSL-START ... #SSL-END#` marker blocks + the standard certificate directory), so you can still view, renew, and disable SSL from the BaoTa panel UI.

## ✨ Features

- **One-click issue & deploy**: DNS / Webroot validation, auto-deploys to the site and reloads Nginx
- **Bilingual UI**: switch between Chinese and English with one click (Chinese by default, preference remembered)
- **Multi-domain combined (SAN) certificates**: enter multiple domains (comma-separated) to issue a single combined certificate — re-issue after adding new domains to a site
- **Force HTTPS**: HTTP → HTTPS (301) redirect enabled by default on deploy (BaoTa-style `#HTTP_TO_HTTPS_START#` block), can be turned off
- **Fully-managed mode**: scans all BaoTa sites, detects domains missing SSL, batch-issues with one click
- **Auto renewal**: built-in crontab (default daily 3 AM), customizable schedule
- **Certificate management**: view days remaining (parsed from real `notAfter` via openssl — consistent with BaoTa panel), manual renew, redeploy to another site
- **Delete certificates**: delete certificates including valid ones; if still referenced by a site, it prompts and falls that site's SSL back to HTTP automatically
- **Cleanup**: remove certificates with no site or revoked (SAN-aware — never deletes combined certificates still in use)

## 🧩 Supported DNS Providers

| Provider | Env vars |
|---|---|
| Aliyun DNS | `Ali_Key, Ali_Secret` |
| Tencent DNSPod | `DP_Id, DP_Key` |
| Cloudflare | `CF_Token, CF_Account_ID` |
| GoDaddy | `GD_Key, GD_Secret` |
| Huawei Cloud DNS | `HUAWEICLOUD_AccessKeyId, HUAWEICLOUD_SecretAccessKey` |

## 🚀 Quick Start

### Requirements

- Linux server + **BaoTa panel** (Nginx)
- Node.js ≥ 14 (install "Node Version Manager" from BaoTa App Store)
- `openssl`, `nginx`, `curl`

### One-click install

```bash
# After downloading and extracting the project:
sudo bash install.sh
```

The script will:

1. Deploy files to `/opt/acme-panel`
2. Run `npm install`
3. Create and start the `acme-panel` systemd service (default port `16789`)
4. Install `acme.sh` (also auto-installed on first issue)

Then open `http://<SERVER_IP>:16789`.

### Manual install

```bash
cp -r . /opt/acme-panel
cd /opt/acme-panel && npm install --omit=dev
cp acme-panel.service /etc/systemd/system/
systemctl daemon-reload
systemctl enable --now acme-panel
```

## 📖 Usage

1. **Configure DNS keys** (recommended): pick a provider in "DNS API Keys" and fill in the credentials — enables DNS validation (supports wildcard domains)
2. **Issue a certificate**:
   - Single domain: `www.example.com`, select the site
   - Combined: `example.com, www.example.com, api.example.com` (comma-separated, combined automatically)
   - Validation: DNS (needs configured keys) or Webroot (site root directory)
3. **Fully-managed**: click "Scan" to see SSL status of all sites; with DNS keys you can "Auto-issue All"
4. **Auto renew**: enable to renew daily at 3 AM and reload Nginx; edit the cron expression in the "Auto Renew" card
5. **Delete a certificate**: click "Delete" in the certificate list; if still referenced by a site, it asks for confirmation and closes that site's SSL (fall back to HTTP)

## 🗂 Directory Structure

```
acme-panel/
├── server.js            # Express server & all APIs
├── src/
│   ├── acme.js          # acme.sh wrapper: issue/renew/revoke/delete/cleanup
│   └── nginx.js         # BaoTa Nginx config management: deploy/remove SSL, site scan
├── public/
│   └── index.html       # Single-page frontend panel
├── acme-panel.service   # systemd service template
└── install.sh           # One-click installer
```

## ⚠️ Security Notes

- The panel has **no built-in authentication**. Do NOT expose it directly to the public internet. Recommended:
  - Listen on the intranet only (keep `PORT` in the service file, restrict access via firewall)
  - Or put it behind a BaoTa "Reverse Proxy" with panel login authentication
- `dns-config.json` (DNS API keys) must **not** be committed — it is already in `.gitignore`

## 🔄 BaoTa Compatibility

This project does **not** modify any BaoTa configuration itself; it only writes site configs in BaoTa's native format:

- Certificates stored in `/www/server/panel/vhost/cert/<domain>/` (`fullchain.pem` + `privkey.pem`)
- SSL enabled marker `#SSL-START ... #SSL-END#`, force-HTTPS marker `#HTTP_TO_HTTPS_START#`
- Certificate status, expiry, renewal, and SSL disabling all work normally from the BaoTa panel UI

## 📄 License

[MIT](LICENSE)
