// Nginx 站点管理 — 自动检测绑定域名、SSL状态、自动部署（宝塔风格）
// 部署一律使用宝塔原生格式：证书放 /www/server/panel/vhost/cert/<域名>/，
// 配置写 #SSL-START ... #SSL-END# 标记块，保证宝塔面板仍能识别与管理 SSL。
const fs = require('fs');
const { execSync } = require('child_process');

// 目录支持环境变量覆盖（本地测试用），生产保持宝塔路径
const VHOST_DIR = process.env.BT_VHOST_DIR || '/www/server/panel/vhost/nginx';
const ETC_DIR = process.env.BT_ETC_DIR || '/etc/nginx/conf.d';
const BT_CERT_DIR = process.env.BT_CERT_DIR || '/www/server/panel/vhost/cert';

function readConfig(p) { return fs.existsSync(p) ? fs.readFileSync(p, 'utf8') : ''; }

// 提取所有 server_name
function extractDomains(content) {
  const m = content.match(/server_name\s+([^;]+);/g);
  if (!m) return [];
  const names = [];
  for (const line of m) {
    const n = line.replace(/server_name\s+/, '').replace(';', '').trim();
    n.split(/\s+/).forEach(d => {
      if (d && d !== '_' && d !== 'localhost' && !d.startsWith('~')) names.push(d);
    });
  }
  return [...new Set(names)];
}

// 提取 root
function extractWebroot(content) {
  const m = content.match(/root\s+([^;]+);/);
  return m ? m[1].trim() : '';
}

// 列出所有站点（含所有绑定域名 + SSL 状态）
function listSites() {
  const sites = [];
  const dirs = [VHOST_DIR, ETC_DIR];
  const seen = new Set();

  for (const dir of dirs) {
    if (!fs.existsSync(dir)) continue;
    for (const file of fs.readdirSync(dir)) {
      if (!file.endsWith('.conf') || file.startsWith('0.') || seen.has(file)) continue;
      seen.add(file);
      const content = readConfig(dir + '/' + file);
      const domains = extractDomains(content);
      if (!domains.length) continue;

      const webroot = extractWebroot(content);
      // 宝塔判断 SSL 开启：有 #SSL-START 标记或 ssl_certificate 指令
      const hasSSL = content.includes('#SSL-START') || content.includes('ssl_certificate');
      const hasForceHttps = content.includes('#HTTP_TO_HTTPS_START');
      const certMatch = content.match(/ssl_certificate\s+([^;]+);/);
      const keyMatch = content.match(/ssl_certificate_key\s+([^;]+);/);

      sites.push({
        name: domains[0],
        domains,
        webroot,
        configFile: file,
        confPath: dir + '/' + file,
        hasSSL,
        hasForceHttps,
        certPath: certMatch ? certMatch[1].trim() : '',
        keyPath: keyMatch ? keyMatch[1].trim() : '',
        needSSL: domains.some(d => !['localhost', '_', '127.0.0.1'].includes(d)),
      });
    }
  }
  return sites;
}

function findConfPath(siteName, domain) {
  let confPath = VHOST_DIR + '/' + siteName.replace(/\.conf$/, '') + '.conf';
  if (!fs.existsSync(confPath)) confPath = ETC_DIR + '/' + siteName.replace(/\.conf$/, '') + '.conf';
  if (!fs.existsSync(confPath)) {
    const sites = listSites();
    const m = sites.find(s => s.domains.includes(domain));
    if (m) confPath = m.confPath;
    else throw new Error(`未找到站点: ${siteName}`);
  }
  return confPath;
}

