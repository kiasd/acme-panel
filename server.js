// SSL 证书管理面板 — DNS+HTTP 双认证 + 自动续期
const express = require('express');
const path = require('path');
const { execSync } = require('child_process');
const {
  DNS_PROVIDERS, loadDnsConfig, saveDnsConfig,
  ensureAcme, issue, issueTest, renew, renewDomain, revoke, deleteCertificate, btCertMatches, listCertificates, cleanupCerts
} = require('./src/acme');
const { listSites, deployCert, removeSSL, findSitesUsingCert, reloadNginx } = require('./src/nginx');

const app = express();
const PORT = process.env.PORT || 16789;

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ===== DNS 配置 =====
app.get('/api/dns-config', (req, res) => { res.json(loadDnsConfig()); });
app.get('/api/dns-providers', (req, res) => { res.json(DNS_PROVIDERS); });

app.post('/api/dns-config', (req, res) => {
  try {
    const { provider, credentials } = req.body;
    if (!provider || !credentials) return res.status(400).json({ error: 'provider and credentials required' });
    const cfg = saveDnsConfig(provider, credentials);
    res.json({ ok: true, provider, saved: Object.keys(cfg[provider]) });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.delete('/api/dns-config/:provider', (req, res) => {
  try {
    const cfg = loadDnsConfig();
    delete cfg[req.params.provider];
    require('fs').writeFileSync(path.join(__dirname, 'dns-config.json'), JSON.stringify(cfg, null, 2));
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ===== 初始化 =====
app.get('/api/init', async (req, res) => {
  try { await ensureAcme(); res.json({ ok: true, acme: '已就绪' }); }
  catch (e) { res.json({ ok: false, error: e.message }); }
});

// ===== 证书 =====
app.get('/api/certs', (req, res) => {
  try { res.json(listCertificates()); } catch (e) { res.status(500).json({ error: e.message }); }
});

// ===== 站点 =====
app.get('/api/sites', (req, res) => {
  try { res.json(listSites()); } catch (e) { res.status(500).json({ error: e.message }); }
});

// ===== 申请（支持 DNS/webroot/standalone；domains 数组 = 合并一张 SAN 证书） =====
app.post('/api/issue', async (req, res) => {
  try {
    const { domain, domains, dns, webroot, standalone, keylength } = req.body;
    const d = domains || domain;
    if (!d) return res.status(400).json({ error: 'domain required' });
    await ensureAcme();
    const result = await issue(d, { dns, webroot, standalone, keylength });
    res.json(result);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ===== 测试申请 =====
app.post('/api/issue-test', async (req, res) => {
  try {
    const { domain, domains, dns, keylength } = req.body;
    const d = domains || domain;
    if (!d) return res.status(400).json({ error: 'domain required' });
    await ensureAcme();
    const result = await issueTest(d, { dns, keylength });
    res.json(result);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ===== 续签 =====
app.post('/api/renew', async (req, res) => {
  try {
    await ensureAcme();
    const { domain } = req.body;
    const result = domain ? await renewDomain(domain) : { output: await renew() };
    res.json(result);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ===== 吊销 =====
app.post('/api/revoke', async (req, res) => {
  try {
    const { domain } = req.body;
    if (!domain) return res.status(400).json({ error: 'domain required' });
    await ensureAcme();
    res.json(await revoke(domain));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ===== 部署 =====
app.post('/api/deploy', async (req, res) => {
  try {
    const { domain, certPath, keyPath, siteName } = req.body;
    if (!domain || !certPath || !keyPath || !siteName) return res.status(400).json({ error: '缺少参数' });
    res.json(deployCert(domain, certPath, keyPath, siteName));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/nginx-reload', (req, res) => {
  try { res.json({ ok: true, msg: reloadNginx() }); } catch (e) { res.status(500).json({ error: e.message }); }
});

// ===== 一键申请+部署（domains 数组 = 合并一张 SAN 证书；forceHttps 默认开启强制跳转） =====
app.post('/api/auto-ssl', async (req, res) => {
  try {
    const { domain, domains, siteName, dns, webroot, keylength, forceHttps } = req.body;
    const d = domains || domain;
    if (!d || !siteName) return res.status(400).json({ error: 'domain and siteName required' });
    await ensureAcme();

    const issueResult = await issue(d, { dns, webroot, keylength: keylength || 'ec-256' });
    if (!issueResult.issued) throw new Error('证书申请失败');

    const deployResult = deployCert(issueResult.domain, issueResult.certPath, issueResult.keyPath, siteName, { forceHttps });
    res.json({ ok: true, issue: issueResult, deploy: deployResult });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ===== 删除证书（含有效期内的；被站点引用时需 force=true 才会移除站点 SSL） =====
app.delete('/api/certs/:domain', (req, res) => {
  try {
    const domain = decodeURIComponent(req.params.domain);
    const force = req.body?.force === true;

    const cert = listCertificates().find(c => c.domain === domain);
    if (!cert) return res.status(404).json({ error: '证书不存在' });

    // 宝塔证书目录内容与证书一致时才会被连带删除，此时引用该目录的站点才受影响
    const btWillDelete = btCertMatches(domain);
    const usedBy = findSitesUsingCert(cert.certPath, domain, btWillDelete);
    if (usedBy.length && !force) {
      return res.status(409).json({
        error: `证书仍被站点引用，无法删除：${usedBy.map(s => s.name).join(', ')}`,
        blockedBy: usedBy.map(s => s.name),
      });
    }

    // force 时先把引用站点的 SSL 移除（回退 HTTP），保证宝塔/nginx 状态一致
    const sitesUpdated = [];
    for (const s of usedBy) {
      const r = removeSSL(s.configFile, domain);
      if (r.removed) sitesUpdated.push(s.name);
    }

    const removed = deleteCertificate(domain);
    if (!removed.length) return res.status(404).json({ error: '证书目录不存在' });
    res.json({ ok: true, removed, sitesUpdated });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ===== 自动续期 =====
app.get('/api/auto-renew-status', (req, res) => {
  try {
    const crontab = execSync('crontab -l 2>/dev/null', { encoding: 'utf8' });
    const hasRenew = crontab.includes('acme.sh') && crontab.includes('renew');
    res.json({ enabled: hasRenew, crontab: crontab.trim() || '(空)' });
  } catch { res.json({ enabled: false, crontab: '(无 crontab)' }); }
});

app.post('/api/auto-renew', (req, res) => {
  try {
    const { enable, schedule } = req.body;
    const doEnable = enable !== false; // 默认启用

    // 获取当前 crontab
    let crontab = '';
    try { crontab = execSync('crontab -l 2>/dev/null', { encoding: 'utf8' }); } catch {}

    // 移除旧的 acme 续签任务
    crontab = crontab.split('\n').filter(l => !l.includes('acme.sh renew') && !l.includes('acme-panel renew')).join('\n');

    if (doEnable) {
      const cronSchedule = schedule || '0 3 * * *'; // 默认每天凌晨 3 点
      // acme.sh 自带续签 + 部署后重载 nginx
      crontab += `\n${cronSchedule} /root/.acme.sh/acme.sh --renew-all --reloadcmd "nginx -s reload" >> /var/log/acme-renew.log 2>&1\n`;
      crontab = crontab.trim();
    }

    // 写入 crontab
    const tmpFile = '/tmp/crontab_acme';
    require('fs').writeFileSync(tmpFile, crontab + '\n');
    execSync(`crontab ${tmpFile}`);

    // 验证
    const verify = execSync('crontab -l', { encoding: 'utf8' });
    res.json({ ok: true, enabled: doEnable, crontab: verify.trim() || '(空)', schedule: doEnable ? (schedule || '0 3 * * *') : '' });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ===== 证书清理 =====
app.post('/api/cleanup', (req, res) => {
  try {
    const dryRun = req.body?.dryRun !== false;
    const cleaned = cleanupCerts(dryRun);
    res.json({ ok: true, dryRun, cleaned, count: cleaned.length });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ===== 全托管：自动检测 + 批量申请 =====
app.get('/api/auto-detect', (req, res) => {
  try {
    const sites = listSites();
    const certs = listCertificates();
    const certDomains = new Set();
    for (const c of certs) {
      certDomains.add(c.domain);
      for (const d of (c.sanDomains || [])) certDomains.add(d);
    }

    const needSSL = [];
    const done = [];
    for (const site of sites) {
      for (const domain of site.domains) {
        if (['localhost', '_', '127.0.0.1'].includes(domain)) continue;
        if (certDomains.has(domain)) {
          done.push({ domain, site: site.name, status: '已有证书' });
        } else {
          needSSL.push({ domain, site: site.name, configFile: site.configFile, webroot: site.webroot, needsDNS: !site.webroot });
        }
      }
    }

    const dnsCfg = loadDnsConfig();
    const hasDNS = Object.keys(dnsCfg).length > 0;

    res.json({
      totalSites: sites.length,
      totalCerts: certs.length,
      needSSL: needSSL.length,
      done: done.length,
      list: { needSSL, done },
      canAutoApply: hasDNS && needSSL.length > 0,
      hasDNS,
      hint: !hasDNS && needSSL.length > 0 ? '请先配置 DNS API 密钥以启用全自动申请' : '',
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// 批量申请所有缺失 SSL 的域名
app.post('/api/auto-apply-all', async (req, res) => {
  try {
    await ensureAcme();
    const sites = listSites();
    const certs = listCertificates();
    const certDomains = new Set();
    for (const c of certs) {
      certDomains.add(c.domain);
      for (const d of (c.sanDomains || [])) certDomains.add(d);
    }
    const dnsCfg = loadDnsConfig();
    const dnsProvider = Object.keys(dnsCfg)[0]; // 使用第一个配置的 DNS
    if (!dnsProvider) return res.status(400).json({ error: '请先配置 DNS API 密钥' });

    const results = [];
    for (const site of sites) {
      const siteDomains = site.domains.filter(d => !['localhost', '_', '127.0.0.1'].includes(d));
      // 该站点缺失证书的域名，合并申请一张 SAN 证书
      const missing = siteDomains.filter(d => !certDomains.has(d));
      if (!missing.length) continue;

      try {
        const issueResult = await issue(missing, { dns: dnsProvider, keylength: 'ec-256' });
        if (issueResult.issued) {
          deployCert(issueResult.domain, issueResult.certPath, issueResult.keyPath, site.configFile, { forceHttps: true });
          results.push({ site: site.name, domains: missing, status: 'ok' });
          missing.forEach(d => certDomains.add(d));
        }
      } catch (e) {
        results.push({ site: site.name, domains: missing, status: 'fail', error: e.message });
      }
    }

    res.json({ total: results.length, ok: results.filter(r => r.status === 'ok').length, results });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ===== 启动 =====
(async () => {
  try { await ensureAcme(); } catch {}
  app.listen(PORT, () => console.log(`\n🔐 SSL 管理面板 → http://0.0.0.0:${PORT}\n`));
})();
