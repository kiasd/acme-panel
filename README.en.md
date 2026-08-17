**English** | [中文](README.md)

---

# 🔐 acme-panel — SSL Certificate Auto-Management Panel for BaoTa (aaPanel)

A web panel built on `acme.sh` for managing SSL certificates on **BaoTa (aaPanel)** servers: issue, renew, and deploy fully automated — while **keeping BaoTa's full management control**. Deployments use BaoTa's native format (`#SSL-START ... #SSL-END#` marker blocks + the standard certificate directory), so you can still view, renew, and disable SSL from the BaoTa panel UI.

## ✨ Features

- **One-click issue & deploy**: DNS / Webroot validation, auto-deploys to the site and reloads Nginx
- **Multi-domain combined (SAN) certificates**: enter multiple domains (comma-separated) to issue a single combined certificate — re-issue after adding new domains to a site
- **Force HTTPS**: HTTP → HTTPS (301) redirect enabled by default on deploy (BaoTa-style `#HTTP_TO_HTTPS_START#` block), can be turned off
- **Fully-managed mode**: scans all BaoTa sites, detects domains missing SSL, batch-issues with one click
- **Auto renewal**: built-in crontab (default daily 3 AM), customizable schedule
- **Certificate management**: view days remaining (parsed from real `notAfter` via openssl — consistent with BaoTa panel), manual renew, redeploy to another site, **delete certificates** (including valid ones; prompts and falls back site SSL to HTTP if still referenced)
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
