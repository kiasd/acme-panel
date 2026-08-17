// acme.sh 封装 — DNS + HTTP 双认证
const { spawn, execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const ACME_HOME = process.env.HOME + '/.acme.sh';
const ACME_BIN = ACME_HOME + '/acme.sh';
const CERT_DIR = ACME_HOME;
const BT_CERT_DIR = process.env.BT_CERT_DIR || '/www/server/panel/vhost/cert';
const CONF_FILE = path.join(__dirname, '..', 'dns-config.json');

// DNS 服务商列表
const DNS_PROVIDERS = {
  aliyun:  { name: '阿里云 DNS',     env: 'Ali_Key,Ali_Secret',                    hook: 'dns_ali' },
  dnspod:  { name: '腾讯云 DNSPod',  env: 'DP_Id,DP_Key',                          hook: 'dns_dp' },
  cf:      { name: 'Cloudflare',     env: 'CF_Token,CF_Account_ID',                hook: 'dns_cf' },
  godaddy: { name: 'GoDaddy',        env: 'GD_Key,GD_Secret',                      hook: 'dns_gd' },
  huawei:  { name: '华为云 DNS',     env: 'HUAWEICLOUD_AccessKeyId,HUAWEICLOUD_SecretAccessKey', hook: 'dns_huaweicloud' },
};

// 获取 DNS 配置
function loadDnsConfig() {
  try { return JSON.parse(fs.readFileSync(CONF_FILE, 'utf8')); } catch { return {}; }
}
function saveDnsConfig(provider, credentials) {
  const cfg = loadDnsConfig();
  cfg[provider] = credentials;
  fs.writeFileSync(CONF_FILE, JSON.stringify(cfg, null, 2));
  return cfg;
}

function acmeExec(args, timeout = 120000, env = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(ACME_BIN, args, { timeout, env: { ...process.env, ...env } });
    let stdout = '', stderr = '';
    child.stdout.on('data', (d) => (stdout += d.toString()));
    child.stderr.on('data', (d) => (stderr += d.toString()));
    child.on('close', (code) => {
      if (code === 0) resolve(stdout.trim());
      else reject(new Error(stderr.trim() || stdout.trim() || `exit ${code}`));
    });
    child.on('error', reject);
  });
}

async function ensureAcme() {
  if (!fs.existsSync(ACME_BIN)) {
    console.log('正在安装 acme.sh...');
    await new Promise((resolve) => {
      const child = spawn('bash', [], { stdio: ['pipe', 'inherit', 'inherit'], timeout: 30000 });
      child.stdin.write('curl https://get.acme.sh | sh\n');
      child.stdin.end();
      child.on('close', resolve);
    });
    if (!fs.existsSync(ACME_BIN)) throw new Error('acme.sh 安装失败');
  }
  return ACME_BIN;
}

