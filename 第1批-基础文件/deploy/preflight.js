// ============================================================
// 上线前自检：把网页传到公网之前，替人把该看的都看一遍
//
// 用法：node deploy\preflight.js
//   （平时由 上线准备.bat 自动调用，也可以自己单独跑）
//
// 【判定三种结局，只说一种】
//   ✔ 可以上线   —— 包是好的，备案号也挂上了，可以传服务器
//   ⚠ 还不能开站 —— 包本身没问题，但开站的条件还不满足（最典型：备案号还没下来）。
//                    这一种【不是错误】：彩排阶段天天都会看到它。
//   ✘ 先别传     —— 包本身有问题（缺页、脏字符、死链、网页和代码对不上…），退出码 1
//
// 【为什么要单独有个自检】
//   本地网站出问题，你当场就能看见；传到公网出问题，是别人先看见。
//   这个文件把"上线那天要肉眼验收的每一条"提前变成程序能查的检查项。
// ============================================================

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const render = require(path.join(ROOT, 'src', 'render.js'));
const { readStatus } = require(path.join(ROOT, 'src', 'collect-status.js'));
// 打包脚本里"必须一起传上去的 public 根目录文件"清单（robot/sitemap 就是靠它保证不漏传）
// 外加"开包复验"那把尺子：把包里的文件解出来和 public\ 逐个比
const { PUBLIC_ROOT_FILES, verifyPackMatchesDisk } = require(path.join(__dirname, 'pack.js'));

// 页面里绝不该出现的东西（出现就说明生成环节漏了转义 / 数据里混进了脏字符）
const DIRTY = [
  { re: /undefined/, name: '字面的 undefined' },
  { re: /&amp;lt;/, name: '转义泄漏（&amp;lt; 这类）' },
  { re: /[\u200B-\u200D\uFEFF]/, name: '零宽字符' },
  { re: /\\n/, name: '字面的 \\n' },
];

// 只在本机才有意义的东西（公网上出现会让人莫名其妙）
const LOCAL_ONLY = [
  { s: '127.0.0.1', name: '本机地址 127.0.0.1' },
  { s: 'localhost', name: '本机地址 localhost' },
  { s: 'file://', name: '本机文件地址 file://' },
];

function collectPages() {
  const pages = [];
  if (fs.existsSync(render.PAGE_FILE)) pages.push({ file: render.PAGE_FILE, rel: 'index.html', isIndex: true });
  if (fs.existsSync(render.DETAIL_DIR)) {
    for (const f of fs.readdirSync(render.DETAIL_DIR).sort()) {
      if (f.toLowerCase().endsWith('.html')) {
        pages.push({ file: path.join(render.DETAIL_DIR, f), rel: 'detail/' + f, isIndex: false });
      }
    }
  }
  return pages;
}