// 移除所有 SSL 痕迹（幂等）：宝塔 SSL 标记块、强制 HTTPS 块、散落的 443 监听与 ssl_* 指令
function stripSSL(content) {
  let c = content;
  c = c.replace(/\s*#SSL-START[\s\S]*?#SSL-END#\s*/g, '\n');
  c = c.replace(/\s*#HTTP_TO_HTTPS_START#[\s\S]*?#HTTP_TO_HTTPS_END#\s*/g, '\n');
  c = c.split('\n').filter(l => {
    const t = l.trim();
    if (!t) return true;
    if (/^listen\s+[^;]*443[^;]*ssl/i.test(t)) return false;   // listen 443 ssl / [::]:443 ssl
    if (/^ssl_[a-z_]+/i.test(t)) return false;                  // ssl_certificate / ssl_protocols ...
    if (/^error_page\s+497/i.test(t)) return false;             // error_page 497 ...
    return true;
  }).join('\n');
  return c;
}

// 部署证书（宝塔风格）：
//  - 证书复制到 /www/server/panel/vhost/cert/<主域名>/ (fullchain.pem / privkey.pem)
//  - 配置写入 #SSL-START ... #SSL-END# 块（宝塔面板识别 SSL 开启的标志）
//  - forceHttps=true 时写入 #HTTP_TO_HTTPS_START# 强制 80→443 跳转（宝塔同款写法）
function deployCert(domain, certPath, keyPath, siteName, opts = {}) {
  const forceHttps = opts.forceHttps !== false; // 默认强制跳转
  const confPath = findConfPath(siteName, domain);

  // 1. 复制证书到宝塔标准目录（与面板证书管理一致，面板可读、可续签、可关闭）
  const certDir = BT_CERT_DIR + '/' + domain;
  fs.mkdirSync(certDir, { recursive: true });
  fs.copyFileSync(certPath, certDir + '/fullchain.pem');
  fs.copyFileSync(keyPath, certDir + '/privkey.pem');

  // 2. 清理旧痕迹（脚本旧格式或面板已有块），保证幂等
  let content = stripSSL(readConfig(confPath));

  // 3. 确保 server 块监听 443（宝塔标准写法 listen 443 ssl;）
  if (!/listen\s+[^;]*443/.test(content)) {
    content = content.replace(/(server\s*\{)/, (m) => m + '\n    listen 443 ssl;\n    listen [::]:443 ssl;');
  }

  // 4. 写入宝塔 SSL 标记块
  const sslBlock = `#SSL-START SSL相关配置#
    ssl_certificate    ${certDir}/fullchain.pem;
    ssl_certificate_key    ${certDir}/privkey.pem;
    ssl_protocols TLSv1.1 TLSv1.2 TLSv1.3;
    ssl_ciphers ECDHE-RSA-AES128-GCM-SHA256:HIGH:!aNULL:!MD5:!RC4:!DHE;
    ssl_prefer_server_ciphers on;
    ssl_session_cache shared:SSL:10m;
    ssl_session_timeout 10m;
    error_page 497  https://$host$request_uri;
    #SSL-END#`;
  // 放在第一个 443 监听之后；回调返回值中的 $ 不会被 JS 展开，保持原文本
  content = content.replace(/(listen\s+[^;]*443[^;]*;)/, (m) => m + '\n    ' + sslBlock);

  // 5. 强制 HTTPS 跳转（宝塔同款块）
  if (forceHttps) {
    const jump = `#HTTP_TO_HTTPS_START#
    if ($server_port !~ 443){ rewrite ^(/.*)$ https://$host$1 permanent; }
    #HTTP_TO_HTTPS_END#`;
    content = content.replace(/(#SSL-END#)/, (m) => m + '\n    ' + jump);
  }

  fs.writeFileSync(confPath, content);
  reloadNginx();
  return {
    domain, deployed: true, confPath, forceHttps,
    certPath: certDir + '/fullchain.pem',
    keyPath: certDir + '/privkey.pem',
  };
}

// 从站点配置中移除 SSL（宝塔面板同步显示"未开启"，仍可管理）
function removeSSL(siteName, domain) {
  const confPath = findConfPath(siteName, domain);
  const content = readConfig(confPath);
  const stripped = stripSSL(content);
  if (stripped === content) return { removed: false, confPath };
  fs.writeFileSync(confPath, stripped);
  reloadNginx();
  return { removed: true, confPath };
}

// 找出删除证书后实际会受影响的站点：
//  - 站点配置直接引用该 acme.sh 证书路径
//  - 站点引用宝塔证书目录且该目录会被删除（btWillDelete，内容与证书一致时）
function findSitesUsingCert(certPath, domain, btWillDelete = false) {
  const sites = listSites();
  const btPrefix = BT_CERT_DIR + '/' + domain + '/';
  return sites.filter(s => {
    if (!s.certPath) return false;
    if (s.certPath === certPath) return true;
    if (btWillDelete && s.certPath.startsWith(btPrefix)) return true;
    return false;
  });
}

function reloadNginx() {
  try { execSync('nginx -t 2>&1', { stdio: 'pipe' }); execSync('nginx -s reload 2>&1', { stdio: 'pipe' }); } catch {}
  return 'ok';
}

module.exports = { listSites, deployCert, removeSSL, findSitesUsingCert, stripSSL, reloadNginx };
