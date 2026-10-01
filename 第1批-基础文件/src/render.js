// ============================================================
// 网页生成器：把采集来的数据变成一张完整的网页（HTML 文字）
//
// 这个文件本身【不做任何事】，它只是"一个能把数据变成网页的工具"。
// 有两处会用到它：
//   1. build.js  ← 采集完之后，提前把网页生成成文件（上线版用这个）
//   2. server.js ← 万一网页文件还没生成，临时现做一份兜底
//
// 它不联网、不抓数据、不读也不写除数据文件以外的任何东西。
// ============================================================

const fs = require('fs');
const path = require('path');
const { readStatus } = require('./collect-status.js');

const DATA_FILE = path.join(__dirname, '..', 'data', 'competitions.json');

// 生成的网页存到这里。服务器只负责把这个文件发出去。
const PUBLIC_DIR = path.join(__dirname, '..', 'public');
const PAGE_FILE = path.join(PUBLIC_DIR, 'index.html');

// ---------- 详情子页（子母页结构，2026-09-12 改版新增） ----------
// 首页变成方块墙后，每场正在报名的比赛另有一个独立详情页，
// 存到 public\detail\ 下，有自己的地址（将来能单独发到微信里）。
const DETAIL_DIR = path.join(PUBLIC_DIR, 'detail');

// 用比赛 id 拼子页文件名。id 形如 tianchi:532480，冒号不能出现在文件名里，换成横杠。
function detailFileName(c) {
  return String(c.id || '').replace(/[^a-zA-Z0-9._-]/g, '-') + '.html';
}

// ---------- 备案号设置 ----------
//
// 【这是什么】网站备案通过后，法律要求在网页底部挂上备案号，并链接到工信部网站
// （不挂会被注销备案）。号码本身放在项目根目录的 site-config.js 里，
// 好让不写代码的人也能用记事本填 —— 不用碰这个文件。
//
// 【三条设计原则，别改】
//   1. 没填号码时，网页底部干干净净，绝不显示假号码、也不显示"待填"之类的占位字眼。
//   2. 号码格式不对（例如漏了末尾的 -1）时，也【不显示】，只在生成网页时打一行提示。
//      宁可不挂，也不挂一个错号上去 —— 这是全项目"不说假话"那条规矩的延续。
//   3. 这个文件读不出来（被误删、写坏了）时，网站必须照样能打开，只是底部少这一行。
//      辅助文件绝不能让网站打不开（同 D15）。
const CONFIG_FILE = path.join(__dirname, '..', 'site-config.js');

function readSiteConfig() {
  const empty = {
    icp: '', police: '', icpLink: 'https://beian.miit.gov.cn/', policeLink: 'https://www.beian.gov.cn/',
    siteUrl: '',
    // 意见信箱的收件邮箱（2026-09-17 新增）。没填＝空字符串，信箱就只剩"存到本机"一条路。
    feedbackEmail: '',
  };
  let cfg;
  try {
    cfg = require(CONFIG_FILE);
  } catch (e) {
    // 文件不在、或者被改坏了：当作"还没填"，网站照常生成
    return empty;
  }
  if (!cfg || typeof cfg !== 'object') return empty;
  return {
    icp: String(cfg.icp || '').trim(),
    police: String(cfg.police || '').trim(),
    icpLink: String(cfg.icpLink || empty.icpLink).trim() || empty.icpLink,
    policeLink: String(cfg.policeLink || empty.policeLink).trim() || empty.policeLink,
    // 站点地址（域名）。★ 只在"填了"的时候才用它生成 canonical / og:url / sitemap.xml ——
    // 没填就一个字都不输出，绝不留一个假域名在页面上（同备案号那三条原则）。
    siteUrl: String(cfg.siteUrl || '').trim().replace(/\/+$/, ''),
    // 意见信箱的收件邮箱。没填就是空串 —— 信箱仍然能"存到本机"，只是没有邮件退路。
    feedbackEmail: String(cfg.feedbackEmail || '').trim(),
  };
}

// 工信部备案号的格式：省份简称 + ICP备 + 数字 + 号 + -序号
//   正例：皖ICP备2026001234号-1
//   反例：皖ICP备2026001234号（漏了末尾的 -1）
//   ★ 末尾的"-序号"是【必须】的：工信部下发的号就是带序号的形式，
//     只写"…号"是不完整的。这里宁可不显示，也不挂一个不完整的号上去。
const ICP_RE = /^[\u4e00-\u9fa5]ICP备\d+号-\d+$/;
// 公安备案号的格式：省份简称 + 公网安备 + 数字 + 号（例如 皖公网安备34010002000001号）
const POLICE_RE = /^[\u4e00-\u9fa5]公网安备\d+号$/;

// 生成底部那一行备案号。返回 { html, warnings }
//   html     ：要插进页面的内容（可能是空字符串 = 什么都不显示）
//   warnings ：填得不对时的提醒，由 build.js 打印出来，方便主人自己发现填错了
function renderFooter() {
  const cfg = readSiteConfig();
  const warnings = [];
  const parts = [];

  if (cfg.icp) {
    if (ICP_RE.test(cfg.icp)) {
      parts.push('<a href="' + esc(cfg.icpLink) + '" target="_blank" rel="noopener">' + esc(cfg.icp) + '</a>');
    } else {
      warnings.push('site-config.js 里的工信部备案号「' + cfg.icp +
        '」格式看起来不对（正常应该像「皖ICP备2026001234号-1」，末尾要有 -1），这次【没有】显示在网页上。');
    }
  }

  if (cfg.police) {
    if (POLICE_RE.test(cfg.police)) {
      parts.push('<a href="' + esc(cfg.policeLink) + '" target="_blank" rel="noopener">' + esc(cfg.police) + '</a>');
    } else {
      warnings.push('site-config.js 里的公安备案号「' + cfg.police +
        '」格式看起来不对（正常应该像「皖公网安备34010002000001号」），这次【没有】显示在网页上。');
    }
  }

  if (!parts.length) {
    // 号码还没下来（现在就是这种情况）：留一个位置，但页面上一个字都不多说。
    return { html: '', warnings };
  }
  return { html: '<div class="beian">' + parts.join('<span>|</span>') + '</div>', warnings };
}

// ---------- 门面：<head> 里那几行"给外人看"的信息（2026-09-16 新增） ----------
//
// 【为什么要有这几行】网页本身好看还不够用，因为"看到网页"的人常常不是打开网页的人：
//   1. 分享到微信/QQ/群里时，平台要先读 og:description 才知道该给一段摘要 ——
//      没有它，分享出去就是一条光秃秃的链接，像垃圾；
//   2. 搜索引擎拿 description 当搜索结果下面那两行字；
//   3. 浏览器标签页拿小图标区分"你"和另外三十个标签页。
//
// 【三条原则，别改】
//   1. 摘要里的每一个字都从【数据本身】拼出来（主办方、报名截止、来源），不写死、不编
//      —— 延续全项目"页面上的话必须和事实一致"那条规矩（D14）；
//   2. 站点地址（域名）放在 site-config.js 的 siteUrl 里，没填就【不输出】
//      canonical / og:url / sitemap.xml，绝不留一个假域名（同备案号那三条原则）；
//   3. 小图标：2026-09-17 换掉了。原来是【内联】的 SVG（图直接写在网页里，不新增文件），
//      理由是"页面完全自包含、不依赖任何外部资源"。
//      这一版破了这条（新增了字体 / 底图 / 图形文件），所以标签页小图标改成用
//      素材包里的那个机器人头（/media/mark/head.png，见 public/media/mark/）。
//      ★ 它压在浅色标签栏和深色标签栏上都看得见（图形本身是青色的）。
//      ★ 想换回内联 SVG 也随时可以：把下面这行改回 data:image/svg+xml;base64,...
const FAVICON = '/media/mark/head.png';

// ---------- 全站共用的两块"皮"（2026-09-17 新增，首页和详情页都用同一套） ----------
// 【为什么单独抽出来】首页和详情页是两个函数各拼各的 HTML，以前各写各的 <body> 开头。
//   这一版要给整站铺一张底图、加一条顶部 HUD 装饰条，如果两处各写一遍，
//   以后改一处忘一处就会出现"首页是新皮、详情页还是旧皮"的斑。
//
// 1) 背景层：素材包（深潜协议1.2.2.apk）里主题自带的根背景图，
//    一条"深红（上）→ 墨蓝（下）"的竖向渐变；CSS 里再叠一层压暗和顶部红光。
//    ★ position:fixed 让它固定在视口上（网页往下滚，底色不动，像主题壁纸那样）。
//    ★ 它是纯装饰，所以 aria-hidden，并且不参与点击。
const BG_LAYER = '<div class="abyss" aria-hidden="true"></div>';

// 2) 顶部 HUD 装饰条：主题标记（机器人头）+ 英文站名 + 一条数据带，都是素材包里的图形。
//    ★ 只放装饰和站名，不放任何"关于数据的话" —— 页面上要说事实的话（采集时间、
//      数据源）一律由下面 header 里那几行正经文字说，不用装饰条冒充。
//    ★ width/height 写死是为了图还没下载完时不留一块会跳动的空位。
function hudBar() {
  return '<div class="hud">' +
    '<img class="logo" src="/media/mark/head.png" alt="" width="26" height="28">' +
    '<span>AI COMPETITION MEMO</span>' +
    '<img class="band" src="/media/mark/band.png" alt="" width="132" height="13">' +
    '</div>';
}

// 摘要专用的一行化：把换行/连续空格压成一个空格，超长就截断。
// （采集来的文本里带换行是常事，粘进 meta 里会变成一串怪空格。）
function oneLine(s, max) {
  const cap = max || 120;
  let t = String(s === null || s === undefined ? '' : s).replace(/\s+/g, ' ').trim();
  if (t.length > cap) t = t.slice(0, cap - 1) + '…';
  return t;
}

// 首页摘要：数据源名字也从数据里取（采集失败的数据源照样列，我们确实在采它）
function homeDescription(sources) {
  const names = (sources || []).map(s => s.source_name).filter(Boolean);
  const from = names.length ? names.join('、') : '各竞赛官网';
  return '汇集' + from + '上正在报名的 AI 竞赛，按报名截止日期从近到远排；' +
    '每场都有报名时间、比赛时间、奖金与官网报名链接，一页看清，链接可以直接转发。';
}

// 详情页摘要：只用这场赛事真实有的字段（没有的就不写，绝不编）
function detailDescription(c) {
  const bits = [];
  if (c.organizer) bits.push('主办：' + c.organizer);
  if (c.register_end) bits.push('报名截止：' + fmtDate(c.register_end));
  else if (c.official_status_text) bits.push('状态：' + c.official_status_text);
  // 奖金同详情页那条规矩：空或 0 都算"官网没公布"，不写进摘要（不显示"0 元"）
  const prize = (!c.prize_pool || /^0([.0]*)?元?$/.test(String(c.prize_pool).trim())) ? '' : c.prize_pool;
  if (prize) bits.push('奖金：' + prize);
  bits.push('信息来自' + (c.source_name || '竞赛官网') + '官网公开页面');
  return oneLine(c.title + '。' + bits.join('；') + '。');
}

// 拼出 <head> 里那几行（首页和详情页共用）
function headMeta(o) {
  const title = oneLine(o.title, 90);
  const desc = oneLine(o.description, 120);
  const out = [];
  if (desc) out.push('<meta name="description" content="' + esc(desc) + '">');
  out.push('<link rel="icon" href="' + FAVICON + '">');
  out.push('<meta name="theme-color" content="#0d0a12">');
  out.push('<meta property="og:site_name" content="' + esc(SITE_NAME) + '">');
  out.push('<meta property="og:type" content="' + (o.path === '/' ? 'website' : 'article') + '">');
  out.push('<meta property="og:title" content="' + esc(title) + '">');
  if (desc) out.push('<meta property="og:description" content="' + esc(desc) + '">');
  const base = readSiteConfig().siteUrl;
  if (base) {
    const full = base + o.path;
    out.push('<link rel="canonical" href="' + esc(full) + '">');
    out.push('<meta property="og:url" content="' + esc(full) + '">');
  }
  return out.join('');
}

// ---------- robots.txt / sitemap.xml（给搜索引擎看的两个小文件） ----------
// robots.txt：告诉搜索引擎"随便看"，并指出 sitemap 在哪（没填域名就少写那一行）。
function renderRobots() {
  const base = readSiteConfig().siteUrl;
  const lines = ['User-agent: *', 'Allow: /'];
  if (base) lines.push('Sitemap: ' + base + '/sitemap.xml');
  return lines.join('\n') + '\n';
}