// 申请证书 — 支持 DNS/HTTP/webroot 三种方式；domains 可为数组（多域名合并一张 SAN 证书）
async function issue(domains, opts = {}) {
  const domainList = Array.isArray(domains) ? domains : String(domains).split(/[,\s]+/).filter(Boolean);
  if (!domainList.length) throw new Error('domain required');
  const mainDomain = domainList[0];
  const args = ['--issue'];
  for (const d of domainList) args.push('-d', d);
  let dnsProvider = null;
  let dnsEnv = {};

  // DNS 认证
  if (opts.dns) {
    dnsProvider = DNS_PROVIDERS[opts.dns];
    if (!dnsProvider) throw new Error(`不支持的 DNS 服务商: ${opts.dns}`);
    const cfg = loadDnsConfig();
    const keys = cfg[opts.dns];
    if (!keys) throw new Error(`请先配置 ${dnsProvider.name} API 密钥`);

    // 设置环境变量
    const envKeys = dnsProvider.env.split(',');
    const credKeys = Object.keys(keys);
    for (let i = 0; i < envKeys.length; i++) {
      dnsEnv[envKeys[i]] = keys[credKeys[i]] || '';
    }
    args.push('--dns', dnsProvider.hook);
    args.push('--dnssleep', '30');
  }
  // webroot 认证（内网，自动获取路径）
  else if (opts.webroot) {
    args.push('-w', opts.webroot);
  }
  // HTTP 认证（acme.sh 内置 standalone 或 nginx 模式）
  else if (opts.standalone) {
    args.push('--standalone', '--httpport', String(opts.httpport || 80));
  }
  else {
    // 默认：Nginx 模式
    args.push('--nginx');
  }

  if (opts.keylength) args.push('--keylength', opts.keylength);
  else args.push('--keylength', 'ec-256');

  if (!opts.test) args.push('--force');

  const output = await acmeExec(args, 180000, dnsEnv);

  // 自动部署证书到宝塔目录（以主域名命名，宝塔面板可识别）
  const info = parseCertInfo(mainDomain);
  if (info.issued) {
    try {
      const btCertDir = BT_CERT_DIR + '/' + mainDomain;
      fs.mkdirSync(btCertDir, { recursive: true });
      fs.copyFileSync(info.certPath, btCertDir + '/fullchain.pem');
      fs.copyFileSync(info.keyPath, btCertDir + '/privkey.pem');
      execSync('nginx -s reload 2>/dev/null');
    } catch {}
  }

  return { ...info, domains: domainList, sanDomains: domainList.slice(1) };
}

// 测试申请（--test 用 Let's Encrypt staging）
async function issueTest(domain, opts = {}) {
  return issue(domain, { ...opts, test: true });
}

async function renew() {
  return await acmeExec(['--renew-all'], 300000);
}

async function renewDomain(domain) {
  const cfg = loadDnsConfig();
  // 尝试用 DNS 续签
  for (const [provider, keys] of Object.entries(cfg)) {
    const dp = DNS_PROVIDERS[provider];
    if (!dp) continue;
    const env = {};
    const envK = dp.env.split(',');
    const credK = Object.keys(keys);
    for (let i = 0; i < envK.length; i++) env[envK[i]] = keys[credK[i]] || '';
    try {
      await acmeExec(['--renew', '-d', domain, '--force', '--dns', dp.hook], 180000, env);
      return { domain, renewed: true };
    } catch { /* 尝试下一个 */ }
  }
  // 回退无 DNS 续签
  try {
    await acmeExec(['--renew', '-d', domain, '--force'], 180000);
    return { domain, renewed: true };
  } catch (e) {
    throw new Error('续签失败: ' + e.message);
  }
}

async function revoke(domain) { await acmeExec(['--revoke', '-d', domain], 60000); return { domain, revoked: true }; }

// 宝塔证书目录是否与该 acme.sh 证书内容一致（一致时删除证书才应连带删除宝塔目录；
// 不一致说明宝塔目录已被新部署的合并证书覆盖，不能误删）
function btCertMatches(domain) {
  const btDir = BT_CERT_DIR + '/' + domain;
  if (!fs.existsSync(btDir) || !fs.existsSync(btDir + '/fullchain.pem')) return false;
  const btContent = fs.readFileSync(btDir + '/fullchain.pem');
  for (const suffix of ['_ecc', '_rsa', '']) {
    const f = CERT_DIR + '/' + domain + suffix + '/fullchain.cer';
    if (fs.existsSync(f) && fs.readFileSync(f).equals(btContent)) return true;
  }
  return false;
}

// 删除证书（含有效期内的）：删除 acme.sh 证书目录 + 宝塔证书目录
// 宝塔目录仅在其内容与 acme.sh 证书一致时删除，避免误删同名主域名的新合并证书
function deleteCertificate(domain) {
  const removed = [];
  // 先判断宝塔目录是否与 acme.sh 证书一致（此时 acme.sh 文件还在）
  const btSame = btCertMatches(domain);
  for (const suffix of ['_ecc', '_rsa', '']) {
    const d = CERT_DIR + '/' + domain + suffix;
    if (fs.existsSync(d)) {
      fs.rmSync(d, { recursive: true, force: true });
      removed.push(d);
    }
  }
  if (btSame) {
    const btDir = BT_CERT_DIR + '/' + domain;
    fs.rmSync(btDir, { recursive: true, force: true });
    removed.push(btDir);
  }
  return removed;
}