function runPreflight({ log = console.log } = {}) {
  const oks = [], warns = [], fails = [];
  const ok = m => { oks.push(m); log('  ✔ ' + m); };
  const warn = m => { warns.push(m); log('  ⚠ ' + m); };
  const fail = m => { fails.push(m); log('  ✘ ' + m); };

  log('');
  log('【上线前自检】');

  // ---------- 1. 数据文件 ----------
  const data = render.readData();
  const dataOk = !(data.missing || data.error);
  if (!dataOk) {
    fail('数据文件读不出来（' + (data.error || '没有数据文件') + '）—— 先双击 更新数据.bat 采一次');
  } else {
    ok('数据文件能读：' + (data.competitions || []).length + ' 条');
    const days = Math.floor((Date.now() - new Date(data.generated_at).getTime()) / 86400000);
    if (days >= 7) warn('数据是 ' + days + ' 天前采集的，上线前建议先双击 更新数据.bat 取一次最新的');
    else ok('数据新鲜度：' + days + ' 天前采集');
  }
  const st = readStatus();
  if (!st) warn('读不到 data\\last-collect.json（最近一次采集成没成没有记录）');
  else if (st.status === 'ok') ok('最近一次采集：成功');
  else warn('最近一次采集的状态是「' + st.status + '」' +
    (st.failed_sources && st.failed_sources.length ? '，失败的数据源：' + st.failed_sources.join('、') : '') +
    '（网页顶部会如实写出来，不算坏，但你要知道）');

  // ---------- 2. 页面清单 ----------
  const pages = collectPages().map(p => Object.assign({}, p, { text: fs.readFileSync(p.file, 'utf8') }));
  const indexPage = pages.find(p => p.isIndex);
  const detailPages = pages.filter(p => !p.isIndex);

  if (!indexPage) fail('public\\index.html 不存在（首页还没生成过）—— 双击 上线准备.bat 会重画');
  else ok('页面清单：首页 1 张 + 详情页 ' + detailPages.length + ' 张');

  // ---------- 3. 三个数字必须一致 ----------
  if (indexPage && dataOk) {
    const tiles = (indexPage.text.match(/class="tile"/g) || []).length;
    const bigNum = Number((indexPage.text.match(/<b>(\d+)<\/b><span>正在报名<\/span>/) || [])[1]);
    const open = (data.competitions || []).filter(c => c.register_state === 'open').length;
    if (tiles === detailPages.length && tiles === bigNum && tiles === open) {
      ok('三个数字一致：首页方块 ' + tiles + ' = 顶部大数字 ' + bigNum + ' = 详情页 ' + detailPages.length + '（数据里"正在报名" ' + open + ' 条）');
    } else {
      fail('三个数字对不上：方块 ' + tiles + ' / 大数字 ' + (isNaN(bigNum) ? '没找到' : bigNum) +
        ' / 详情页 ' + detailPages.length + ' / 数据里正在报名 ' + open +
        '（重新生成一遍：双击 上线准备.bat）');
    }
  }

  // ---------- 4. 磁盘上的网页 = 代码重画的结果 ----------
  // 这一条是在抓"网页被人手工改过"和"改了 site-config.js 却忘了重新生成"两种情况
  if (indexPage && dataOk) {
    try {
      const again = render.renderPage();
      if (again === indexPage.text) ok('首页与代码重画的结果逐字节相同（磁盘上的网页确实是程序生成的）');
      else fail('首页与代码重画的结果【不一致】：要么 index.html 被手工改过，要么改了 site-config.js / 数据后没重新生成网页（双击 上线准备.bat 会重画）');
    } catch (e) {
      fail('重画首页时报错：' + (e && e.message ? e.message : e));
    }
  }

  // ---------- 4.5 地区 / 参赛范围（2026-09-17 新增） ----------
  // 【这一条在防什么】"地区"不是官网给的字段，是从官网原文里认出来的（见 src/region.js）。
  //   凡是"认出来的东西"就一定会有人（包括以后的我）把规则改松，
  //   改松的后果是网页上出现一个官网根本没写过的地区 —— 那是编数据，本站最不能犯的错。
  //   所以这里立三道闸：
  //     ① 写出来的地区词，必须真的在词表里（不是随手冒出来的字符串）；
  //     ② 它必须真的出现在它自己那条"证据原句"里（证据和结论对不上 = 假证据）；
  //     ③ 有地区的条数，必须和方块上真出现的小胶囊个数一致（数据和页面不许各说各话）。
  if (dataOk) {
    const { REGION_WORDS } = require('../src/region.js');
    const comps = (data.competitions || []);
    const badWord = [], badEvidence = [], badWhere = [];
    let regionCount = 0;
    for (const c of comps) {
      if (!c.region) {
        // 没认出来是允许的（绝大多数就是没认出来）——但字段本身要存在，方便以后对账
        if (c.region_evidence || c.region_where) badEvidence.push((c.title || '').slice(0, 20) + '（没有地区却有证据）');
        continue;
      }
      regionCount++;
      if (!REGION_WORDS.includes(c.region)) badWord.push(c.region);
      if (!c.region_evidence || c.region_evidence.indexOf(c.region) < 0) {
        badEvidence.push((c.title || '').slice(0, 20) + '（地区=' + c.region + '，证据里却没这几个字）');
      }
      if (!c.region_where) badWhere.push((c.title || '').slice(0, 20));
    }
    if (badWord.length) {
      fail('数据里有 ' + badWord.length + ' 个地区词不在词表里（' + [...new Set(badWord)].join('、') +
        '）—— 地区只能从 src/region.js 的词表里认，不许出现词表外的说法');
    } else if (badEvidence.length) {
      fail('地区字段的证据对不上：' + badEvidence.slice(0, 3).join('；') +
        ' —— 证据原句里必须含有那个地区词，否则就是"结论没有依据"');
    } else if (badWhere.length) {
      fail('有 ' + badWhere.length + ' 条填了地区却没写"是从官网哪一部分认出来的"：' + badWhere.slice(0, 3).join('、'));
    } else {
      ok('地区字段自洽：' + regionCount + ' 条有地区（词表内、证据原句里都真含这个词、都写了出处），' +
        (comps.length - regionCount) + ' 条官网没写、如实留空');
      // ③ 数据和页面要对得上：方块上的地区小胶囊个数 = 有地区的正在报名的条数
      if (indexPage) {
        const onTiles = (indexPage.text.match(/<span class="rg"/g) || []).length;
        const openWithRegion = comps.filter(c => c.register_state === 'open' && c.region).length;
        if (onTiles !== openWithRegion) {
          fail('首页方块上的地区胶囊有 ' + onTiles + ' 个，但数据里"正在报名且有地区"的是 ' + openWithRegion +
            ' 条 —— 网页和数据对不上（双击 上线准备.bat 重画一次）');
        } else {
          ok('首页方块上的地区胶囊和数据一致（' + onTiles + ' 个）');
        }
      }
    }
  }

  // ---------- 4.6 比赛形式 / 比赛地点（2026-09-17 第四轮新增） ----------
  // 【这一条在防什么】和"地区"一模一样：这两个值也不是官网给的字段，是从官网原文里认出来的
  //   （见 src/venue.js）。规则一旦被后人改松，网页上就会出现官网根本没写过的比赛地点 ——
  //   那是编数据（D21），本站最不能犯的错。所以立四道闸：
  //     ① 比赛形式只能是三个值之一：线上 / 线上线下 / 线下（用户明确要求"只写这三种"）；
  //     ② 证据原句里必须真的含对应的词（写"线上线下"就必须同时含"线上"和"线下"）；
  //     ③ 地点必须是词表里的城市名，而且证据原句里真含这个城市名；
  //     ④ 数据和页面不许各说各话：方块上的胶囊个数 = 正在报名且有该字段的条数。
  if (dataOk) {
    const { VENUE_CITIES, ONLINE_ALT, OFFLINE_ALT } = require('../src/venue.js');
    const ALLOWED_FORMS = ['线上', '线上线下', '线下'];
    // ★ 2026-09-17 用户拍板"出现什么就写什么"：形式也可以由替代说法认出来
    //   （"现场答辩"→线下、"在线提交"→线上）。所以判断证据时，
    //   原文那两个字【或】表里的替代说法，有一个就算数。
    const saysOnline = ev => ev.indexOf('线上') >= 0 || ONLINE_ALT.some(p => ev.indexOf(p) >= 0);
    const saysOffline = ev => ev.indexOf('线下') >= 0 || OFFLINE_ALT.some(p => ev.indexOf(p) >= 0);
    const comps = (data.competitions || []);
    const badForm = [], badEvidence = [], badWhere = [], badCity = [];
    let formCount = 0, cityCount = 0;
    for (const c of comps) {
      if (!c.venue_form && !c.venue_city) {
        if (c.venue_form_evidence || c.venue_city_evidence || c.venue_form_where || c.venue_city_where) {
          badEvidence.push((c.title || '').slice(0, 20) + '（没有形式也没有地点，却留着证据）');
        }
        continue;
      }
      if (c.venue_form && !c.venue_form_where) badWhere.push((c.title || '').slice(0, 20) + '（形式）');
      if (c.venue_city && !c.venue_city_where) badWhere.push((c.title || '').slice(0, 20) + '（地点）');
      if (c.venue_form) {
        formCount++;
        if (!ALLOWED_FORMS.includes(c.venue_form)) {
          badForm.push((c.title || '').slice(0, 20) + '（形式=' + c.venue_form + '）');
        } else {
          // ★ 形式用【形式自己的】证据：写"线上线下"就必须线上、线下两边都有依据；
          //   写"线上"只要线上那一边的依据；写"线下"只要线下那一边的。
          //   "依据"= 证据原句里有"线上/线下"四个字，或表里的替代说法（现场答辩/在线提交…）。
          const ev = c.venue_form_evidence || '';
          const needOn = c.venue_form !== '线下';
          const needOff = c.venue_form !== '线上';
          if ((needOn && !saysOnline(ev)) || (needOff && !saysOffline(ev))) {
            badEvidence.push((c.title || '').slice(0, 20) + '（形式=' + c.venue_form + '，证据「' +
              ev.slice(0, 24) + '」里没含对应的词或替代说法）');
          }
        }
      }
      if (c.venue_city) {
        cityCount++;
        if (!VENUE_CITIES.includes(c.venue_city)) badCity.push(c.venue_city);
        // ★ 地点用【地点自己的】证据 —— 形式和地点的证据是两份，不能互相顶包
        const cev = c.venue_city_evidence || '';
        if (cev.indexOf(c.venue_city) < 0) {
          badEvidence.push((c.title || '').slice(0, 20) + '（地点=' + c.venue_city + '，地点证据里却没这个城市名）');
        }
      }
    }
    if (badForm.length) {
      fail('有 ' + badForm.length + ' 条比赛形式不是那三个值（' + badForm.slice(0, 3).join('；') +
        '）—— 形式只能是 线上 / 线上线下 / 线下');
    } else if (badCity.length) {
      fail('数据里有不在城市词表里的比赛地点（' + [...new Set(badCity)].join('、') +
        '）—— 地点只能从 src/venue.js 的 VENUE_CITIES 里认');
    } else if (badEvidence.length) {
      fail('比赛形式/地点的证据对不上：' + badEvidence.slice(0, 3).join('；') +
        ' —— 证据原句里必须真含那个词，否则就是"结论没有依据"');
    } else if (badWhere.length) {
      fail('有 ' + badWhere.length + ' 条填了形式或地点却没写"是从官网哪一部分认出来的"：' +
        badWhere.slice(0, 3).join('、'));
    } else {
      ok('比赛形式/地点字段自洽：' + formCount + ' 条认出形式（只可能是线上/线上线下/线下三种，' +
        '证据原句都真含对应词）、' + cityCount + ' 条认出地点，其余官网没写、如实留空');
      if (indexPage) {
        const onForm = (indexPage.text.match(/<span class="vn"/g) || []).length;
        const onCity = (indexPage.text.match(/<span class="vc"/g) || []).length;
        const openForm = comps.filter(c => c.register_state === 'open' && c.venue_form).length;
        const openCity = comps.filter(c => c.register_state === 'open' && c.venue_city).length;
        if (onForm !== openForm || onCity !== openCity) {
          fail('首页方块上的"形式/地点"胶囊（' + onForm + ' / ' + onCity + '）和数据（' +
            openForm + ' / ' + openCity + '）对不上 —— 双击 上线准备.bat 重画一次');
        } else {
          ok('首页方块上的"比赛形式/地点"胶囊和数据一致（形式 ' + onForm + ' 个、地点 ' + onCity + ' 个）');
        }
      }
    }
  }

  // ---------- 5. 页面卫生 ----------
  const dirty = [], localLeak = [];
  for (const p of pages) {
    for (const d of DIRTY) if (d.re.test(p.text)) dirty.push(p.rel + ' → ' + d.name);
    for (const l of LOCAL_ONLY) if (p.text.includes(l.s)) localLeak.push(p.rel + ' → ' + l.name);
  }
  if (dirty.length) fail('页面里有脏东西 ' + dirty.length + ' 处：' + dirty.slice(0, 5).join('；'));
  else ok(pages.length + ' 张页面都干净（没有 undefined / 转义泄漏 / 零宽字符 / 字面 \\n）');
  if (localLeak.length) warn('页面里出现了只在本机有意义的东西：' + localLeak.slice(0, 3).join('；'));
  else ok('页面里没有本机地址（127.0.0.1 / localhost / file://）');

  // ---------- 6. 链接：不许有点不开的"详情"，也不许有进不去的孤儿页 ----------
  if (indexPage) {
    const linked = new Set();
    for (const m of indexPage.text.matchAll(/href="(detail\/[^"]+)"/g)) linked.add(m[1]);
    const files = new Set(detailPages.map(p => p.rel));
    const dead = [...linked].filter(x => !files.has(x));
    const orphan = [...files].filter(x => !linked.has(x));
    if (dead.length) fail('首页有 ' + dead.length + ' 个"详情"按钮点开是空的（子页文件不存在）：' + dead.slice(0, 3).join('、'));
    else ok('首页 ' + linked.size + ' 个"详情"按钮全部有对应子页，没有死链');
    if (orphan.length) warn('有 ' + orphan.length + ' 张详情页没被首页链接（观众进不去）：' + orphan.slice(0, 3).join('、'));
    else ok('没有"孤儿"详情页（每张子页都能从首页点进去）');
  }

  // ---------- 7. 外链协议 ----------
  const httpLinks = [];
  for (const p of pages) {
    for (const m of p.text.matchAll(/href="(http:\/\/[^"]+)"/g)) httpLinks.push(p.rel + ' → ' + m[1]);
  }
  if (httpLinks.length) warn('有 ' + httpLinks.length + ' 条外链是 http（不是 https），浏览器可能提示"不安全"：' + httpLinks.slice(0, 2).join('；'));
  else ok('所有外部链接都是 https');

  // ---------- 8. 详情页外链条数（B3 基线，只是如实报一下，不作为通过条件） ----------
  const dist = new Map();
  for (const p of detailPages) {
    const n = (p.text.match(/href="https?:\/\//g) || []).length;
    dist.set(n, (dist.get(n) || 0) + 1);
  }
  if (dist.size) {
    log('  · 详情页外链条数分布：' + [...dist.entries()].sort((a, b) => a[0] - b[0]).map(([n, c]) => c + ' 张有 ' + n + ' 条').join('，'));
  }

  // ---------- 9. 给搜索引擎看的两个小文件（2026-09-16 新增） ----------
  // 【为什么要查】这两个文件不是给人看的，所以坏了也不会有人当场发现：
  //   · 少了哪一个，搜索引擎就少一条线索（sitemap 没了，收录会慢很多）；
  //   · 而且它们【必须一起进 zip】—— 漏了就是"网页上做了、传上去 404"，等于白做。
  const robotsPath = path.join(render.PUBLIC_DIR, 'robots.txt');
  const sitemapPath = path.join(render.PUBLIC_DIR, 'sitemap.xml');
  const siteUrl = render.readSiteConfig().siteUrl;
  if (!fs.existsSync(robotsPath)) {
    fail('public\\robots.txt 不存在（双击 上线准备.bat 会重画出来）');
  } else {
    const rb = fs.readFileSync(robotsPath, 'utf8');
    if (!rb.includes('User-agent: *') || !rb.includes('Allow: /')) fail('robots.txt 内容不对（应该有 User-agent: * 和 Allow: /）');
    else if (siteUrl && !rb.includes(siteUrl + '/sitemap.xml')) fail('robots.txt 里的 sitemap 地址不对（应该指向 ' + siteUrl + '/sitemap.xml）');
    else if (!siteUrl) warn('robots.txt 生成了，但没填站点地址，所以里面没写 sitemap 那一行');
    else ok('robots.txt 正常，并指向 ' + siteUrl + '/sitemap.xml');
  }
  if (!fs.existsSync(sitemapPath)) {
    if (!siteUrl) warn('没填站点地址（site-config.js 的 siteUrl），所以没有生成 sitemap.xml —— 不影响开站，只是搜索引擎收录慢');
    else fail('public\\sitemap.xml 不存在（双击 上线准备.bat 会重画出来）');
  } else {
    const sm = fs.readFileSync(sitemapPath, 'utf8');
    const locs = (sm.match(/<loc>[^<]+<\/loc>/g) || []).length;
    const want = 1 + detailPages.length;
    if (!sm.startsWith('<?xml')) fail('sitemap.xml 不像一份合法的 xml（开头没有 <?xml 声明）');
    else if ((sm.match(/<url>/g) || []).length !== (sm.match(/<\/url>/g) || []).length) fail('sitemap.xml 里有没闭合的 <url> 标签');
    else if (locs !== want) fail('sitemap.xml 里列了 ' + locs + ' 个地址，应该是 ' + want + ' 个（1 首页 + ' + detailPages.length + ' 详情页）—— 重新生成一遍');
    else ok('sitemap.xml 正常：' + locs + ' 个地址（1 首页 + ' + detailPages.length + ' 详情页）');
  }
  // 这两个文件必须进包，否则传上去访问不到
  const notPacked = PUBLIC_ROOT_FILES.filter(r => !fs.existsSync(path.join(render.PUBLIC_DIR, r)));
  if (notPacked.length) fail('进包清单里的这些文件不存在：' + notPacked.join('、'));
  else ok('打包清单里的 ' + PUBLIC_ROOT_FILES.join(' / ') + ' 都在（不会漏传）');

  // ---------- 10. 首页的搜索/筛选工具条（2026-09-16 新增，用户要求） ----------
  // 【为什么要专门查这一块】搜索栏是"纯前端"的：服务器上不跑程序，全靠网页里那段脚本
  //   + 每个方块自己身上的 data- 属性。这两样里任何一样丢了，页面【不会报错】、
  //   方块也照常显示得好好的 —— 只是筛选悄悄失灵，或者某个方块永远被筛没。
  //   这种"不报错的坏"最难发现，所以必须让程序替人盯着。
  if (indexPage) {
    const html = indexPage.text;
    const tileCount = (html.match(/class="tile"/g) || []).length;
    const tileList = [...html.matchAll(/<div class="tile"([^>]*)>/g)].map(m => {
      const o = {};
      for (const mm of m[1].matchAll(/([a-z-]+)="([^"]*)"/g)) o[mm[1]] = mm[2];
      return o;
    });
    const chips = [...html.matchAll(/class="chip"[^>]*data-kind="([^"]*)"[^>]*data-val="([^"]*)"/g)]
      .map(m => ({ kind: m[1], val: m[2] }));

    if (tileCount === 0) {
      // 一场都没在报名时本来就该没有工具条（见 render.js），不算问题
      warn('首页现在没有方块（没有正在报名的比赛），所以也不该有搜索工具条 —— 跳过这一节检查');
    } else {
      // 10.1 工具条四件套在不在
      const need = [
        { s: 'id="fq"', name: '搜索框' },
        { s: 'id="grid"', name: '方块墙的编号（脚本靠它找方块）' },
        { s: 'id="fcount"', name: '计数那一行' },
        { s: 'id="fempty"', name: '筛不出东西时的提示' },
      ];
      const lost = need.filter(n => !html.includes(n.s));
      if (lost.length) fail('首页的搜索/筛选工具条缺了：' + lost.map(n => n.name).join('、') + '（双击 上线准备.bat 重画；真改坏了要查 src\\render.js）');
      else if (!chips.length) fail('首页有搜索框，但一个筛选按钮都没有（双击 上线准备.bat 重画）');
      else ok('搜索/筛选工具条齐全：搜索框 + ' + chips.length + ' 个筛选按钮 + 计数 + 空状态提示');

      // 10.2 每个方块都得带齐"能被筛到"的五样东西
      // （data-tags 允许是空串 = 未标注，但【属性本身必须在】；缺属性 = 那个方块筛不到）
      const five = ['data-key', 'data-tags', 'data-region', 'data-prize', 'data-deadline'];
      const shortAttr = five.filter(k => tileList.filter(o => k in o).length !== tileCount);
      if (shortAttr.length) {
        fail('有方块缺了筛选用的属性（' + shortAttr.join('、') + '）：' + tileList.length + ' 个方块里没凑齐 ' + tileCount +
          ' 个 —— 缺了它的方块会【永远被筛没】，双击 上线准备.bat 重画；还不行就查 src\\render.js 的 renderTile()');
      } else {
        ok(tileCount + ' 个方块都带齐了能被筛的元数据（关键词 / 方向 / 地区 / 奖金档 / 截止日）');
      }

      // 10.3 按钮的取值必须和方块里的取值同源（抓"改了这一处忘了那一处"）
      const prizeVals = new Set(tileList.map(o => o['data-prize']));
      const prizeChips = new Set(chips.filter(c => c.kind === 'prize').map(c => c.val));
      const badPrize = [...prizeVals].filter(v => !prizeChips.has(v));
      const deadPrize = [...prizeChips].filter(v => !prizeVals.has(v));
      if (badPrize.length) fail('方块上的奖金档位 [' + badPrize.join('、') + '] 没有对应的筛选按钮 —— 这几档点按钮筛不出来（render.js 里 PRIZE_TIERS/颜色/按钮三处要一起改）');
      else if (deadPrize.length) fail('奖金按钮 [' + deadPrize.join('、') + '] 一场比赛都筛不出来（死按钮，点了没反应）');
      else ok('奖金六档：按钮和方块上的档位一一对得上（没有筛不出的档，也没有点了没反应的按钮）');

      const regionVals = new Set(tileList.map(o => o['data-region'] || '__none__'));
      const regionChips = new Set(chips.filter(c => c.kind === 'region').map(c => c.val));
      const badRegion = [...regionVals].filter(v => !regionChips.has(v));
      const deadRegion = [...regionChips].filter(v => !regionVals.has(v));
      if (badRegion.length) fail('方块上的地区值 [' + badRegion.join('、') + '] 没有对应的筛选按钮 —— 这些比赛按地区筛不出来');
      else if (deadRegion.length) fail('地区按钮 [' + deadRegion.join('、') + '] 一场比赛都筛不出来（死按钮）');
      else ok('地区按钮和方块上的地区值一一对得上（含“官网未公布”）');

      // 10.4 截止日期的格式（格式坏了 → 那个方块在任何"截止"筛选下都会消失）
      const badDay = tileList.filter(o => o['data-deadline'] && !/^\d{4}-\d{2}-\d{2}$/.test(o['data-deadline']));
      if (badDay.length) fail('有 ' + badDay.length + ' 个方块的截止日期格式不对（应该是 2026-09-20 这样）—— 按"截止"筛时它们会凭空消失');
      else ok('全部方块的截止日期格式合法（按"截止"筛不会漏掉方块）');

      // 10.5 其它按钮都不能是死按钮
      const deadDir = chips.filter(c => c.kind === 'dir').filter(c =>
        c.val === '__none__'
          ? !tileList.some(o => !o['data-tags'])
          : !tileList.some(o => (o['data-tags'] || '').split('|').includes(c.val)));
      const deadDl = [];
      if (deadDir.length) fail('方向按钮 [' + deadDir.map(c => c.val).join('、') + '] 一场都筛不出来（死按钮）');
      else ok('其余筛选按钮也都不是死按钮（每个都能筛出比赛）');

      // 10.6 计数那一行开头的数字必须和方块数一致
      const cnum = (html.match(/id="fcount"[^>]*>显示 (\d+) \/ (\d+) 场/) || []);
      if (!cnum.length) fail('计数那一行（"显示 X / Y 场"）没找到或格式变了 —— 脚本靠它报数，双击 上线准备.bat 重画');
      else if (Number(cnum[1]) !== tileCount || Number(cnum[2]) !== tileCount) {
        fail('计数那一行写的是"显示 ' + cnum[1] + ' / ' + cnum[2] + ' 场"，但首页其实有 ' + tileCount + ' 个方块（不跑脚本时这个数就该是对的）');
      } else ok('计数那一行的初始值正确（显示 ' + cnum[1] + ' / ' + cnum[2] + ' 场 = 实际方块数）');

      // 10.7 脚本在不在、位置对不对、会不会干扰"数方块"
      const sAt = html.indexOf('<script>'), sEnd = html.indexOf('</script>', sAt < 0 ? 0 : sAt), gAt = html.indexOf('<div class="grid"');
      if (sAt < 0 || sEnd < 0) {
        fail('首页里没有筛选脚本 —— 搜索框和按钮都会变成"点了没反应"（双击 上线准备.bat 重画）');
      } else if (gAt < 0 || sAt < gAt) {
        fail('筛选脚本的位置在方块墙【之前】：脚本跑的时候方块还没生成，筛选会整条失灵（脚本必须放在网页最后）');
      } else {
        const script = html.slice(sAt, sEnd);
        if (script.includes('class="tile"')) {
          fail('筛选脚本里出现了 class="tile" 这几个字 —— 会让上面"数方块"那条检查数错，把它改掉（用 .tile 选择器）');
        } else if (script.includes('\\')) {
          fail('筛选脚本里出现了反斜杠 —— 转义很容易被写错，这段脚本的规矩是【一个反斜杠都不要有】');
        } else {
          ok('筛选脚本在方块墙之后，且不含会干扰"数方块"的字样（' + script.length + ' 字节）');
        }
      }
    }
  }

  // ---------- 11. 上线包和现在的网页是不是一回事（2026-09-16 晚新增） ----------
  // 【为什么加这一条】第十二版踩过一次："改了网页，却没重新打包" —— dist\ 里的包看着好好的，
  //   里面其实还是上一批内容。包这种东西【不会自己变红】：页面全对、自检全绿，
  //   只有真去开包比对才会发现它过时了。
  //   最容易踩的时刻：凌晨 3:00 每日自动采集跑过（网页被重画了），但你还没跑 上线准备.bat。
  //   这时 dist\ 里的包就是旧的，传上去观众看到的是旧内容，而且没人会报错。
  const distDir = path.join(__dirname, 'dist');
  const zipNames = fs.existsSync(distDir)
    ? fs.readdirSync(distDir).filter(f => f.toLowerCase().endsWith('.zip')).sort()
    : [];
  if (!zipNames.length) {
    warn('deploy\\dist\\ 里还没有上线包（双击 上线准备.bat 会重画 + 打包）');
  } else {
    if (zipNames.length > 1) {
      warn('deploy\\dist\\ 里有 ' + zipNames.length + ' 个包 —— 上线当天要传的是【最新】那个 ' + zipNames[zipNames.length - 1] +
        '；按规矩应该把旧包移进 data\\_backup\\old-dist\\，让这里只剩一个（免得拿错）');
    }
    const newest = zipNames[zipNames.length - 1];
    const v = verifyPackMatchesDisk(path.join(distDir, newest));
    if (v.ok) {
      ok('上线包就是现在的网页：' + newest + ' 里 ' + v.count + ' 个文件解出来与 public\\ 逐字节相同');
    } else {
      fail('deploy\\dist\\ 里的包【和现在的网页对不上】' +
        (v.count ? '（共 ' + v.count + ' 个文件，只有 ' + v.identical + ' 个对得上）' : '') + '：' +
        v.problems.slice(0, 3).join('；') +
        ' —— 双击 上线准备.bat 重新打包；★ 这个包别传上去');
    }
  }

  // ---------- 12. 备案号（开站的硬条件，法律要求） ----------
  const cfg = render.readSiteConfig();
  const footer = render.renderFooter();
  let beianReady = false;
  if (!cfg.icp) {
    warn('备案号还没填（site-config.js 里的 icp 一行）—— ★ 没有备案号【不能开站】，这是法律规定，不是可选项');
  } else if ((footer.warnings || []).length) {
    fail('备案号格式不对：' + footer.warnings.join('；') + '（格式不对就【不显示】，等于白填）');
  } else {
    const missing = pages.filter(p => !p.text.includes(cfg.icp));
    if (missing.length) {
      fail('备案号填了，但有 ' + missing.length + ' 张页面底部还没有它（填完要重新生成网页：双击 上线准备.bat 会自动重画）');
    } else if (!footer.html.includes('beian.miit.gov.cn')) {
      fail('备案号显示了，但没带工信部链接（法律要求做成能点开的链接）');
    } else if (!footer.html.includes('target="_blank"')) {
      fail('备案号链接不是新窗口打开（小毛病，但顺手修掉更好）');
    } else {
      beianReady = true;
      ok('备案号已挂到全部 ' + pages.length + ' 张页面底部，并带工信部链接');
    }
  }
  if (cfg.police) ok('公安备案号也挂上了');
  else warn('公安备案号还没填（备案通过后一个月内要办，不影响这次上线）');

  // ---------- 13. 意见信箱（2026-09-17 新增，用户要求） ----------
  // 【这一条在防什么】信箱是"页面上的一段脚本 + 一个只在本机存在的收件口"做的：
  //   页面上的容器/输入框/按钮、那段脚本、site-config.js 里的收件邮箱，
  //   任何一样丢了，页面【都不会报错】—— 按钮照样点得开、框照样能写字，
  //   只是点"提交"永远失败，而且失败得安安静静（观众以为发出去了，其实没有）。
  //   这种"不报错的坏"必须让程序替人盯着（和第 10 节守搜索栏同一个道理）。
  const mboxEmail = render.readSiteConfig().feedbackEmail;
  if (!indexPage) {
    // 首页都不存在，第 2 节已经报过错了，这里不重复报
  } else if (!indexPage.text.includes('id="mbox"')) {
    fail('首页没有"意见信箱"（右下角那个按钮）—— 双击 上线准备.bat 重画；真改坏了要查 src\\render.js 的 renderMailbox()');
  } else {
    const mboxNeed = [
      { s: 'id="mboxBtn"', name: '右下角那个按钮' },
      { s: 'id="mboxText"', name: '写意见的输入框' },
      { s: 'id="mboxSend"', name: '提交按钮' },
      { s: 'id="mboxCopy"', name: '复制内容按钮（邮件发不出去时的退路）' },
      { s: 'id="mboxMsg"', name: '提交结果提示那一行' },
    ];
    const mboxLost = mboxNeed.filter(n => !indexPage.text.includes(n.s));
    if (mboxLost.length) {
      fail('意见信箱缺了：' + mboxLost.map(n => n.name).join('、') + '（双击 上线准备.bat 重画）');
    } else {
      ok('意见信箱：右下角按钮 + 输入框 + 提交/复制按钮 + 结果提示都在');
    }

    // 脚本：必须是【最后一段】<script>（第 10 节只检查第一段＝筛选脚本），
    // 而且和筛选脚本一样，一个反斜杠都不能有。
    const mboxFirstAt = indexPage.text.indexOf('<script>');
    const mboxLastAt = indexPage.text.lastIndexOf('<script>');
    const mboxLastEnd = indexPage.text.lastIndexOf('</script>');
    const mboxTileN = (indexPage.text.match(/class="tile"/g) || []).length;
    if (mboxLastAt < 0 || mboxLastEnd <= mboxLastAt) {
      fail('首页里找不到意见信箱的脚本（双击 上线准备.bat 重画）');
    } else {
      const mbScript = indexPage.text.slice(mboxLastAt, mboxLastEnd);
      if (mbScript.includes('\\')) {
        fail('意见信箱的脚本里出现了反斜杠 —— 这一段的规矩和筛选脚本一样：一个都不要有（换行请用 String.fromCharCode(10)，去空格用 trim）');
      } else if (mboxTileN && mboxLastAt === mboxFirstAt) {
        fail('首页有方块，却只找到一段脚本：筛选脚本和信箱脚本必须【各是一段】，而且筛选脚本在前（查 src\\render.js 的 renderPage）');
      } else if (!mbScript.includes('/api/feedback')) {
        fail('意见信箱的脚本里没有收件地址 /api/feedback —— 点"提交"会永远失败（查 src\\render.js 的 mailboxJs）');
      } else {
        ok('意见信箱的脚本正常（' + mbScript.length + ' 字节，排在筛选脚本之后，没有反斜杠）');
      }
    }

    // 收件邮箱：填了要像个邮箱；而且页面里【不许出现完整地址】（本意是拆成两段写）
    if (!mboxEmail) {
      warn('site-config.js 里没填 feedbackEmail（意见信箱的收件邮箱）—— 信箱只剩"存到本机"那条路；传到服务器上之后，观众点提交只会得到一个"复制内容"的提示');
    } else if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(mboxEmail)) {
      fail('site-config.js 里的 feedbackEmail「' + mboxEmail + '」不像一个邮箱地址（网页上"用邮件发"那个按钮会不出现，等于白填）');
    } else if (indexPage.text.includes(mboxEmail)) {
      warn('页面上出现了完整的收件邮箱 ' + mboxEmail + ' —— 本意是拆成两段写（挡只认整串的采集爬虫），这条没生效，查 src\\render.js 的 feedbackParts()');
    } else {
      ok('意见信箱的收件邮箱已配置，而且页面上没有出现完整地址（拆成两段写的）');
    }
  }

  // 已经收到的意见：这份文件读不出来的话，意见就没人看见 —— 所以也要盯着
  const fbPath = path.join(ROOT, 'data', 'feedback.jsonl');
  if (!fs.existsSync(fbPath)) {
    ok('意见信箱：还没有人留过意见（data\\feedback.jsonl 还没生成）');
  } else {
    const fbLines = fs.readFileSync(fbPath, 'utf8').split('\n').map(l => l.trim()).filter(Boolean);
    const fbBad = fbLines.filter(l => {
      try { JSON.parse(l); return false; } catch (e) { return true; }
    });
    if (fbBad.length) {
      fail('data\\feedback.jsonl 里有 ' + fbBad.length + ' 行读不出来（可能上次写到一半断电了）—— 意见没丢，双击 看意见.bat 会把读不出来的行原样打出来');
    } else {
      ok('意见信箱：已经收到 ' + fbLines.length + ' 条意见（双击 看意见.bat 看）');
    }
  }

  // ---------- 结论 ----------
  log('');
  log('【结论】');
  let verdict;
  if (fails.length) {
    verdict = 'blocked';
    log('  ✘ 先别传：上面有 ' + fails.length + ' 项 ✘ 必须先解决');
  } else if (!beianReady) {
    verdict = 'not-ready';
    log('  ⚠ 包本身是好的，但【还不能开站】：备案号还没下来 / 还没填。');
    log('     → 现在可以拿它彩排（双击 预览上线效果.bat 看看传上去会是什么样），但别传到公网。');
  } else {
    verdict = 'ready';
    log('  ✔ 可以上线：把 deploy\\dist\\ 里最新的那个 zip 传到服务器就行（步骤见 deploy\\上线清单.md）');
  }
  log('  自检结果：✔ ' + oks.length + ' 项通过 ／ ⚠ ' + warns.length + ' 项提醒 ／ ✘ ' + fails.length + ' 项必须解决');

  return { verdict, oks, warns, fails, beianReady };
}

module.exports = { runPreflight, collectPages };

// 被当作命令直接跑时才执行（被 prepare.js 引用时不会重复执行）
if (require.main === module) {
  try {
    const r = runPreflight();
    process.exitCode = r.verdict === 'blocked' ? 1 : 0;
  } catch (e) {
    console.error('自检本身出错了：' + (e && e.stack ? e.stack : e));
    process.exitCode = 1;
  }
}