// sitemap.xml：把首页 + 每张"正在报名"的详情页列出来，方便搜索引擎收录。
// ★ 没填域名时返回空字符串（由 build.js 决定不生成这个文件）——
//   sitemap 里必须是绝对地址，编不出来就干脆不生成，绝不用假域名凑一个。
function renderSitemap() {
  const base = readSiteConfig().siteUrl;
  if (!base) return '';
  const data = readData();
  if (data.missing || data.error) return '';
  const lastmod = String(data.generated_at || '').slice(0, 10);
  const urls = [{ loc: base + '/', pri: '1.0' }];
  for (const c of (data.competitions || [])) {
    if (c.register_state !== 'open') continue;   // 已截止的只留档、不上首页也不进 sitemap（D23）
    urls.push({ loc: base + '/detail/' + detailFileName(c), pri: '0.8' });
  }
  const body = urls.map(u =>
    '  <url><loc>' + esc(u.loc) + '</loc>' +
    (lastmod ? '<lastmod>' + lastmod + '</lastmod>' : '') +
    '<priority>' + u.pri + '</priority></url>').join('\n');
  return '<?xml version="1.0" encoding="UTF-8"?>\n' +
    '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n' + body + '\n</urlset>\n';
}

// ---------- 小工具 ----------
function esc(s) {
  if (s === null || s === undefined) return '';
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// 把时间显示成中国时区的"2026年3月31日 16:00"
function fmtTime(iso) {
  if (!iso) return null;
  const d = new Date(iso);
  if (isNaN(d.getTime())) return null;
  const s = d.toLocaleString('zh-CN', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric', month: 'long', day: 'numeric',
    hour: '2-digit', minute: '2-digit', hour12: false,
  });
  return s;
}

function fmtDate(iso) {
  if (!iso) return null;
  const d = new Date(iso);
  if (isNaN(d.getTime())) return null;
  return d.toLocaleDateString('zh-CN', { timeZone: 'Asia/Shanghai', year: 'numeric', month: 'long', day: 'numeric' });
}

// 腾讯那边的内容里自带网页标记（比如 <br/><br/>、<b style="color:red">），
// 还有被转义过的 &amp; 之类。直接显示会露出"生肉"，看起来像乱码。
// 这里统一处理：先还原转义 → 再去掉所有标记（同时换成换行）→ 最后才做安全转义。
function decodeEntities(s) {
  if (!s) return '';
  return String(s)
    .replace(/&nbsp;/gi, ' ')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/gi, '&');
}