function listCertificates() {
  const certs = [];
  const { execSync } = require('child_process');
  if (!fs.existsSync(CERT_DIR)) return certs;
  for (const entry of fs.readdirSync(CERT_DIR, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    // 目录名格式：xxx.xxx_ecc 或 xxx.xxx（去掉 _ecc 后缀得域名）
    const dirName = entry.name;
    const domain = dirName.replace(/_ecc$/, '').replace(/_rsa$/, '');
    if (domain === dirName && !dirName.includes('.')) continue; // 跳过非域名目录（ca/deploy/dnsapi等）

    const d = path.join(CERT_DIR, dirName);
    const conf = path.join(d, domain + '.conf');
    const fp = path.join(d, 'fullchain.cer');
    const kp = path.join(d, domain + '.key');

    // 也可能 conf 是 dirName.conf
    const conf2 = path.join(d, dirName + '.conf');
    const kp2 = path.join(d, dirName + '.key');
    const actualConf = fs.existsSync(conf) ? conf : conf2;
    const actualKey = fs.existsSync(kp) ? kp : kp2;

    if (!fs.existsSync(actualConf) || !fs.existsSync(fp)) continue;

    // 到期时间：优先用 openssl 解析证书真实 notAfter（与宝塔面板同源，最准确）
    // fallback：conf 中的创建时间 + 90 天（Let's Encrypt 标准有效期）
    let expireTime = 0;
    try {
      const txt = execSync(`openssl x509 -in "${fp}" -noout -enddate 2>/dev/null`, { encoding: 'utf8', stdio: ['pipe','pipe','pipe'] });
      const m = txt.match(/notAfter=(.+)/);
      if (m) expireTime = Math.floor(new Date(m[1].trim()).getTime() / 1000);
    } catch {}
    if (!expireTime) {
      try {
        const c = fs.readFileSync(actualConf, 'utf8');
        const m = c.match(/Le_CertCreateTime='?(\d+)'?/);
        if (m) expireTime = parseInt(m[1]) + 7776000; // 90 天
      } catch {}
    }

    if (domain === '127.0.0.1') continue; // 跳过本地回环

    // 解析 SAN 域名（多域名证书）
    let sanDomains = [];
    try {
      const { execSync } = require('child_process');
      const txt = execSync(`openssl x509 -in "${fp}" -text -noout 2>/dev/null | grep "DNS:"`, { encoding: 'utf8', stdio: ['pipe','pipe','pipe'] });
      sanDomains = (txt.match(/DNS:[^\s,]+/g) || []).map(d => d.replace('DNS:', '').trim());
    } catch {}

    certs.push({
      domain, sanDomains, certPath: fp, keyPath: actualKey, confPath: actualConf,
      size: fs.statSync(fp).size,
      expire: expireTime ? new Date(expireTime * 1000).toISOString() : '',
      remainingDays: expireTime ? Math.floor((expireTime * 1000 - Date.now()) / 86400000) : 0,
    });
  }
  return certs.sort((a, b) => a.remainingDays - b.remainingDays);
}

function parseCertInfo(domain) {
  const d = CERT_DIR + '/' + domain + '_ecc';
  return {
    domain,
    certPath: d + '/fullchain.cer',
    keyPath: d + '/' + domain + '.key',
    issued: fs.existsSync(d + '/fullchain.cer'),
  };
}

// 清理无用证书：conf 已移除的、已过期的
function cleanupCerts(dryRun = false) {
  const cleaned = [];
  const { execSync } = require('child_process');
  const fs = require('fs');

  // 收集所有 Nginx 站点绑定的域名
  const VHOST_DIR = '/www/server/panel/vhost/nginx';
  const ETC_DIR = '/etc/nginx/conf.d';
  const siteDomains = new Set();
  for (const dir of [VHOST_DIR, ETC_DIR]) {
    if (!fs.existsSync(dir)) continue;
    for (const f of fs.readdirSync(dir)) {
      if (!f.endsWith('.conf') || f.startsWith('0.')) continue;
      try {
        const c = fs.readFileSync(dir + '/' + f, 'utf8');
        const m = c.match(/server_name\s+([^;]+);/g);
        if (m) m.forEach(line => {
          line.replace(/server_name\s+/, '').replace(';', '').trim().split(/\s+/).forEach(d => {
            if (d && d !== '_' && d !== 'localhost' && d !== '127.0.0.1') siteDomains.add(d);
          });
        });
      } catch {}
    }
  }

  // 收集所有有效证书覆盖的域名（含 SAN）
  const certs = listCertificates();
  const coveredDomains = new Set();
  for (const c of certs) {
    coveredDomains.add(c.domain);
    for (const d of (c.sanDomains || [])) coveredDomains.add(d);
  }

  const removeDir = (p, label, reason) => {
    if (fs.existsSync(p)) {
      if (!dryRun) try { execSync(`rm -rf "${p}"`); } catch {}
      cleaned.push({ path: p, from: label, reason });
    }
  };

  // 1. 清理宝塔 vhost/cert 中的证书（站点不存在 或 域名不在任何 server_name 中）
  const btCertBase = '/www/server/panel/vhost/cert';
  if (fs.existsSync(btCertBase)) {
    for (const d of fs.readdirSync(btCertBase)) {
      const dirPath = btCertBase + '/' + d;
      if (!fs.lstatSync(dirPath).isDirectory()) continue;
      // 白名单：宝塔默认证书不删
      const btWhitelist = ['0.default'];
      if (btWhitelist.includes(d)) continue;
      if (!siteDomains.has(d)) {
        removeDir(dirPath, '宝塔证书', '站点已删除或域名已解绑');
      }
    }
  }

  // 2. 清理已吊销的 Nginx 站点配置
  for (const dir of [VHOST_DIR, ETC_DIR]) {
    if (!fs.existsSync(dir)) continue;
    for (const f of fs.readdirSync(dir)) {
      if (!f.endsWith('.conf') || f.startsWith('0.')) continue;
      const fp = dir + '/' + f;
      try {
        const c = fs.readFileSync(fp, 'utf8');
        const m = c.match(/server_name\s+([^;]+);/);
        if (m) {
          const names = m[1].trim().split(/\s+/);
          // 如果所有 server_name 都不在有效域名集合中，且配置包含 SSL，清理证书引用
        }
      } catch {}
    }
  }

  // 3. 清理 acme.sh 中已吊销的证书（conf 被移除）
  if (fs.existsSync(CERT_DIR)) {
    for (const entry of fs.readdirSync(CERT_DIR, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const dirName = entry.name;
      const domain = dirName.replace(/_ecc$/, '').replace(/_rsa$/, '');
      if (domain === dirName && !dirName.includes('.')) continue;
      if (domain === '127.0.0.1') continue;

      const d = path.join(CERT_DIR, dirName);
      const conf = path.join(d, domain + '.conf');
      const confGone = !fs.existsSync(conf);

      // 无对应的 Nginx 站点：合并证书需检查其覆盖的所有域名（主域名 + SAN）
      // 只要任一覆盖域名仍绑定在站点上，就不能删
      const cert = certs.find(c => c.domain === domain);
      const covers = cert ? [cert.domain, ...(cert.sanDomains || [])] : [domain];
      const anySite = covers.some(dd => siteDomains.has(dd));

      if (confGone || !anySite) {
        removeDir(d, 'acme.sh', confGone ? '证书已吊销' : 'Nginx 站点不存在');
      }
    }
  }

  return cleaned;
}

module.exports = { DNS_PROVIDERS, loadDnsConfig, saveDnsConfig, ensureAcme, issue, issueTest, renew, renewDomain, revoke, deleteCertificate, btCertMatches, listCertificates, cleanupCerts };