function richText(text) {
  if (!text) return '';
  let t = decodeEntities(text);
  // 把换行类标记统一变成真换行
  t = t.replace(/<br\s*\/?>/gi, '\n');
  t = t.replace(/<\/br\s*>/gi, '\n');
  t = t.replace(/<\/p\s*>/gi, '\n');
  // 去掉剩下的所有网页标记
  t = t.replace(/<[^>]*>/g, '');
  // 清掉 markdown 残留的小符号（** 加粗、# 标题、行首的 * 和 -）
  t = t.replace(/\*\*/g, '');
  t = t.replace(/(^|\s)\*(\S)/g, '$1$2');
  // 再按 换行 / && 切段落
  const parts = t
    .split(/\n|&&/)
    .map(x => x.trim())
    .filter(Boolean)
    .map(x => x.replace(/^[#*\-\s]+/, '').trim())
    .filter(Boolean);
  return parts.map(x => '<p>' + esc(x) + '</p>').join('');
}

function paragraphs(text) {
  return richText(text);
}

function readData() {
  if (!fs.existsSync(DATA_FILE)) {
    return { error: '还没有采集过数据', missing: true };
  }
  try {
    return JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
  } catch (e) {
    return { error: '数据文件读不出来：' + e.message };
  }
}

// ---------- 状态徽章 ----------
//
// 【重要决定，别改回去】
// 这里【不显示"还剩 X 天"】。因为上线版是"采集完就把网页生成好"，
// 网页一旦生成就冻住了：今天算出来"还剩 30 天"，一星期后再看还是"还剩 30 天"，
// 那就是在说假话。所以这里只写截止日期，并靠网页顶部写明的
// "本页数据采集于 X 月 X 日"让读者自己判断。
// （要恢复倒计时，前提是先改成"每次打开网页都重新算"，那就不能提前生成网页了。）
function badge(state, text) {
  // 2026-09-17：原来颜色是写在这段 JS 里的行内样式（style="background:#0f7b3f"），
  // 换配色时最容易漏掉的就是这种"藏在 JS 里"的颜色。现在只输出一个类名，
  // 颜色统一交给 CSS 里那几条 .badge.b-* 管（要改色去 ROOT_VARS / CSS 找）。
  //   状态值不是这五个之一时按 unknown 上色，绝不因为"认不出来的状态"就让整块没颜色。
  const known = ['open', 'closed', 'not_started', 'unknown', 'invalid'];
  const cls = known.indexOf(state) >= 0 ? state : 'unknown';
  return '<span class="badge b-' + cls + '">' + esc(text) + '</span>';
}

// 【改版删掉】原来这里的 renderOpenNotice（把正在报名的比赛名全列一遍的栏目）
// 已随改版删除：首页变成方块墙后，方块本身就是那 18 场，再列一遍纯属重复。

// 【改版删掉】原来这里的 renderTrack（赛道折叠块）已随改版删除：
// 改版后网页上只剩天池的比赛，而天池 20 条的赛道数全是 0，这块代码用不上了。

// ---------- 奖金（首页方块上显示"总奖金"，并按金额给不同颜色；2026-09-16 新增）----------
// 【用户要求】每场比赛的奖金要出现在首页方块上，而且金额不同、颜色也不同。
// 【数据从哪来】prize_pool 是采集时从官网拿到的赛事奖金总额（天池接口的 bonus 字段经
//   formatBonus 格式化）。这里只负责把它显示出来：不改一个字、不换算、不估算。
// 【为什么按"档"变色，不按金额连续变色】21 个方块上连续变色肉眼分不出来，
//   分成几档才能一眼看出"哪几个是大奖、哪几个是小奖"。
// 【币种规矩】只对人民币分档。外币【绝不换算】——换算要靠汇率，那就是在编数据；
//   外币照官网原样显示，单独给一个中性色，免得被当人民币去比大小。
// 【未公布的规矩】与详情页第 358 行同一条：空值或 0 都算"官网没公布"，照实写
//   "官网未公布"，绝不显示"0 元"、也绝不编一个数（D21）。
const PRIZE_TIERS = [
  { min: 200000, cls: 'pz-1', label: '20 万及以上' },
  { min: 100000, cls: 'pz-2', label: '10 万 ~ 20 万' },
  { min: 50000, cls: 'pz-3', label: '5 万 ~ 10 万' },
  { min: 0, cls: 'pz-4', label: '5 万以下' },
];

// 把 prize_pool 变成"方块上那一行"要用的三样东西：写什么字、用什么颜色、鼠标悬停说什么。
// 颜色含义写在 CSS 的 .tile .pz-* 那几条里，两处要一起改。
function prizeCell(c) {
  const raw = c.prize_pool;
  const text = String(raw === null || raw === undefined ? '' : raw).trim();

  // 空 或 0 → 官网未公布（判断式必须与详情页那条一致，改一处就要改两处）
  if (!text || /^0([.0]*)?元?$/.test(text)) {
    return { text: '奖金 官网未公布', cls: 'pz-none', title: '这场比赛官网没有公布奖金金额' };
  }

  // 外币（现在只有"$30,000"那一场）：不换算，照原样显示，用中性色
  if (/[$＄]|USD|美元/i.test(text)) {
    return {
      text: '总奖金 ' + text,
      cls: 'pz-other',
      title: '官网公布的奖金是外币，本站不做汇率换算，所以不参与人民币分档',
    };
  }

  // 人民币：先去掉千分位逗号和空格再认数字（"¥ 930000"这种写法也能认出来）
  const cleaned = text.replace(/,/g, '').replace(/\s+/g, '');
  const m = cleaned.match(/(\d+(?:\.\d+)?)(亿|万)?/);
  if (!m) {
    // 认不出金额的写法：照原样显示，宁可不分档，也不猜一个档
    return { text: '总奖金 ' + text, cls: 'pz-other', title: '官网写的奖金格式认不出金额，只能照原样显示' };
  }
  let n = parseFloat(m[1]);
  if (m[2] === '万') n *= 10000;
  if (m[2] === '亿') n *= 100000000;
  const tier = PRIZE_TIERS.find(t => n >= t.min) || PRIZE_TIERS[PRIZE_TIERS.length - 1];
  return { text: '总奖金 ' + text, cls: tier.cls, title: '总奖金 ' + text + '（' + tier.label + '）' };
}

// ---------- 搜索与筛选要用的三个小工具（2026-09-16 新增） ----------

// 把 tag 拆成一个个"比赛方向"。数据里的格式是"计算机视觉 / 工业制造"这样的斜杠串。
// 数据里 tag 可能是 null（现在有 2 条）→ 返回空数组，表示"未标注"。
// 【绝不拿别的东西去填】没有方向就是没有方向，不猜、不套现成的标签（D21）。
function directionList(c) {
  return String(c.tag || '').split('/').map(s => s.trim()).filter(Boolean);
}

// ISO 时间 → "北京时间的 YYYY-MM-DD"，专给截止日期筛选用。
// 【为什么不用 c.register_end 的前 10 个字符】数据里的时间是 UTC（…T08:00:00.000Z）。
//   页面上显示的截止日期是 fmtDate() 算的，用的是 Asia/Shanghai；
//   这里必须和它算的是同一天，否则会出现"方块上写着 9 月 21 日截止，
//   却被归进 9 月 20 日那一档"——页面自己跟自己打架（D14）。
function isoDayCN(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  if (isNaN(d.getTime())) return '';
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(d);
  const pick = t => { const f = parts.find(x => x.type === t); return f ? f.value : ''; };
  const y = pick('year'), m = pick('month'), dd = pick('day');
  return (y && m && dd) ? (y + '-' + m + '-' + dd) : '';
}

// 工具条上的一个筛选按钮。可多选：点一下选中，再点一下取消。
function chip(kind, val, label) {
  return '<button class="chip" type="button" data-kind="' + esc(kind) + '"' +
    ' data-val="' + esc(val) + '">' + esc(label) + '</button>';
}

// ---------- 首页的一个方块 ----------
// 【改版】大卡片缩成小方块（约 210×120）：只放骨架 ——
//   名字（最多两行，超出打"…"，全名进子页）+ 分类标签 + 截止日期 + 两个胶囊。
// 按钮只有两个：【详情】进子页；【去官网报名】直奔官方页面。
// （天池每场比赛只有一个官网网址，所以不会出现两个重复的官方按钮。）
function renderTile(c) {
  const tag = c.tag ? '<span class="tag">' + esc(c.tag) + '</span>' : '';
  // 【2026-09-17 新增】"地区 / 参赛范围"那个小胶囊。
  // ★ 它显示的是【官网原文里写着的】参赛范围原词（例如 全球 / 全国 / 国内 / 国际），
  //   不是我们推断出来的地点 —— 悬停能看到这句话是从官网哪一部分来的。
  // ★ 官网没写这个信息的方块【不放这个胶囊】（28 条里有 18 条没写），绝不猜（D21）。
  //   识别规则和"为什么规则要这么严"写在 src/region.js 开头，
  //   详情页上还会把官网原句一并摆出来让人核对。
  const rg = c.region
    ? '<span class="rg" title="据官网' + esc(c.region_where || '原文') + '">' + esc(c.region) + '</span>'
    : '';
  // 【2026-09-17 第四轮新增】"比赛形式"和"比赛地点"两个小胶囊（用户要求）。
  // ★ 形式只有三个可能值：线上 / 线上线下 / 线下 —— 这是用户明确指定"只写这三种"。
  // ★ 和地区一样，都是【从官网原文里认出来的】，不是本站推断的：
  //   认不出来的方块就【不放这个胶囊】，绝不猜（D21）；
  //   详情页上会把官网原句摆出来让人核对。
  // ★ 识别规则（以及"为什么城市名不能见一个算一个"）写在 src/venue.js 开头。
  const vn = c.venue_form
    ? '<span class="vn" title="据官网' + esc(c.venue_form_where || '原文') + '：比赛形式">' + esc(c.venue_form) + '</span>'
    : '';
  const vc = c.venue_city
    ? '<span class="vc" title="据官网' + esc(c.venue_city_where || '原文') + '：比赛地点">' + esc(c.venue_city) + '</span>'
    : '';
  const metaRow = (tag || rg || vn || vc)
    ? '<div class="metarow">' + tag + rg + vn + vc + '</div>' : '';
  const dl = c.register_end ? '<div class="dl">报名截止 ' + esc(fmtDate(c.register_end)) + '</div>' : '';
  // 奖金那一行（2026-09-16 新增，用户要求）：金额不同颜色不同，档位见上面的 PRIZE_TIERS；
  // 悬停能看到这一档叫什么名字，免得读者只看到颜色猜意思。
  const pz = prizeCell(c);
  const prize = '<div class="pz ' + pz.cls + '" title="' + esc(pz.title) + '">' + esc(pz.text) + '</div>';

  // 【2026-09-16 新增】把"能被搜到 / 能被筛到"的信息写进方块自己的 data- 属性。
  //   为什么必须这么做：本站是纯静态的（服务器上不跑程序），浏览器里没有数据文件可查，
  //   每个方块只能自己带着自己的信息。
  //   ★ data-key 只装【方块上看得见】的东西（比赛名 + 分类标签 + 地区胶囊），
  //     这样"搜到什么就看到什么"——不会出现搜一个词、跳出来的方块上却找不到那个词。
  //   ★ data-tags 用 | 分隔；空串 = 未标注（tag 是 null 的那 2 条）。
  const dirs = directionList(c);
  const attrs =
    ' data-key="' + esc((c.title + ' ' + (c.tag || '') + ' ' + (c.region || '') + ' ' +
      (c.venue_form || '') + ' ' + (c.venue_city || '')).toLowerCase()) + '"' +
    ' data-tags="' + esc(dirs.join('|')) + '"' +
    ' data-region="' + esc(c.region || '') + '"' +
    ' data-prize="' + esc(pz.cls) + '"' +
    ' data-deadline="' + esc(isoDayCN(c.register_end)) + '"';

  return (
    '<div class="tile"' + attrs + '>' +
      // title 属性：电脑上鼠标悬停能看到全名（手机没有悬停，全名以子页为准）
      '<div class="tt" title="' + esc(c.title) + '">' + esc(c.title) + '</div>' +
      metaRow +
      dl +
      prize +
      '<div class="btns">' +
        '<a class="btn small" href="detail/' + detailFileName(c) + '">详情</a>' +
        '<a class="btn alt small" href="' + esc(c.register_url || c.official_page_url) + '" target="_blank" rel="noopener">去官网报名</a>' +
      '</div>' +
    '</div>'
  );
}

// ---------- 详情子页（甲方案） ----------
// 只放我们自己整理出来的关键信息 + 一条官方外链，【不搬】天池几千字正文。
// 甲方案的理由（用户已拍板）：抄来的正文会悄悄过期、搬过来的一定是被截断的残缺版，
// 挂在自家站上读者会当成我们说的话 —— 违反"页面上的话必须和事实一致"（D14）。
// 内容与取数来源（批注敲定，别改字段）：
//   title / organizer / register_start~end / competition_start~end /
//   参赛资格、报名方式（天池没给这两个字段 → "官网未公布"）/
//   prize_pool（空 → "官网未公布"）/ 赛程阶段（sections 里现成的 schedule 块）/
//   tag（空则整行不显示）/ 一条 official_page_url 外链
function renderDetailPage(c, generatedAt) {
  const row = (k, v) => '<div class="row"><span class="k">' + k + '</span><span class="v">' + esc(v) + '</span></div>';

  const rows = [];
  rows.push(row('主办方', c.organizer || '官网未公布'));
  // 【2026-09-17 新增】地区 / 参赛范围。
  // ★ 三个官网都没有"地区"这个字段可抓（逐个接口查过，证据见 src/region.js 开头），
  //   所以这一行显示的是"从官网原文里认出来的参赛范围原词"，
  //   下面还会把官网那句原话摆出来 —— 读者可以自己核对，也能看出我们没做任何推断。
  // ★ 认不出来就写"官网未公布"，绝不猜（D21）。
  rows.push(row('地区 / 参赛范围', c.region || '官网未公布'));
  // 【2026-09-17 第四轮新增】比赛形式 / 比赛地点（用户要求）。
  // ★ 这两个值和地区一样是【从官网原文里认出来的】，认不出就写"官网未公布"，
  //   下面还有个出处框把官网原句摆出来 —— 读者能自己核对，也能看出我们没做推断。
  rows.push(row('比赛形式', c.venue_form || '官网未公布'));
  rows.push(row('比赛地点', c.venue_city || '官网未公布'));
  if (c.register_start || c.register_end) {
    rows.push(row('报名时间', (fmtDate(c.register_start) || '官网未公布') + ' ~ ' + (fmtDate(c.register_end) || '官网未公布')));
  }
  rows.push(row('比赛时间', c.competition_end
    ? (fmtDate(c.competition_start) || '官网未公布') + ' ~ ' + fmtDate(c.competition_end)
    : (fmtDate(c.competition_start) || '官网未公布')));
  // 金额为空（含数字 0）都算"官网没公布"，绝不显示"0 元"（D21）
  const prize = (!c.prize_pool || /^0([.0]*)?元?$/.test(String(c.prize_pool).trim())) ? '官网未公布' : c.prize_pool;
  rows.push(row('奖金', prize));
  // 天池接口根本没有"参赛资格""报名方式"这两个字段（只有腾讯开悟才有，而开悟已被剔除）
  rows.push(row('参赛资格', '官网未公布'));
  rows.push(row('报名方式', '官网未公布'));
  const sched = (c.sections || []).find(s => s.section_type === 'schedule');
  if (sched) rows.push(row('赛程阶段', sched.content));
  if (c.tag) rows.push(row('分类', c.tag));

  // 天池的"详细规则与说明"那几千字【不上网】（甲方案）。原卡片上的
  // "关于这份数据的说明"（data_notes）从首页搬到子页 —— 它们是有意写的，不能删。
  const notesHtml = (c.data_notes && c.data_notes.length)
    ? '<div class="notes"><b>关于这份数据的说明</b><ul>' +
      c.data_notes.map(n => '<li>' + esc(n) + '</li>').join('') +
      '</ul></div>'
    : '';

  const detailNote = c.detail_fetch_ok === false
    ? '<div class="warn">这次采集这条赛事的详情页失败了：' + esc(c.detail_error) + '</div>'
    : '';

  // 【2026-09-17 新增】"地区"这一行是怎么来的：把官网原句摆出来。
  // ★ 为什么要摆：三个官网都没有"地区"字段，这个值是从官网正文里认出来的，
  //   摆出原句读者才能核对；不摆的话就成了"本站自己说的"，那是另一回事。
  const regionNote = c.region
    ? '<div class="ev"><b>「' + esc(c.region) + '」这个地区是怎么来的</b>' +
      '官网' + esc(c.region_where || '原文') + '里写着：「' + esc(c.region_evidence || '') + '」。' +
      '这里只是照搬官网原话里出现的地区词，没有做任何推断；官网没写的，本页一律写"官网未公布"。</div>'
    : '';

  // 【2026-09-17 第四轮新增】比赛形式 / 比赛地点这两个值是怎么来的：同样摆官网原句。
  // ★ 为什么必须摆：官网没有这两个字段（见 src/venue.js 开头），值是从正文里认出来的。
  //   尤其"比赛形式"只有三个值，读者更需要看到依据 —— 不然就成了本站自己下的结论。
  const venueNote = (c.venue_form || c.venue_city)
    ? '<div class="ev"><b>「比赛形式 / 比赛地点」是怎么来的</b>' +
      (c.venue_form
        ? '比赛形式「' + esc(c.venue_form) + '」：官网' + esc(c.venue_form_where || '原文') +
          '里写着：「' + esc(c.venue_form_evidence || '') + '」。<br>'
        : '比赛形式：官网没写，本页写"官网未公布"。<br>') +
      (c.venue_city
        ? '比赛地点「' + esc(c.venue_city) + '」：官网' + esc(c.venue_city_where || '原文') +
          '里写着：「' + esc(c.venue_city_evidence || '') + '」。'
        : '比赛地点：官网没写，本页写"官网未公布"。') +
      '<br>形式只可能是"只有线上 / 线上线下都有 / 只有线下"三种，都是照官网原话读出来的，' +
      '不是本站推断的；官网没写的一律留空。</div>'
    : '';

  // 【半失败时才有这行】这个数据源这次没采到，内容是上一次采回来的。
  // 不标出来的话，读者会以为这是今天的新数据 —— 那就是在说假话。
  // （数据为什么会被留下，见 collect.js 里的"闸二"。）
  const retainedNote = c.retained_from
    ? '<div class="warn">这条数据是上一次采集留下的（采集于 ' + esc(fmtTime(c.retained_from)) +
      '）：这次采集时这个数据源失败了，为了不把已经采到的好数据弄丢，这里原样保留。</div>'
    : '';

  const footer = renderFooter();

  return '<!DOCTYPE html><html lang="zh-CN"><head><meta charset="utf-8">' +
    '<meta name="viewport" content="width=device-width,initial-scale=1">' +
    '<title>' + esc(c.title) + ' - ' + SITE_NAME + '</title>' +
    // 门面（摘要/小图标/分享卡片）：分享到微信时显示的是这场赛事的名字 + 报名截止，不是一条光秃秃的链接
    headMeta({ title: c.title, description: detailDescription(c), path: '/detail/' + detailFileName(c) }) +
    '<style>' + CSS + '</style></head><body>' + BG_LAYER + '<div class="wrap">' +
    '<header>' + hudBar() + '<div class="crumb"><a href="/index.html">← 返回首页</a></div>' +
      '<h1>' + esc(c.title) + '</h1>' +
      (c.title_en ? '<div class="sub">' + esc(c.title_en) + '</div>' : '') +
    '</header>' +
    '<section class="card">' +
      '<div class="cardhead">' + badge(c.register_state, c.register_state_text) + '</div>' +
      '<div class="rows">' + rows.join('') + '</div>' +
      '<div class="btnrow"><a class="btn alt" href="' + esc(c.official_page_url) + '" target="_blank" rel="noopener">去' + esc(c.source_name) + '官网看完整赛事页</a></div>' +
      detailNote + regionNote + venueNote + retainedNote + notesHtml +
      '<div class="meta2">本页信息采集于 ' + esc(fmtDate(generatedAt)) + '；若链接打不开，说明官网已下架。</div>' +
      '<div class="src">数据来源：' + esc(c.source_name) + ' · <a href="' + esc(c.source_url) + '" target="_blank" rel="noopener">' + esc(c.source_url) + '</a></div>' +
    '</section>' +
    '<footer>数据均来自各竞赛官网公开页面，仅供信息参考；报名请以官网为准。' +
      footer.html +
    '</footer>' +
    '</div></body></html>';
}

// ============================================================================
// 【设计令牌】改配色只改这一块（2026-09-16 深夜新增）
// ----------------------------------------------------------------------------
// 以前这些颜色是散在下面那几百行 CSS 里的字面量（#111827、#6b7280……共 40 个
// 不同的值，同一类东西在不同地方写成好几个近似的灰）。想"换个配色"就得在
// 几百行里逐个找，漏一个就出现"这块变了那块没变"的斑。
//
// 现在改成：颜色只在这一个地方定义一个值，下面所有用到的地方都写 var(--令牌名)。
// ★ 想换配色，就改这里的值（一次改一处），下面的 CSS 一行都不用动。
//
// ============================================================================
// ★★ 2026-09-17：整套配色换成「深潜协议 · 终端」（深色霓虹版） ★★
// ----------------------------------------------------------------------------
// 【这套颜色是从哪来的】用户给的素材包（收件箱里的 深潜协议1.2.2.apk）里那个
//   KLWP 主题，它自己的 preset.json 里有一张 globals_list 调色板表，本版用的每一个
//   颜色都是从那张表里【原样搬过来的】，一个都没自己调：
//       青 cyan #5EF6FF ／ 蓝 cyblue #00C7FF ／ 红 cyred #F75049 ／ 橙 cyorange #FB932E
//       绿 cygreen #4AB87A ／ 黄绿 cyyellow #DBFE50 ／ 粉 pk1 #FF528D
//       暗红 cyredark #61272E ／ 半透明红 button #8061272E
//   底图也是主题自己的根背景图（bitmaps/IMG7a63de82…，一条深红→墨蓝的竖向渐变）。
// 【为什么是深色底】这是被事实逼出来的，不是口味问题：主题那七个霓虹色（尤其
//   #5EF6FF / #DBFE50）压在浅底上对比度只有 1.1~1.6:1 —— 不是"淡"，是【看不见】。
//   上一版为了浅色底，只能把这七个色全部压深，代价是"赛博朋克感"没了。
//   这一版反过来：保留霓虹本色，把底压深 —— 霓虹才立得住。
//   ★ 用户上一轮反馈过"背景太黑、整体偏暗"，所以这一版的底【不是纯黑】：
//     是主题自带的那张"深红→墨蓝"渐变壁纸（顶部有明显的暗红），面板是半透明的，
//     底下的渐变会透上来，不是一块死黑。
// 【可读性】下面每一处"字色 on 底色"都用 WCAG 公式算过，全部 ≥ 4.5:1
//   （算法与实测记录见交接单第十七版；页面上真正的底色是"半透明面板叠在渐变壁纸上"，
//    所以算的时候取的是【最亮的那种叠法】当底，宁可算保守）。
//   ★ 2026-09-16 复核：方块面板提亮之后重算 —— **27 对全部 ≥4.5:1，最低 4.89:1**
//     （最低那处是工具条提示 / 页脚那种最淡的字 #a98d88 压在面板上；它原来 6.36:1，
//      提亮面板必然让它降一点，还剩 4.89:1，仍然过线）。
//     复核方法是【从真正生成出来的 public/index.html 里抠出 :root、解析 var()、逐对算】，
//     不是拿这份源码里的字面值算的。
// ============================================================================
const ROOT_VARS =
  ':root{' +

  // 深色界面：让浏览器把滚动条、搜索框自带的清除按钮也画成深色（不然会出现
  // 一个白底的搜索框 / 一个看不见的"✕"）
  'color-scheme:dark;' +

  // 底色与面板（面板是半透明的，专门让底下的渐变壁纸透上来）
  '--c-bg-page:#0d0a12;' +          // 兜底底色（壁纸加载不出来时才看得见它）
  // ★ 2026-09-16 用户要求："把背景与比赛的对比度做高一点"。
  //   原来这里是 rgba(13,7,11,.74) —— 叠在壁纸上之后，方块和它身后的背景
  //   【几乎一模一样的黑】。实测（1300×1500 截图逐像素取色）：
  //     方块墙那一段背景 #08080f~#140c13，方块 #0b070c~#0f080d，
  //     L* 差只有 0.01~1.4，WCAG 比值 1.000~1.029 —— 等于看不出边界。
  //   原因：`.abyss::after` 那层压暗渐变把壁纸压到近黑，而方块本身也是近黑半透明，
  //   两个近黑叠在一起，比值公式在近黑区还会"饱和"，所以怎么调都看不出来。
  //   改法：把方块【提亮】成一档暗酒红（不是把背景压得更黑 —— 用户说过"太黑"），
  //   同时把不透明度 .74→.88，让方块颜色不再跟着背后的渐变忽明忽暗。
  //   实测结果：方块墙那一段 ΔL* 从 0.01 提到 10.2~11.7（≥10 才算"一眼分得开"），
  //   工具条/统计条 7.3~8.8；方块上文字的对比度最低仍是 4.96:1（最淡的页脚字），
  //   全部 ≥4.5:1。改这一个令牌，方块/卡片/工具条三处同时生效（它们是同源的）。
  '--c-bg-card:rgba(64,28,38,.88);' + // 卡片 / 方块 / 工具条的底（提亮见上）
  '--c-bg-page2:rgba(9,5,9,.55);' +  // details 那种比卡片更沉一点的底
  '--c-bg-soft:rgba(255,255,255,.07);' +  // hover 用的底
  '--c-bg-soft2:rgba(255,255,255,.05);' + // "清空条件"按钮的底

  // 字色（暖白系，压在深红/墨蓝底上比冷白舒服）
  '--c-ink:#f4e9e6;' +              // 最主要的字色 13.6:1
  '--c-fg-soft:#dcc3bf;' +          // 次要字色 10.6:1
  '--c-fg-mute:#bfa19c;' +          // 更淡的字色 7.5:1
  '--c-fg-faint:#a98d88;' +         // 最淡的字色（页脚那种）5.9:1
  '--c-fg-strong:#e8d6d2;' +        // 偏重的次要字色 12.1:1

  // 边框（主题的暗红系；深底上"红框"比灰框更像这个主题）
  '--c-bd:#5e2b32;' +               // 常规边框（主题的暗红 cyredark 提亮一档，才看得见）
  '--c-bd2:#8a3b44;' +              // 输入框 / 按钮的边框（更明显一档）
  '--c-bd-dash:#3d2025;' +          // 行与行之间的虚线（很淡，只做分隔暗示）
  '--c-bd-dashed:#9a6a68;' +        // "官网未公布"那个虚线框

  // 主题的霓虹色（原样搬过来，一个都没改）
  '--c-cyan:#5ef6ff;' +
  '--c-blue:#00c7ff;' +
  '--c-red:#f75049;' +
  '--c-red2:#fe605a;' +
  '--c-amber:#fb932e;' +
  '--c-amber2:#e49753;' +
  '--c-green:#4ab87a;' +
  '--c-yellow:#dbfe50;' +
  '--c-pink:#ff528d;' +
  // ★ 压在霓虹底上的字必须用【近黑】。深色版里 --c-ink 是"浅字"，
  //   所以主按钮 / 已选胶囊这些"霓虹底 + 字"的地方【不能】用 --c-ink 当字色，
  //   否则就是"浅字压亮底"，那是上一版被抓到过的 1.11:1（等于看不见）。
  '--c-ink-on-accent:#04191c;' +

  // 状态色（用主题的绿和红）
  '--c-ok:#4ab87a;' +
  '--c-ok-deep:#4ab87a;' +
  '--c-bad:#f75049;' +

  // 分类标签（主题青的淡底 + 青字）
  '--c-tag-bg:rgba(94,246,255,.10);' +
  '--c-tag-ink:#5ef6ff;' +
  '--c-tag-bd:rgba(94,246,255,.34);' +

  // 地区 / 参赛范围（2026-09-17 新增）：用主题蓝。
  // 为什么用蓝：方块上已经有"方向"（青）、"报名截止"（橙）、奖金六档（青/黄绿/绿/暗红灰/粉/虚线），
  // 蓝色在这几个里没出现过，不会和任何一个撞色；细节页的说明框用的也是这个蓝，含义一致。
  '--c-rg-ink:#00c7ff;' +
  '--c-rg-bd:rgba(0,199,255,.42);' +

  // 比赛形式 / 比赛地点（2026-09-17 第四轮新增，用户要求）：用【紫罗兰】。
  // 为什么是紫：方块上已经有 分类(青) / 地区(蓝) / 截止(橙) / 奖金(青·黄绿·绿·灰·粉) /
  // 按钮(青)，实测把它们和紫色两两算色相距离，紫色(264°)离**每一个**都 ≥25°（最近的也差 40°+），
  // 所以加它不会像上一轮"奖金撞色"那样撞成一片。字压面板 7.35:1、压淡底 6.06:1。
  // 形式用"淡底 + 描边"（和分类标签一套），地点用"只有描边"（和地区胶囊一套），
  // 两者同色系但深浅不同，一眼能分开是两类信息。
  '--c-vn-ink:#c9a6ff;' +
  '--c-vn-bg:rgba(201,166,255,.10);' +
  '--c-vn-bd:rgba(201,166,255,.34);' +
  '--c-vn-bd2:rgba(201,166,255,.42);' +

  // 截止日期（主题的橙，深底上正好够亮）
  '--c-dl:#e49753;' +

  // 奖金六档（与 PRIZE_TIERS 一一对应，改一处就要改另一处）
  //   深色版用【霓虹实心 + 近黑字】表达，越亮 = 奖金越高，一眼能看出顺序：
  //     青（最亮）> 黄绿 > 绿 > 中性灰实心（最低）／外币粉（描边） / 未公布（虚线框）
  //
  // ★★ 2026-09-16 用户报："奖金那个别跟别的撞色撞到看不清，比如奖金 6000 那个"。
  //    实测（无头 Edge 打开真页面、读 getComputedStyle 算出来的，不是估的）：
  //      · pz-4 原来是 rgba(255,255,255,.07) —— 7% 白压在深底上等于【没有底】，
  //        胶囊看上去就是一串飘着的字，和旁边青/黄绿/绿的实心胶囊完全不成一套；
  //        它和方块之间的 ΔL* 只有 6.7，也就是"看不出这是个牌子"。
  //      · 更要命的是【撞色】：pz-4 合成出来是 #4d2c35（色相 343°），
  //        而"外币"那档的粉 #ff8ab3 是 338° —— 只差 4°。"5 万以下"和"外币"
  //        在屏幕上是几乎同一个颜色，只能靠读字面意思去分。这就是用户说的撞色。
  //   改法（两处，都只改颜色，没动任何档位门槛、也没动一个字文案）：
  //      ① pz-4 改成【实心中性灰】#5d565a + 浅字。灰是"无彩色"，
  //         和方块上任何一个霓虹色（青/蓝/橙/绿/粉）都不抢，物理上不可能撞色；
  //         语义上也顺："最低档 = 没有彩色"。它仍然比 pz-3 的绿更暗，顺序没乱。
  //      ② "未公布"的字从 mauve #b3948f 换成中性灰 #c9c1bf ——
  //         原来它和外币的粉也只差几度，同样容易看混；现在【灰 = 没有数据、
  //         粉 = 外币】，而且一个是虚线框、一个是实心牌子，形状也不同。
  //   复核结果：六档两两色相距离最小 26°（外币粉 vs 未公布灰），其余 ≥37° 或近无彩色。
  //   ★ 这三行只改了"颜色"：PRIZE_TIERS 的门槛和 PRIZE_LABEL 的文案一个字没动，
  //     所以自检里"奖金六档按钮和方块对得上"那一条照旧通过。
  //   每档还多给一个 --pzc：方块顶上那道 3px 的色条用它上色，
  //   所以不看胶囊也能一眼扫出哪几个是大奖。
  '--c-pz1-bg:#5ef6ff;--c-pz1-ink:#04191c;--c-pz1-bd:#5ef6ff;--c-pz1-bar:#5ef6ff;' +   // 20 万及以上（青）13.9:1
  '--c-pz2-bg:#dbfe50;--c-pz2-ink:#141a00;--c-pz2-bd:#dbfe50;--c-pz2-bar:#dbfe50;' +   // 10 万~20 万（黄绿）16.3:1
  '--c-pz3-bg:#4ab87a;--c-pz3-ink:#03170c;--c-pz3-bd:#4ab87a;--c-pz3-bar:#4ab87a;' +   // 5 万~10 万（绿）7.5:1
  '--c-pz4-bg:#5d565a;--c-pz4-ink:#f4ecea;--c-pz4-bd:#7b7377;--c-pz4-bar:#5d565a;' +   // 5 万以下（中性灰【实心】）6.1:1
  '--c-pzo-bg:rgba(255,82,141,.22);--c-pzo-ink:#ffbcd4;--c-pzo-bd:#ff528d;--c-pzo-bar:#ff528d;' +  // 外币（不换算，粉）6.8:1
  '--c-pzn-bg:rgba(201,193,191,.14);--c-pzn-ink:#f4e9e6;--c-pzn-bd:#c9c1bf;--c-pzn-bar:#82787a;' +    // 官网未公布（浅灰底 + 虚线，中性灰）

  // 提示条：红（采集失败之类的警告）
  '--c-warn-bg:rgba(247,80,73,.12);--c-warn-bd:#f75049;--c-warn-ink:#ff8b84;--c-warn-ink2:#ff9a94;' +
  // 提示条：蓝（说明）
  '--c-info-bg:rgba(94,246,255,.08);--c-info-bd:#2b7d88;--c-info-ink:#9fdde2;' +
  // 提示条：橙（notice）
  '--c-notice-bg:rgba(251,147,46,.10);--c-notice-bd:#fb932e;--c-notice-ink:#f3b477;' +
  '--c-notice-ink2:#f7c08a;--c-notice-bd2:#7a4a1c;' +
  // 提示条：绿（notice.ok2）
  '--c-oknote-bg:rgba(74,184,122,.12);--c-oknote-bd:#4ab87a;--c-oknote-ink:#8edcb2;--c-oknote-ink2:#a3e5c2;' +
  // 备用色
  '--c-ink-deep:#5ef6ff;' +
  '--c-alt:#5ef6ff;' +

  // 阴影与光晕：深底靠"霓虹光晕"分层，不靠黑阴影
  '--c-shadow:rgba(0,0,0,.45);' +
  '--c-glow:rgba(94,246,255,.45);' +
  '}';

const CSS =
  ROOT_VARS +

  // ---------- 字体：三个字体文件都是素材包（深潜协议1.2.2.apk）里带的那几支 ----------
  //   ★ 这两个字体【只有拉丁字母和数字】，没有汉字 —— 汉字一律落到系统字体。
  //     所以它们的活是：数字（奖金、日期、大数字）和英文标签，汉字保持系统字体。
  //     这样既有主题的"技术感"，又不会让中文变得难认。
  //   ★ font-display:swap = 字体没下载完也先显示系统字，绝不让人对着白屏等。
  '@font-face{font-family:Orbitron;src:url(/media/fonts/orbitron-bold.ttf) format("truetype");font-weight:700;font-display:swap}' +
  '@font-face{font-family:Orbitron;src:url(/media/fonts/orbitron-medium.ttf) format("truetype");font-weight:500;font-display:swap}' +
  '@font-face{font-family:Rajdhani;src:url(/media/fonts/rajdhani-semibold.ttf) format("truetype");font-weight:600;font-display:swap}' +

  '*{box-sizing:border-box}' +
  'body{font-family:Rajdhani,system-ui,"Microsoft YaHei",sans-serif;background:var(--c-bg-page);margin:0;padding:0 16px 60px;color:var(--c-ink);line-height:1.7}' +
  // 背景层：主题自带的那张竖向渐变壁纸（深红 → 墨蓝）+ 一层压暗与顶部红光
  // ★ 路径写成 /media/... 这种【从网站根目录算起】的形式：
  //   首页在 /index.html、详情页在 /detail/xxx.html，用相对路径会算到两个地方去。
  '.abyss{position:fixed;left:0;top:0;right:0;bottom:0;z-index:-1;background-color:var(--c-bg-page);background-image:url(/media/bg/abyss.jpg);background-size:100% 100%;background-repeat:no-repeat}' +
  '.abyss::after{content:"";position:absolute;left:0;top:0;right:0;bottom:0;background:radial-gradient(120% 62% at 50% -6%,rgba(247,80,73,.18),rgba(247,80,73,0) 62%),linear-gradient(180deg,rgba(8,5,9,0) 0%,rgba(8,5,9,.42) 45%,rgba(8,5,9,.8) 100%)}' +
  '.wrap{max-width:900px;margin:0 auto}' +
  'header{padding:26px 0 16px;border-bottom:1px solid var(--c-bd);margin-bottom:20px}' +
  // 顶部那条"终端头"：主题标记 + 英文站名 + 一条数据带（素材包里的图形）
  '.hud{display:flex;align-items:center;gap:11px;flex-wrap:wrap;font-family:Rajdhani,system-ui,sans-serif;font-weight:600;font-size:12px;letter-spacing:.2em;text-transform:uppercase;color:var(--c-cyan)}' +
  '.hud .logo{width:26px;height:auto;display:block}' +
  '.hud .band{width:132px;height:auto;display:block;margin-left:auto;opacity:.6}' +
  'header h1{margin:13px 0 8px;font-size:29px;letter-spacing:.01em;text-shadow:0 0 22px rgba(94,246,255,.22)}' +
  '.meta{font-size:13px;color:var(--c-fg-soft)}' +
  '.meta div{margin-top:4px}' +
  '.ok{color:var(--c-ok);font-weight:600}.bad{color:var(--c-bad);font-weight:600}' +
  // 顶部那个大数字（Orbitron + 霓虹光晕，主题里"数码读数"的样子）
  '.stat{display:flex;gap:12px;flex-wrap:wrap;margin:16px 0 22px}' +
  '.stat div{background:var(--c-bg-card);border:1px solid var(--c-bd);border-left:3px solid var(--c-cyan);border-radius:2px;padding:11px 20px;min-width:150px}' +
  '.stat b{display:block;font-family:Orbitron,system-ui,sans-serif;font-weight:700;font-size:33px;line-height:1.2;color:var(--c-cyan);text-shadow:0 0 18px var(--c-glow)}' +
  '.stat span{font-size:13px;letter-spacing:.08em;color:var(--c-fg-mute)}' +
  '.card{background:var(--c-bg-card);border:1px solid var(--c-bd);border-radius:2px;padding:22px;margin-bottom:20px}' +
  '.grid{display:grid;grid-template-columns:repeat(4,1fr);gap:14px;margin:4px 0 26px}' +
  // ★ 2026-09-17 修：方块墙【横向溢出】。grid 的 1fr 其实是 minmax(auto,1fr)，
  //   而 auto 那条最小尺寸 = 方块自己的 min-content（标题那个两行截断的框报出来的
  //   最小宽度有 300px 左右），于是四列最少也要 1200px —— 900px 的版心根本装不下，
  //   结果整页多出一条横向滚动条、最右边那一列被切掉（手机两列时同样溢出）。
  //   给方块加 min-width:0 就是告诉浏览器"允许比内容更窄"，文字照样正常折行。
  '.grid>.tile{min-width:0}' +
  // 方块：顶上一道奖金色条 + 左右下角的 HUD 直角括号，是这一版的主视觉
  '.tile{position:relative;background:var(--c-bg-card);border:1px solid var(--c-bd);border-top:3px solid var(--pzc,var(--c-bd2));border-radius:2px;padding:12px 12px 10px;display:flex;flex-direction:column;gap:8px;transition:border-color .15s,box-shadow .15s,transform .15s}' +
  '.tile::before,.tile::after{content:"";position:absolute;bottom:-1px;width:10px;height:10px;border-bottom:1px solid var(--c-cyan);opacity:.45;pointer-events:none}' +
  '.tile::before{left:-1px;border-left:1px solid var(--c-cyan)}' +
  '.tile::after{right:-1px;border-right:1px solid var(--c-cyan)}' +
  '.tile:hover{border-color:var(--c-cyan);box-shadow:0 0 0 1px rgba(94,246,255,.3),0 10px 30px var(--c-shadow);transform:translateY(-1px)}' +
  '.tile:hover::before,.tile:hover::after{opacity:1}' +
  '.tile .tt{font-size:14.5px;font-weight:600;line-height:1.5;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden}' +
  '.tile .tag{font-size:12px;font-family:Rajdhani,system-ui,sans-serif;letter-spacing:.04em;color:var(--c-tag-ink);background:var(--c-tag-bg);border:1px solid var(--c-tag-bd);border-radius:2px;padding:1px 8px;align-self:flex-start;max-width:100%;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}' +
  // 标签 + 地区胶囊放同一行；两个都可能缺（tag 为 null 的有 2 条、地区认不出的有 18 条），
  // 所以两个都缺时整行不输出（见 renderTile 里的 metaRow）
  '.tile .metarow{display:flex;flex-wrap:wrap;gap:6px;align-items:center;max-width:100%}' +
  '.tile .rg{font-size:11.5px;font-weight:700;font-family:Rajdhani,system-ui,sans-serif;letter-spacing:.05em;color:var(--c-rg-ink);border:1px solid var(--c-rg-bd);border-radius:2px;padding:1px 7px;white-space:nowrap}' +
  // 比赛形式（线上/线上线下/线下）：淡底 + 描边，紫色。
  // 比赛地点（上海…）：只有描边、没有底（和"地区"一个样式语言），同色系但更轻。
  '.tile .vn{font-size:11.5px;font-weight:700;font-family:Rajdhani,system-ui,sans-serif;letter-spacing:.05em;color:var(--c-vn-ink);background:var(--c-vn-bg);border:1px solid var(--c-vn-bd);border-radius:2px;padding:1px 7px;white-space:nowrap}' +
  '.tile .vc{font-size:11.5px;font-weight:700;font-family:Rajdhani,system-ui,sans-serif;letter-spacing:.05em;color:var(--c-vn-ink);border:1px solid var(--c-vn-bd2);border-radius:2px;padding:1px 7px;white-space:nowrap}' +
  '.tile .dl{font-size:12.5px;font-family:Rajdhani,system-ui,sans-serif;letter-spacing:.03em;color:var(--c-dl)}' +
  // 奖金那一行（金额不同颜色不同，用户要求）。颜色含义与 PRIZE_TIERS 一一对应：
  //   青 = 20 万及以上 ／ 黄绿 = 10 万~20 万 ／ 绿 = 5 万~10 万 ／ 暗红灰 = 5 万以下
  //   粉 = 外币（不换算）／ 虚线框 = 官网未公布
  // ★ 深色版是"霓虹实心 + 近黑字"：压在青 #5ef6ff 上的字是 #04191c（13.9:1），
  //   不是白字 —— 白字压亮青只有 1.4:1，那是看不见的。
  '.tile .pz{font-size:11.5px;font-weight:700;font-family:Rajdhani,system-ui,sans-serif;letter-spacing:.04em;border-radius:2px;padding:2px 9px;align-self:flex-start;max-width:100%;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;border:1px solid transparent}' +
  '.tile .pz-1{background:var(--c-pz1-bg);color:var(--c-pz1-ink);border-color:var(--c-pz1-bd)}' +
  '.tile .pz-2{background:var(--c-pz2-bg);color:var(--c-pz2-ink);border-color:var(--c-pz2-bd)}' +
  '.tile .pz-3{background:var(--c-pz3-bg);color:var(--c-pz3-ink);border-color:var(--c-pz3-bd)}' +
  '.tile .pz-4{background:var(--c-pz4-bg);color:var(--c-pz4-ink);border-color:var(--c-pz4-bd)}' +
  '.tile .pz-other{background:var(--c-pzo-bg);color:var(--c-pzo-ink);border-color:var(--c-pzo-bd)}' +
  '.tile .pz-none{background:var(--c-pzn-bg);color:var(--c-pzn-ink);border:1px dashed var(--c-pzn-bd)}' +
  // 方块顶上那道色条：跟着奖金档走（.tile 身上有 data-prize 属性，见 renderTile）
  '.tile[data-prize="pz-1"]{--pzc:var(--c-pz1-bar)}' +
  '.tile[data-prize="pz-2"]{--pzc:var(--c-pz2-bar)}' +
  '.tile[data-prize="pz-3"]{--pzc:var(--c-pz3-bar)}' +
  '.tile[data-prize="pz-4"]{--pzc:var(--c-pz4-bar)}' +
  '.tile[data-prize="pz-other"]{--pzc:var(--c-pzo-bar)}' +
  '.tile[data-prize="pz-none"]{--pzc:var(--c-pzn-bar)}' +
  '.tile .btns{margin-top:auto;display:flex;gap:8px;flex-wrap:wrap}' +
  '.tile .btns .btn{flex:1 1 auto;text-align:center;padding:6px 8px;font-size:13px;min-width:0}' +
  // 方块上两个按钮要能分清：【去官网报名】是亮青实心（要人点的那个），
  // 【详情】是暗底描边（次要动作）。原来两个都是灰的、长得一模一样。
  '.tile .btns .btn.alt{background:var(--c-cyan);border-color:var(--c-cyan);color:var(--c-ink-on-accent);font-weight:600;box-shadow:0 0 14px rgba(94,246,255,.28)}' +
  '@media (max-width:640px){.grid{grid-template-columns:repeat(2,1fr)}}' +
  // ---------- 子页用到的小样式 ----------
  '.crumb{margin-bottom:6px}.crumb a{font-size:13px;color:var(--c-fg-mute);text-decoration:none}' +
  '.crumb a:hover{color:var(--c-cyan)}' +
  '.meta2{font-size:12.5px;color:var(--c-fg-mute);margin-top:14px}' +
  '.cardhead{display:flex;gap:12px;align-items:flex-start;justify-content:space-between;flex-wrap:wrap}' +
  '.cardhead h2{margin:0;font-size:19px;line-height:1.45;flex:1;min-width:240px}' +
  '.badge{font-size:12.5px;padding:3px 12px;border-radius:2px;white-space:nowrap;font-weight:600;border:1px solid transparent;letter-spacing:.04em}' +
  '.badge.b-open{background:var(--c-green);color:#04170c;border-color:var(--c-green)}' +
  '.badge.b-closed{background:rgba(255,255,255,.09);color:var(--c-fg-soft);border-color:var(--c-bd2)}' +
  '.badge.b-not_started{background:var(--c-blue);color:var(--c-ink-on-accent);border-color:var(--c-blue)}' +
  '.badge.b-unknown{background:var(--c-amber);color:var(--c-ink-on-accent);border-color:var(--c-amber)}' +
  '.badge.b-invalid{background:rgba(255,255,255,.09);color:var(--c-fg-mute);border-color:var(--c-bd2)}' +
  '.sub{color:var(--c-fg-soft);font-size:14px;margin-top:6px}' +
  '.rows{margin:14px 0}' +
  '.row{display:flex;font-size:14px;padding:5px 0;border-bottom:1px dashed var(--c-bd-dash)}' +
  '.row .k{width:96px;flex:none;color:var(--c-fg-mute)}' +
  '.row .v{flex:1;word-break:break-all}' +
  '.warn{background:var(--c-warn-bg);border:1px solid var(--c-warn-bd);border-left:3px solid var(--c-warn-bd);color:var(--c-warn-ink);padding:10px 14px;border-radius:2px;font-size:13px;margin:12px 0}' +
  '.notes{background:var(--c-info-bg);border:1px solid var(--c-info-bd);border-left:3px solid var(--c-info-bd);border-radius:2px;padding:11px 16px;margin:14px 0;font-size:12.5px;color:var(--c-info-ink)}' +
  // "地区是怎么来的"那个出处框（2026-09-17 新增）：故意做得比 .notes 更轻，
  // 它只是"给你核对用的出处"，不是正文内容。
  '.ev{border-left:3px solid var(--c-rg-bd);padding:2px 0 2px 14px;margin:12px 0;font-size:12.5px;color:var(--c-fg-mute)}' +
  '.ev b{display:block;margin-bottom:4px;color:var(--c-fg-soft);font-weight:700}' +
  '.notes b{display:block;margin-bottom:5px;font-size:13px}' +
  '.notes ul{margin:0;padding-left:18px}' +
  '.notes li{margin:3px 0}' +
  '.notice{background:var(--c-notice-bg);border:1px solid var(--c-notice-bd);border-left:3px solid var(--c-notice-bd);border-radius:2px;padding:16px 20px;margin:18px 0;font-size:14px;color:var(--c-notice-ink)}' +
  '.notice b{display:block;font-size:16px;margin-bottom:6px;color:var(--c-notice-ink2)}' +
  '.notice p{margin:6px 0}' +
  '.notice ul{margin:6px 0 0;padding-left:20px}' +
  '.notice code{background:rgba(0,0,0,.35);padding:1px 6px;border-radius:2px;border:1px solid var(--c-notice-bd2);color:var(--c-ink)}' +
  '.notice.ok2{background:var(--c-oknote-bg);border-color:var(--c-oknote-bd);color:var(--c-oknote-ink)}' +
  '.notice.ok2 b{color:var(--c-oknote-ink2)}' +
  '.notice.bad2{background:var(--c-warn-bg);border-color:var(--c-warn-bd);color:var(--c-warn-ink2)}' +
  '.notice.bad2 b{color:var(--c-warn-ink)}' +
  // 提示条左边那个警戒三角（素材包里的图形）：只在这类"出事了"的框上出现
  '.notice.bad2 b{padding-left:26px;background-repeat:no-repeat;background-position:0 3px;background-size:18px auto;background-image:url(/media/mark/warn.png)}' +
  '.warn{padding-left:38px;background-repeat:no-repeat;background-position:12px 11px;background-size:18px auto;background-image:url(/media/mark/warn.png)}' +
  '.btnrow{margin:14px 0;display:flex;gap:10px;flex-wrap:wrap}' +
  '.btn{display:inline-block;background:var(--c-cyan);color:var(--c-ink-on-accent);text-decoration:none;padding:8px 16px;border-radius:2px;font-size:14px;border:1px solid var(--c-cyan);font-weight:600}' +
  '.btn:hover{box-shadow:0 0 18px rgba(94,246,255,.35)}' +
  '.btn.alt{background:rgba(94,246,255,.08);color:var(--c-cyan);border-color:var(--c-cyan)}' +
  '.btn.alt:hover{background:rgba(94,246,255,.16)}' +
  '.btn.small{padding:6px 12px;font-size:13px;background:rgba(255,255,255,.06);color:var(--c-ink);border:1px solid var(--c-bd2)}' +
  '.btn.small:hover{background:rgba(255,255,255,.12);box-shadow:none}' +
  // 小标题：主题里那种"// BODYSTATUS"的写法（// 是装饰，加在左边）
  'h3{font-size:15px;margin:22px 0 10px;color:var(--c-ink);border-left:3px solid var(--c-cyan);padding-left:10px}' +
  'details{border:1px solid var(--c-bd);border-radius:2px;margin-bottom:8px;background:var(--c-bg-page2)}' +
  'details summary{cursor:pointer;padding:11px 14px;font-size:14px;font-weight:600;list-style:none}' +
  'details summary::-webkit-details-marker{display:none}' +
  'details summary::before{content:"▸ ";color:var(--c-cyan)}' +
  'details[open] summary::before{content:"▾ "}' +
  'details .prize{float:right;color:var(--c-ok);font-weight:700}' +
  '.info{list-style:none;margin:0;padding:0 14px 12px}' +
  '.info li{font-size:13.5px;color:var(--c-fg-strong);margin:7px 0}' +
  '.body{padding:0 14px 14px;font-size:13.5px;color:var(--c-fg-strong)}' +
  '.body p{margin:8px 0}' +
  '.src{font-size:12px;color:var(--c-fg-faint);margin-top:14px;padding-top:10px;border-top:1px solid var(--c-bd-dash);word-break:break-all}' +
  '.src a{color:var(--c-fg-mute)}' +
  '.src a:hover{color:var(--c-cyan)}' +
  'footer{text-align:center;color:var(--c-fg-faint);font-size:12px;margin-top:34px}' +
  'footer .beian{margin-top:8px;color:var(--c-fg-mute);font-size:12px}' +
  'footer .beian span{margin:0 7px}' +
  'footer .beian a{color:var(--c-fg-mute);text-decoration:none}' +
  'footer .beian a:hover{text-decoration:underline}' +
  // ---------- 搜索与筛选工具条 ----------
  // 纯前端：本站是静态站、服务器上不跑程序，所以筛选只能用浏览器里的 JS 做。
  // ★ 20 个方块【始终都在 HTML 里】，JS 只负责把它们显示/隐藏（.tile.is-off 只是
  //   display:none）—— 这样搜索引擎照样看得到全部内容，robots/sitemap/canonical 那套不白做。
  '.fbar{position:relative;background:var(--c-bg-card);border:1px solid var(--c-bd);border-radius:2px;padding:13px 14px;margin:0 0 18px}' +
  '.fbar::before{content:"";position:absolute;left:-1px;top:-1px;width:36px;height:2px;background:var(--c-cyan)}' +
  '.fbar .frow{display:flex;align-items:center;gap:8px;flex-wrap:wrap;margin:0 0 9px}' +
  '.fbar .frow:last-child{margin-bottom:0}' +
  '.fbar .flab{font-size:12px;font-family:Rajdhani,system-ui,sans-serif;font-weight:600;letter-spacing:.14em;color:var(--c-cyan);flex:none;width:56px;white-space:nowrap}' +
  '.fbar .flab::before{content:"// "}' +
  // 计数那一行用的是同一个类、但没有字（只当占位用），别让它孤零零显示一个 //
  '.fbar .flab:empty::before{content:""}' +
  '.fq{flex:1 1 200px;min-width:0;font-size:14px;padding:8px 12px;border:1px solid var(--c-bd2);border-radius:2px;font-family:inherit;color:var(--c-ink);background:rgba(0,0,0,.4)}' +
  '.fq::placeholder{color:var(--c-fg-mute);opacity:1}' +
  '.fq:focus{outline:none;border-color:var(--c-cyan);box-shadow:0 0 0 2px rgba(94,246,255,.18)}' +
  '.fclear{flex:none;font-size:13px;padding:8px 12px;border:1px solid var(--c-bd2);background:var(--c-bg-soft2);color:var(--c-fg-strong);border-radius:2px;cursor:pointer;font-family:inherit}' +
  '.fclear:hover{background:var(--c-bg-soft);border-color:var(--c-cyan);color:var(--c-cyan)}' +
  '.chip{font-size:12.5px;padding:4px 11px;border:1px solid var(--c-bd);background:rgba(255,255,255,.05);color:var(--c-fg-soft);border-radius:2px;cursor:pointer;font-family:inherit;line-height:1.5}' +
  '.chip:hover{border-color:var(--c-cyan);color:var(--c-cyan)}' +
  '.chip.on{background:var(--c-cyan);border-color:var(--c-cyan);color:var(--c-ink-on-accent);font-weight:600;box-shadow:0 0 14px rgba(94,246,255,.3)}' +
  '.fcount{font-size:12.5px;font-family:Rajdhani,system-ui,sans-serif;letter-spacing:.04em;color:var(--c-fg-mute)}' +
  '.fhint{font-size:12px;color:var(--c-fg-faint)}' +
  '.tile.is-off{display:none}' +
  '.fempty{display:none;background:var(--c-bg-card);border:1px solid var(--c-bd);border-left:3px solid var(--c-amber);border-radius:2px;padding:22px;text-align:center;color:var(--c-fg-soft);font-size:14px}' +
  '.fempty.show{display:block}' +
  '.fempty b{display:block;font-size:15px;color:var(--c-ink);margin-bottom:6px}' +
  '@media (max-width:520px){' +
    '.fbar{padding:10px 11px}' +
    '.fbar .flab{width:auto}' +
    '.fq{flex:1 1 100%}' +
  '}' +
  // ---------- 手机适配 ----------
  '@media (max-width:520px){' +
    'body{padding:0 12px 40px}' +
    'header{padding:20px 0 14px}' +
    'header h1{font-size:23px}' +
    '.hud .band{display:none}' +
    '.card{padding:16px 14px}' +
    '.stat div{flex:1 1 0;min-width:0;padding:10px 12px}' +
    '.stat b{font-size:26px}' +
    '.cardhead h2{min-width:0;font-size:17px}' +
    '.row{flex-direction:column;padding:7px 0}' +
    '.row .k{width:auto;font-size:12.5px}' +
    '.row .v{font-size:14px}' +
    '.notice{padding:13px 15px}' +
    '.btn{flex:1 1 auto;text-align:center}' +
  '}' +
  '@media (max-width:360px){' +
    'header h1{font-size:21px}' +
    '.stat b{font-size:23px}' +
    '.cardhead h2{font-size:16px}' +
  '}';

// ---------- 右下角"意见信箱"的样式（2026-09-17 新增，用户要求） ----------
//
// 【为什么不并进上面那份 CSS】上面那份是【首页和详情页共用】的。信箱目前只挂在首页
//   （用户原话是"网站首页右下角"），并进去的话，20 张详情页会各自多背一段用不到的
//   样式：白占体积，更要紧的是"这一轮只改了首页"这件事会变得看不出来 ——
//   每张详情页都会跟着变一遍，以后拿包和网页对账时分不清是谁改的。
//   所以单独一份 MAILBOX_CSS，只在 renderPage() 里拼上去。
//
// 【颜色故意不新增任何令牌】浮层最容易出的问题是"字压在什么颜色上说不准"，
//   所以这里全部复用已经在册的那几对颜色：
  //     · 面板底 = --c-bg-card（和方块/卡片/工具条同一个令牌）→ 字色对比度
  //       已经在"27 对全部 ≥4.5:1"那次复核里算过（当时的底是 #401b24）；
  //     · 按钮 = --c-cyan 底 + --c-ink-on-accent 字（13.87:1，和"去官网报名"同一个配方）。
  //   ★ 也就是说：加这一块【没有引入任何一对没算过对比度的颜色】。
  //   ★ 位置用 position:fixed 钉在视口右下角，所以它不会把方块墙挤歪、
  //     也不会让手机出现横向滚动条（面板宽度写的是 min(330px, 100vw - 36px)）。
const MAILBOX_CSS =
  '.mbox{position:fixed;right:18px;bottom:18px;z-index:60;text-align:left}' +
  '.mbox-btn{display:flex;align-items:center;gap:8px;padding:10px 16px;border-radius:999px;' +
    'border:1px solid var(--c-cyan);background:var(--c-cyan);color:var(--c-ink-on-accent);' +
    'font:inherit;font-weight:700;font-size:14px;line-height:1;cursor:pointer;' +
    'box-shadow:0 6px 22px var(--c-shadow)}' +
  '.mbox-btn:hover{background:#93faff}' +
  '.mbox-btn:focus-visible{outline:2px solid var(--c-ink);outline-offset:2px}' +
  '.mbox-ico{font-size:15px;line-height:1}' +
  '.mbox-panel{display:none;position:absolute;right:0;bottom:calc(100% + 10px);' +
    'width:min(340px,calc(100vw - 36px));padding:14px;box-sizing:border-box;' +
    'background:var(--c-bg-card);border:1px solid var(--c-bd2);border-radius:14px;' +
    'box-shadow:0 14px 36px rgba(0,0,0,.55)}' +
  '.mbox-panel.is-open{display:block}' +
  '.mbox-hd{display:flex;align-items:center;justify-content:space-between;gap:8px;' +
    'color:var(--c-ink);font-size:15px;font-weight:700}' +
  '.mbox-x{border:0;background:transparent;color:var(--c-fg-mute);font:inherit;font-size:15px;' +
    'line-height:1;cursor:pointer;padding:2px 6px;border-radius:6px}' +
  '.mbox-x:hover{color:var(--c-ink);background:var(--c-bg-soft)}' +
  '.mbox-sub{color:var(--c-fg-mute);font-size:12px;line-height:1.6;margin:6px 0 10px}' +
  '.mbox-ta,.mbox-in{display:block;width:100%;box-sizing:border-box;font:inherit;font-size:13px;' +
    'color:var(--c-ink);background:var(--c-bg-page2);border:1px solid var(--c-bd2);' +
    'border-radius:9px;padding:8px 10px}' +
  '.mbox-ta{min-height:92px;resize:vertical;line-height:1.6}' +
  '.mbox-in{margin-top:8px}' +
  '.mbox-ta::placeholder,.mbox-in::placeholder{color:var(--c-fg-faint)}' +
  '.mbox-ta:focus,.mbox-in:focus{outline:none;border-color:var(--c-cyan)}' +
  '.mbox-row{display:flex;flex-wrap:wrap;gap:8px;margin-top:10px}' +
  '.mbox-send{flex:1 1 auto;padding:9px 14px;border-radius:9px;border:1px solid var(--c-cyan);' +
    'background:var(--c-cyan);color:var(--c-ink-on-accent);font:inherit;font-size:13px;' +
    'font-weight:700;cursor:pointer}' +
  '.mbox-send:hover{background:#93faff}' +
  '.mbox-copy,.mbox-link{padding:9px 12px;border-radius:9px;border:1px solid var(--c-bd2);' +
    'background:var(--c-bg-soft2);color:var(--c-fg-soft);font:inherit;font-size:13px;cursor:pointer}' +
  '.mbox-copy:hover,.mbox-link:hover{background:var(--c-bg-soft);color:var(--c-ink)}' +
  '.mbox-msg{margin-top:9px;font-size:12px;line-height:1.6;color:var(--c-fg-mute)}' +
  '.mbox-msg:empty{display:none}' +
  '.mbox-msg.good{color:var(--c-oknote-ink)}' +
  '.mbox-msg.warn{color:var(--c-notice-ink)}' +
  '.mbox-msg.bad{color:var(--c-warn-ink)}' +
  // 手机上把按钮收小一点，免得它挡住方块上的"详情 / 去官网报名"
  '@media (max-width:420px){' +
    '.mbox{right:12px;bottom:12px}' +
    '.mbox-btn{padding:9px 13px;font-size:13px}' +
  '}' +
  // 打印时不该出现一个浮在纸上的按钮
  '@media print{.mbox{display:none}}';

// ---------- 首页那段筛选脚本（2026-09-16 新增，用户要求） ----------
// 【为什么内联在网页里、不单独存一个 .js 文件】
//   单独一个文件就得同时改 deploy\pack.js 的"必须一起传上去"清单和打包清单，
//   多一个可能漏传的东西（第十二版那个"改了网页没重新打包"就是这么来的）。
//   内联没有这个风险：包里的文件数仍是 23 个，一个不多。
// 【为什么读方块自己身上的 data- 属性，而不是另塞一份数据进来】
//   只留一份真相 —— 不会出现"脚本里说 6 场、页面上却有 20 个方块"这种自相矛盾。
// 【这段脚本里一个反斜杠都没有、也没有那个 u 开头的"未定义"英文单词】
//   deploy\preflight.js 会把页面上出现的这两样判成脏字符（那两条规矩是对的，
//   抓的是"生成环节漏了转义"的 bug），所以这里用 trim() 代替正则，绕开它。
// 【截止时间是"按你打开这一页的当天"现算的】不是打包那天算死的 ——
//   静态网页不会因为日子过去就失效，页面上的方块也不会自己消失。
const FILTER_JS = `
(function(){
  var grid=document.getElementById("grid");
  if(!grid)return;
  var tiles=grid.querySelectorAll(".tile");
  if(!tiles.length)return;
  var q=document.getElementById("fq");
  var cnt=document.getElementById("fcount");
  var empty=document.getElementById("fempty");
  var clr=document.getElementById("fclear");
  var clr2=document.getElementById("fclear2");
  var chips=document.querySelectorAll(".chip");
  function picked(kind){
    var out=[],on=document.querySelectorAll(".chip.on");
    for(var i=0;i<on.length;i++){
      if(on[i].getAttribute("data-kind")===kind)out.push(on[i].getAttribute("data-val"));
    }
    return out;
  }
  function has(list,v){
    for(var i=0;i<list.length;i++){if(list[i]===v)return true}
    return false;
  }
  function dirHit(tg,ds){
    for(var j=0;j<ds.length;j++){
      if(ds[j]==="__none__"){if(tg==="")return true}
      else if(tg.indexOf(ds[j])!==-1)return true;
    }
    return false;
  }
  function regionHit(rv,rs){
    for(var j=0;j<rs.length;j++){
      if(rs[j]==="__none__"){if(rv==="")return true}
      else if(rv===rs[j])return true;
    }
    return false;
  }
  function daysLeft(day){
    if(!day)return null;
    var t=Date.parse(day+"T23:59:59");
    if(isNaN(t))return null;
    return Math.ceil((t-Date.now())/86400000);
  }
  function slotOf(day){
    var d=daysLeft(day);
    if(d===null)return "x";
    if(d<0)return "past";
    if(d<=7)return "d7";
    if(d<=30)return "d30";
    return "d30p";
  }
  function apply(){
    var kw=(q&&q.value?q.value:"").trim().toLowerCase();
    var ds=picked("dir"),rs=picked("region"),ps=picked("prize"),ts=picked("dl"),shown=0;
    for(var i=0;i<tiles.length;i++){
      var el=tiles[i],ok=true;
      if(ok&&kw&&(el.getAttribute("data-key")||"").indexOf(kw)===-1)ok=false;
      if(ok&&ds.length&&!dirHit(el.getAttribute("data-tags")||"",ds))ok=false;
      if(ok&&rs.length&&!regionHit(el.getAttribute("data-region")||"",rs))ok=false;
      if(ok&&ps.length&&!has(ps,el.getAttribute("data-prize")||""))ok=false;
      if(ok&&ts.length&&!has(ts,slotOf(el.getAttribute("data-deadline")||"")))ok=false;
      if(ok){el.classList.remove("is-off");shown++}
      else{el.classList.add("is-off")}
    }
    if(cnt)cnt.textContent="显示 "+shown+" / "+tiles.length+" 场";
    if(empty){
      if(shown===0)empty.classList.add("show");
      else empty.classList.remove("show");
    }
  }
  function clearAll(){
    if(q)q.value="";
    for(var i=0;i<chips.length;i++)chips[i].classList.remove("on");
    apply();
  }
  if(q)q.addEventListener("input",apply);
  if(clr)clr.addEventListener("click",clearAll);
  if(clr2)clr2.addEventListener("click",clearAll);
  for(var i=0;i<chips.length;i++){
    (function(el){
      el.addEventListener("click",function(){
        el.classList.toggle("on");
        apply();
      });
    })(chips[i]);
  }
  apply();
})();
`;

// ---------- 右下角"意见信箱"（2026-09-17 新增，用户要求） ----------
//
// 【用户要的】"右下角放一个信箱，可以写意见给我，提交之后发给我或者存起来等我看。"
//
// 【为什么做成"一条链"而不是只做一种】
//   网站有两个完全不同的运行环境，收件能力不一样：
//     · 本机（双击 启动网站.bat，端口 8000）—— 这台服务器是【我们自己写的程序】，
//       我可以给它加一个收件口，意见直接写进 data\feedback.jsonl，双击 看意见.bat 就能看；
//     · 传上服务器之后（纯静态，nginx 只发文件）—— 【没有后台程序】，网页自己
//       一个字节都存不下来。这时候只能退到"打开观众自己的邮件客户端"。
//   所以点"提交"的流程是：先试收件口 → 成了就存下来；没成就自动打开邮件。
//   ★ 两条路都不能省：只做存储，上线后观众点了没反应；只做邮件，
//     本机自己收意见时还要多跳一次邮箱（而且国内很多手机没配邮件 App，根本发不出去）。
//
// 【★ 一个必须说清楚的诚实问题】"打开邮件客户端"这条路，在没配邮箱的手机上
//   是**不会成功**的（点了什么都不发生）。所以面板里另外给了一个"复制内容"按钮 ——
//   复制出来粘到微信里发给站长也行。这个按钮不是装饰，是"邮件路走不通时"的退路。
//
// 【为什么收件邮箱在网页里是拆成两段写的】
//   地址公开在网页上就一定会被采集爬虫抓去发垃圾邮件。拆成 "用户名" + "@" + "域名"
//   两段、在浏览器里再拼起来，只认整串的那种爬虫就抓不到（挡不住铁了心的人，如实说）。
//   deploy\preflight.js 里有一条检查专门盯着"完整地址别出现在页面上"。
//
// 【这段脚本的硬规矩（和筛选脚本一样）】
//   一个反斜杠都不能有、也不能出现 class="tile" 这几个字、不能出现字面的 undefined
//   —— 首页的脏字符检查会把这三样都判成"生成环节出 bug"。
//   所以：换行用 String.fromCharCode(10)；去空格用 trim() 而不是正则。
function mailboxJs(addrJs) {
  return `
(function(){
  var root=document.getElementById("mbox");
  if(!root)return;
  var btn=document.getElementById("mboxBtn");
  var panel=document.getElementById("mboxPanel");
  var ta=document.getElementById("mboxText");
  var who=document.getElementById("mboxWho");
  var send=document.getElementById("mboxSend");
  var shut=document.getElementById("mboxShut");
  var copyBtn=document.getElementById("mboxCopy");
  var mailBtn=document.getElementById("mboxMail");
  var msg=document.getElementById("mboxMsg");
  var ADDR=${addrJs};
  var NL=String.fromCharCode(10);
  function say(t,kind){
    msg.textContent=t;
    msg.className=kind?("mbox-msg "+kind):"mbox-msg";
  }
  function isOpen(){return panel.className.indexOf("is-open")!==-1}
  function show(){
    panel.className="mbox-panel is-open";
    btn.setAttribute("aria-expanded","true");
    if(ta)ta.focus();
  }
  function hide(){
    panel.className="mbox-panel";
    btn.setAttribute("aria-expanded","false");
  }
  function text(){
    var v=ta&&ta.value?ta.value:"";
    return v?v.trim():"";
  }
  function contact(){
    var v=who&&who.value?who.value:"";
    return v?v.trim():"";
  }
  function mailBody(){
    var s="【AI赛事备忘录 · 意见】"+NL+NL+text()+NL+NL;
    var w=contact();
    if(w)s=s+"联系方式："+w+NL;
    s=s+"来自页面："+location.pathname+NL;
    return s;
  }
  function mailUrl(){
    return "mailto:"+ADDR+"?subject="+encodeURIComponent("AI赛事备忘录的意见")+
      "&body="+encodeURIComponent(mailBody());
  }
  function sendMail(){
    if(!ADDR)return;
    location.href=mailUrl();
  }
  function copyText(){
    var done=false;
    try{
      if(ta){ta.focus();ta.select();done=document.execCommand("copy")}
    }catch(e){done=false}
    if(done)say("已经复制好了，你可以粘到微信或者邮件里发给我。","good");
    else say("没复制成功，请手动选中上面的文字复制。","");
  }
  function submit(){
    if(text().length<2){
      say("请先写几个字再提交。","bad");
      if(ta)ta.focus();
      return;
    }
    say("正在提交…","");
    var payload={
      text:text(),
      contact:contact(),
      page:location.pathname,
      viewport:window.innerWidth+"x"+window.innerHeight,
      at:new Date().toISOString()
    };
    fetch("/api/feedback",{
      method:"POST",
      headers:{"Content-Type":"application/json"},
      body:JSON.stringify(payload)
    }).then(function(r){
      if(!r.ok)throw new Error("HTTP "+r.status);
      return r.json();
    }).then(function(j){
      if(!j||j.ok!==true)throw new Error("bad response");
      say("已经收到了，谢谢你！","good");
      ta.value="";
    }).catch(function(){
      if(ADDR){
        say("这台机器收不了意见（网页是静态的，没有后台程序），已经帮你打开邮件，请点一下【发送】。","warn");
        sendMail();
      }else{
        say("这台机器收不了意见。可以点【复制内容】，把写的东西粘到微信里发给站长。","warn");
      }
    });
  }
  btn.addEventListener("click",function(){ if(isOpen())hide(); else show(); });
  if(shut)shut.addEventListener("click",hide);
  if(send)send.addEventListener("click",submit);
  if(copyBtn)copyBtn.addEventListener("click",copyText);
  if(mailBtn&&ADDR)mailBtn.addEventListener("click",function(){ sendMail(); });
  document.addEventListener("keydown",function(ev){ if(ev.key==="Escape"&&isOpen())hide(); });
})();
`;
}

// 把 site-config.js 里的收件邮箱拆成"用户名 / 域名"两段（理由见上面那段注释）。
// 返回 null = 没填、或者看着不像一个邮箱 —— 那时候信箱就只剩"存到本机"一条路，
// 页面里也不会出现一个点了没反应的"用邮件发"按钮（宁可不给，也不给一个死按钮）。
function feedbackParts() {
  const email = readSiteConfig().feedbackEmail || '';
  const at = email.indexOf('@');
  if (at <= 0 || at >= email.length - 1) return null;
  return { user: email.slice(0, at), domain: email.slice(at + 1) };
}

// 生成右下角那个信箱的 HTML。
function renderMailbox() {
  const parts = feedbackParts();

  return '<div class="mbox" id="mbox">' +
    '<button class="mbox-btn" id="mboxBtn" type="button" aria-expanded="false" aria-controls="mboxPanel">' +
      '<span class="mbox-ico" aria-hidden="true">✉</span><span>意见信箱</span>' +
    '</button>' +
    '<div class="mbox-panel" id="mboxPanel" role="dialog" aria-label="意见信箱">' +
      '<div class="mbox-hd"><span>给我留个意见</span>' +
        '<button class="mbox-x" id="mboxShut" type="button" aria-label="收起信箱">✕</button></div>' +
      '<div class="mbox-sub">发现哪场比赛的信息不对、或者想让我加点什么，写在这里就行。' +
        (parts ? '提交后也可以直接用邮件发给我。' : '') + '</div>' +
      '<textarea class="mbox-ta" id="mboxText" rows="5" ' +
        'placeholder="随便写，比如：某某比赛的奖金写错了…"></textarea>' +
      '<input class="mbox-in" id="mboxWho" type="text" maxlength="60" ' +
        'placeholder="怎么联系你？（可留空，比如微信号）">' +
      '<div class="mbox-row">' +
        '<button class="mbox-send" id="mboxSend" type="button">提交</button>' +
        '<button class="mbox-copy" id="mboxCopy" type="button">复制内容</button>' +
        (parts ? '<button class="mbox-link" id="mboxMail" type="button">用邮件发</button>' : '') +
      '</div>' +
      '<div class="mbox-msg" id="mboxMsg"></div>' +
    '</div>' +
  '</div>';
}

// ---------- 顶部那条"最近一次采集没成功"的提示 ----------
//
// 【为什么必须有这条】采集失败时，collect.js 会【故意不覆盖】已有的好数据和
// 好网页（见那里的"闸二"）。也就是说：页面上看到的其实还是上一次的数据。
// 不把这件事写在最显眼的地方，读者就会把旧数据当成今天的新数据 —— 那是假话。
// 记录本身写在 data\last-collect.json 里，读不出来时这里什么都不显示，
// 绝不因为这份记录影响网站能不能打开。
function renderCollectNotice(status) {
  if (!status) return '';
  if (status.status !== 'no_data' && status.status !== 'partial') return '';

  const failed = status.failed_sources || [];
  const failedList = failed.length
    ? '<ul>' + failed.map(s =>
        '<li>' + esc(s.source_name) + '：' + esc(s.error || '失败') + '</li>').join('') + '</ul>'
    : '';
  const atLine = status.at ? '（' + esc(fmtTime(status.at)) + '）' : '';

  if (status.status === 'partial') {
    // 半失败：有的源是新的，有的源还是上次的
    const kept = status.retained_sources || [];
    const keptLine = kept.length
      ? '<p>这些数据源这次没采到，页面上仍然显示上一次采到的 ' +
        esc(kept.map(k => k.source_name + '（' + k.count + ' 条）').join('、')) +
        '，卡片上也标明了"这条是上次的数据"。</p>'
      : '';
    return '<div class="notice bad2">' +
      '<b>最近一次采集' + atLine + '有数据源没成功</b>' +
      failedList + keptLine +
      (status.note ? '<p>' + esc(status.note) + '</p>' : '') +
      '<p>其它数据源的内容是这次新采的；失败的数据源会等下一次采集再试。</p>' +
      '</div>';
  }

  // no_data：一条都没采到（或者为了安全没保存），页面整体仍是上一次的数据
  const keptAt = status.keep_generated_at ? fmtTime(status.keep_generated_at) : null;
  return '<div class="notice bad2">' +
    '<b>最近一次采集' + atLine + '没有采到新数据</b>' +
    failedList +
    (keptAt
      ? '<p>为了不把已经采到的好数据弄坏，程序这次<b style="display:inline">没有覆盖</b>原数据：' +
        '以下内容仍是上一次采集的数据（采集于 ' + esc(keptAt) + '），一条都没丢。</p>'
      : '<p>本机还没有历史数据可以显示。</p>') +
    (status.note ? '<p>' + esc(status.note) + '</p>' : '') +
    '<p>常见原因：电脑当时连不上网，或者官网改版了。可以过一会儿再双击一次 ' +
    '<code>更新数据.bat</code> 重新采集。</p>' +
    '</div>';
}

// ---------- 整页 ----------

// 网站的名字。全站只在这里写一次，别的地方引用它，避免改名字时漏改某一处。
// 2026-09-10 由「AI 竞赛信息站」改为「AI赛事备忘录」：
//   旧名字里的「信息」和「站」属于个人备案的不宜使用词汇，改名是为了好过备案。
const SITE_NAME = 'AI赛事备忘录';

function renderPage() {
  const data = readData();

  // 备案号（还没下来时这里是空字符串，页面上不会多出任何字）
  const footer = renderFooter();

  if (data.missing || data.error) {
    return '<!DOCTYPE html><html lang="zh-CN"><head><meta charset="utf-8"><title>' + SITE_NAME + '</title>' +
      '<style>body{font-family:system-ui,"Microsoft YaHei",sans-serif;max-width:760px;margin:80px auto;padding:0 20px;line-height:1.8}' +
      'code{background:var(--c-bg-soft);padding:2px 8px;border-radius:4px}</style></head><body>' +
      '<h1>还没有数据</h1>' +
      '<p>' + esc(data.error || '数据文件不存在。') + '</p>' +
      '<p>解决办法：在 <code>ai-competition-hub</code> 文件夹里双击 <code>启动网站.bat</code>，它会先采集一次数据再打开网站。</p>' +
      '</body></html>';
  }

  const comps = data.competitions || [];
  const sources = data.source_results || [];
  const collectStatus = readStatus();

  // 意见信箱"用邮件发"那条路要用的收件地址：在页面里拆成两段再拼起来写（理由见
  // mailboxJs 上面那段注释）。没配邮箱时就是空串，信箱脚本里那条退路会自己关掉。
  const mbParts = feedbackParts();
  const mbAddrJs = mbParts
    ? '"' + esc(mbParts.user) + '" + "@" + "' + esc(mbParts.domain) + '"'
    : '""';

  const sourceLine = sources.map(s => {
    if (s.status === 'ok') return '<span class="ok">✔ ' + esc(s.source_name) + '：' + s.count + ' 条</span>';
    return '<span class="bad">✘ ' + esc(s.source_name) + '：失败（' + esc(s.error) + '）</span>';
  }).join('  ');

  // 【改版第 1 条】网页上只显示"正在报名"的；已截止的不显示，但数据照常采集留档（D23）。
  // 【改版第 10 条】按报名截止时间从近到远排 —— 快截止的排最前（本站是"备忘录"，
  //   职责是提醒"别忘了，这个快到期了"）；同一天截止的保持采集顺序（JS 的 sort 是稳定的）。
  const open = comps
    .filter(c => c.register_state === 'open')
    .slice()
    .sort((a, b) =>
      new Date(a.register_end || '9999-12-31T23:59:59Z') - new Date(b.register_end || '9999-12-31T23:59:59Z'));

  const tiles = open.map(renderTile).join('');

  // ---------- 搜索与筛选工具条的内容（2026-09-16 新增，用户要求） ----------
  // 方向按钮只列【出现 2 次以上】的：16 个方向里有 7 个只出现 1 次，
  //   全列出来会把工具条撑成一大片；长尾方向用搜索框一样搜得到（搜的是同一个 tag 字段）。
  //   ★ 这不是"藏数据"：20 个方块一个不少地都在页面上，只是少给几个筛选按钮。
  //   ★ "未标注"那一档只有确实存在没打标签的比赛时才出现，数字也是现数的。
  const dirCount = {};
  for (const c of open) for (const d of directionList(c)) dirCount[d] = (dirCount[d] || 0) + 1;
  const noTagCount = open.filter(c => directionList(c).length === 0).length;
  const dirChips = Object.keys(dirCount)
    .filter(d => dirCount[d] >= 2)
    .sort((a, b) => dirCount[b] - dirCount[a])
    .map(d => chip('dir', d, d + ' ' + dirCount[d]))
    .join('') + (noTagCount ? chip('dir', '__none__', '未标注 ' + noTagCount) : '');

  // 地区按钮列出当前正在报名的比赛里官网原文实际出现的地区；
  // 另列"官网未公布"，让用户能找到没有这项信息的比赛，不把空值藏起来。
  const regionCount = {};
  for (const c of open) {
    const r = c.region || '__none__';
    regionCount[r] = (regionCount[r] || 0) + 1;
  }
  const regionChips = Object.keys(regionCount)
    .sort((a, b) => regionCount[b] - regionCount[a] || a.localeCompare(b))
    .map(r => chip('region', r, (r === '__none__' ? '官网未公布' : r) + ' ' + regionCount[r]))
    .join('');

  // 奖金按钮：六档与 PRIZE_TIERS 一一对应，外加"外币""未公布"两档 ——
  //   后两档不是金额区间，含义见 prizeCell：外币【绝不换算】、空值【绝不当 0】。
  const PRIZE_LABEL = {
    'pz-1': '20 万及以上', 'pz-2': '10~20 万', 'pz-3': '5~10 万',
    'pz-4': '5 万以下', 'pz-other': '外币（不换算）', 'pz-none': '未公布',
  };
  const prizeCount = {};
  for (const c of open) { const k = prizeCell(c).cls; prizeCount[k] = (prizeCount[k] || 0) + 1; }
  const prizeChips = Object.keys(PRIZE_LABEL)
    .filter(k => prizeCount[k])
    .map(k => chip('prize', k, PRIZE_LABEL[k] + ' ' + prizeCount[k]))
    .join('');

  const dlChips = chip('dl', 'd7', '7 天内') + chip('dl', 'd30', '8~30 天') + chip('dl', 'd30p', '30 天以上');

  const toolbar = '<div class="fbar">' +
    '<div class="frow">' +
      '<input id="fq" class="fq" type="search" autocomplete="off" placeholder="搜比赛名或分类，例如：视觉、大模型、机器人">' +
      '<button id="fclear" class="fclear" type="button">清空条件</button>' +
    '</div>' +
    '<div class="frow"><span class="flab">方向</span>' + dirChips + '</div>' +
    '<div class="frow"><span class="flab">地区</span>' + regionChips + '</div>' +
    '<div class="frow"><span class="flab">奖金</span>' + prizeChips + '</div>' +
    '<div class="frow"><span class="flab">截止</span>' + dlChips + '</div>' +
    '<div class="frow"><span class="flab"></span><span id="fcount" class="fcount">显示 ' +
      open.length + ' / ' + open.length + ' 场</span>' +
      '<span class="fhint">· 地区按官网原文识别，官网未公布也可筛选 · 截止时间按你打开这一页的当天算</span></div>' +
  '</div>';

  // 筛不出东西时说的话。给一个按钮，别让人卡在空页面上。
  const emptyBox = '<div class="fempty" id="fempty">' +
    '<b>没有符合条件的比赛</b>试试少选几个条件，或者把搜索词改短一点。' +
    '<div style="margin-top:12px"><button id="fclear2" class="fclear" type="button">清空全部条件</button></div>' +
  '</div>';

  // 【2026-09-17 删掉的一句】原来这里有一行小字，写的是
  //   "这行说的是【采集成功了多少】，不是【网站陈列了几场】…照常采集留档，只是不在页面上列出。"
  //   加它的理由是 D14（页面上的话必须和事实一致）：数据源状态行会写"开悟 ✔ 4 条"，
  //   而开悟的比赛全是已结束、方块墙上一场也没有，怕人犯嘀咕。
  //   ★ 2026-09-17 用户看过之后要求删掉，原话："感觉多余了，别人也不会深究什么的"。
  //   这一行是【用户拍板删掉】的，以后不要"好心"再加回来；
  //   状态行本身（数据源：…）保留不动。

  return '<!DOCTYPE html><html lang="zh-CN"><head><meta charset="utf-8">' +
    '<meta name="viewport" content="width=device-width,initial-scale=1">' +
    '<title>' + SITE_NAME + '</title>' +
    // 门面（摘要/小图标/分享卡片）：分享出去和搜索结果里"像一个正经网站"
    headMeta({ title: SITE_NAME, description: homeDescription(sources), path: '/' }) +
    '<style>' + CSS + MAILBOX_CSS + '</style></head><body>' + BG_LAYER + '<div class="wrap">' +
    '<header>' + hudBar() + '<h1>' + SITE_NAME + '</h1>' +
      '<div class="meta">' +
        '<div>数据采集时间：' + esc(fmtTime(data.generated_at)) + '</div>' +
        '<div>数据源：' + sourceLine + '</div>' +
      '</div></header>' +
    renderCollectNotice(collectStatus) +
    // 【改版第 7 条】顶部只留一个大数字"正在报名 18"：
    //   "赛道总数"剔完已截止的比赛后会变成 0；"收录竞赛 25"和实际显示的 18 对不上，
    //   都会让人误读（D14），所以那两个格子删掉。
    '<div class="stat">' +
      '<div><b>' + open.length + '</b><span>正在报名</span></div>' +
    '</div>' +
    // 【改版第 6 条】原来的 renderOpenNotice（把比赛名全列一遍的栏目）已删，
    //   方块墙本身就是那 18 场。一场都没在报名时，老实说一句，不留白屏。
    // 搜索/筛选工具条 + 方块墙（工具条 2026-09-16 新增，用户要求）。
    // 【为什么工具条只在这里出现】一场都没在报名时没有可筛的东西，
    //   多摆一个工具条只会让人以为网站坏了。
    (tiles
      ? toolbar + '<div class="grid" id="grid">' + tiles + '</div>' + emptyBox
      : '<div class="notice"><b>暂时没有正在报名的竞赛</b>' +
        '<p>新一届开赛前，官网通常会在赛前一两个月才挂出报名信息；' +
        '已截止的比赛数据仍会采集留档，只是不在这里列出。</p>' +
        '<p>可以过几天再双击一次 <code>更新数据.bat</code> 重新采集。</p></div>') +
    '<footer>数据均来自各竞赛官网公开页面，仅供信息参考；报名请以官网为准。' +
      footer.html +
    '</footer>' +
    // 右下角"意见信箱"（2026-09-17 新增）：钉在视口右下角的浮层，不占方块墙的排版。
    renderMailbox() +
    // 筛选脚本放在最后：它要找的方块和按钮都已经在上面了。
    (tiles ? '<script>' + FILTER_JS + '</script>' : '') +
    // ★ 信箱脚本必须排在筛选脚本【后面】，不能排在前面：
    //   deploy\preflight.js 只把页面里【第一个】<script> 当成"筛选脚本"来检查
    //   （要求它在方块墙之后、且一个反斜杠都没有）。信箱脚本要是排在前面，
    //   那条检查就会变成在检查信箱，筛选脚本反而没人管了。
    '<script>' + mailboxJs(mbAddrJs) + '</script>' +
    '</div></body></html>';
}

module.exports = { renderPage, renderDetailPage, detailFileName, readData, DATA_FILE, PUBLIC_DIR, PAGE_FILE, DETAIL_DIR, SITE_NAME, readSiteConfig, renderFooter, renderRobots, renderSitemap };
