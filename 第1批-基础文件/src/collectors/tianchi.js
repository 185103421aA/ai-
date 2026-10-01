// ============================================================
// 数据源积木块 3：阿里天池（tianchi.aliyun.com）
//
// 这块积木和前面两块"长相一样"，也吐"同一种格式"的数据，
// 所以网站那部分代码一行都不用改，它自动就能显示这个新数据源。
//
// 【这块积木取哪一部分数据，为什么不取全部】
//   天池平台上一共 598 场赛事，绝大多数是几年前就结束的老比赛，对人没有用。
//   所以这里只取【还在进行中】的那一批（接口参数 isActive=1，实测约 30 多场），
//   再把其中"还能报名"的挑出来做主力 —— 这正是访问者最想看到的东西。
//   ★ 宁可只显示几十场有用的，也不要堆一屏没用的，这是给外人看的网站。
//
// 【刻意不采集的东西】
//   天池也有排行榜、队伍名单、提交记录这类接口
//   （例如 /v3/proxy/competition/api/race/rank/list、race/team/page）。
//   它们虽然是公开的，但里面有参赛队伍名和选手成绩，属于参赛者信息，
//   所以这块积木【不去读它们】—— 和广告算法大赛那块积木守的是同一条规矩。
//
// 【取数方式（2026-09-11 全部实测过）】
//   列表接口：/v3/proxy/competition/api/race/page?pageNum=1&pageSize=50&isActive=1
//   详情接口：/v3/proxy/competition/api/race/getDetail?raceId=XXXXX
//   两个都是匿名可访问（不用登录、不用 cookie），robots.txt 只禁了 /search 一个路径。
//   ★ 注意：isActive 的值必须是字符串 '1'，写成 'true' 接口会报参数类型错误。
// ============================================================

const LIST_API = 'https://tianchi.aliyun.com/v3/proxy/competition/api/race/page';
const DETAIL_API = 'https://tianchi.aliyun.com/v3/proxy/competition/api/race/getDetail';
const SITE = 'https://tianchi.aliyun.com/competition/';

const HEADERS = {
  'accept': 'application/json, text/plain, */*',
  'accept-language': 'zh-CN,zh;q=0.9',
  'referer': 'https://tianchi.aliyun.com/competition/',
  'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36',
};

// 每次请求之间歇一下，避免给人家网站添麻烦（和现有两块积木一致）
const DELAY_BETWEEN_REQUESTS_MS = 1200;
// 一次采集最多取几场赛事的详情页。天池"进行中"的赛事通常 30 场出头，
// 每场一次请求、每次之间歇 1.2 秒，整块积木大约 40 秒左右跑完。
const MAX_DETAIL_FETCH = 40;
const PAGE_SIZE = 50;

// 接口里的"报名状态编号"→ 我们网页的写法。
// 这份对照表是从天池前端源码里挖出来的，不是猜的：
//   0=立即报名 1=已报名去参赛 2=报名已结束 3=未开始 4=已结束
// 其中 1 表示"这个人已经报过名了"——那是登录以后才有的事，
// 我们是匿名采集，拿不到、也不该猜，所以按"没有权威依据"处理（见下面 computeState）。
const STATUS_MAP = { 0: 'open', 2: 'closed', 3: 'not_started', 4: 'closed' };

const STATE_TEXT = {
  open: '正在报名',
  closed: '报名已截止',
  not_started: '报名尚未开始',
  unknown: '官网未公布',
};

// 币种编号的含义（同样取自天池前端源码：0=¥ 1=$ 2=€ 3=HK$）
const CURRENCY_SYMBOL = { 0: '¥', 1: '$', 2: '€', 3: 'HK$' };

// 详情页正文里最多截取多少字（详情原文动辄几千字，全搬进网页会让页面变得很重，
// 截断时会在卡片上如实写明"这里显示的是前 N 字，完整内容请去官网看"）
const MAX_INFO_CHARS = 2600;
const MAX_INTRO_CHARS = 1200;
const MAX_NOTE_CHARS = 220;

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

// 接口偶尔会抽风，重试一次再放弃（不重试太多，避免给人家添麻烦）
async function getJson(url, what) {
  let lastErr;
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      const res = await fetch(url, { headers: HEADERS });
      if (!res.ok) throw new Error('HTTP ' + res.status);
      const text = await res.text();
      let json;
      try {
        json = JSON.parse(text);
      } catch (e) {
        throw new Error('返回的不是合法数据（' + e.message + '）');
      }
      return json;
    } catch (e) {
      lastErr = e;
      if (attempt === 1) await sleep(800);
    }
  }
  throw new Error(what + '取不到：' + (lastErr && lastErr.message ? lastErr.message : lastErr));
}

// ---------- 小工具 ----------

// 清掉字符串里的零宽字符和多余空格。
// ★ 为什么必须清：天池的标签名里混着零宽空格（肉眼看不见），
//   不清掉的话网页上会出现"计算机视觉　"这种莫名其妙的空白。
function cleanStr(v) {
  if (typeof v !== 'string') return null;
  const t = v.replace(/[\u200b-\u200d\ufeff\u00a0]/g, ' ').replace(/\s+/g, ' ').trim();
  return t.length ? t : null;
}

// 天池给的时间都是"本地时间"、不带时区标记，例如 2026-08-30 00:00:00
// （中国时区 = UTC+8）。这里明确按 +08:00 解析成标准时间，
// 避免服务器搬到别的时区以后算错报名截止时间。
function parseCnTime(s) {
  const t = cleanStr(s);
  if (!t) return null;
  const m = t.match(/^(\d{4})-(\d{1,2})-(\d{1,2})(?:[ T](\d{1,2}):(\d{2})(?::(\d{2}))?)?/);
  if (!m) return null;
  const iso = m[1] + '-' + String(m[2]).padStart(2, '0') + '-' + String(m[3]).padStart(2, '0') + 'T' +
              String(m[4] || '00').padStart(2, '0') + ':' + (m[5] || '00') + ':' + (m[6] || '00') + '+08:00';
  const d = new Date(iso);
  return isNaN(d.getTime()) ? null : d.toISOString();
}

// 详情页正文是"半成品网页标记"，里面还夹着 markdown 的 ** 加粗符号和 <img>。
// 卡片只需要文字，所以这里统一收拾干净，绝不把标记原样吐给读者。
function cleanRichText(s) {
  if (typeof s !== 'string') return '';
  let t = s.replace(/&nbsp;/gi, ' ').replace(/&lt;/gi, '<').replace(/&gt;/gi, '>')
           .replace(/&quot;/gi, '"').replace(/&#39;/g, "'").replace(/&amp;/gi, '&');
  t = t.replace(/<br\s*\/?>/gi, '\n').replace(/<\/p\s*>/gi, '\n').replace(/<\/div\s*>/gi, '\n');
  t = t.replace(/<[^>]*>/g, '');          // 去掉剩下的所有标记（含 <img>）
  t = t.replace(/\*\*/g, '');             // 去掉 markdown 加粗符号，只留字
  t = t.replace(/^\s*#{1,6}\s*/gm, '');   // 去掉行首的 markdown 标题符号
  t = t.replace(/^\s*[|:\-\s]{6,}\s*$/gm, ''); // 去掉 markdown 表格的横线分隔行（只剩符号、没有内容的行）
  t = t.replace(/^\s*```.*$/gm, '');      // 去掉代码块的 ``` 围栏（内容本身照留）
  t = t.split('\n').map(x => x.replace(/[ \t]+/g, ' ').trim()).join('\n');
  t = t.replace(/\n{3,}/g, '\n\n').trim();
  return t;
}

function clamp(text, max) {
  if (!text) return { text: '', truncated: false, fullLength: 0 };
  const fullLength = text.length;
  if (fullLength <= max) return { text: text, truncated: false, fullLength: fullLength };
  return { text: text.slice(0, max), truncated: true, fullLength: fullLength };
}

// 金额显示成 "¥50,000"。digit 是接口给的原始数字。
// 返回 null 表示【官网没有公布金额】——绝不写"0 元"冒充。
function formatBonus(bonus, currency) {
  if (typeof bonus !== 'number' || !isFinite(bonus) || bonus <= 0) return null;
  const symbol = CURRENCY_SYMBOL[currency] || '';
  const text = String(Math.round(bonus)).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return symbol ? symbol + text : text + '（币种官网未标明）';
}

// 判断"还能不能报名"。
// 规矩和别的积木一致：先听官网自己说的；官网没说的，才按报名起止日期推算；
// 两个都没有，就如实写"官网未公布"，绝不猜。
function computeState(listStatus, signupStartIso, signupEndIso, now) {
  const mapped = STATUS_MAP[listStatus];
  if (mapped) {
    const closedText = (listStatus === 4) ? '报名已截止（赛事已结束）' : STATE_TEXT[mapped];
    return { key: mapped, text: closedText };
  }

  // 走到这里说明官网没给可用的状态编号（实测 50 条里有 14 条是这种情况）。
  // 这时只能按日期推算，并且如实说明"这是按日期推的"。
  if (signupStartIso || signupEndIso) {
    const start = signupStartIso ? new Date(signupStartIso) : null;
    const end = signupEndIso ? new Date(signupEndIso) : null;
    if (start && now < start) return { key: 'not_started', text: '报名尚未开始（按官网公布的报名起始日期推算）' };
    if (end && now > end) return { key: 'closed', text: '报名已截止（按官网公布的报名截止日期推算）' };
    if (start && now >= start) return { key: 'open', text: '正在报名（按官网公布的报名起止日期推算）' };
    return { key: 'unknown', text: '官网未公布报名时间' };
  }
  return { key: 'unknown', text: '官网未公布报名状态与报名时间' };
}

// 把详情接口返回的 raw.data 拼成卡片上的"详细规则与说明"
function buildSections(raw, log) {
  const race = (raw.data && raw.data.race) || {};
  const sections = [];

  const info = clamp(cleanRichText(race.information), MAX_INFO_CHARS);
  if (info.text) {
    sections.push({
      section_type: 'rule',
      code: 'information',
      title: '赛题说明与规则',
      content: info.text + (info.truncated
        ? '\n\n（官网原文较长，这里显示前 ' + MAX_INFO_CHARS + ' 字，共 ' + info.fullLength + ' 字；完整内容请看官网赛事页。）'
        : ''),
      sort: 0,
    });
  }

  const intro = clamp(cleanRichText(race.introduction), MAX_INTRO_CHARS);
  if (intro.text) {
    sections.push({
      section_type: 'intro',
      code: 'introduction',
      title: '赛事介绍',
      content: intro.text + (intro.truncated
        ? '\n\n（官网原文较长，这里显示前 ' + MAX_INTRO_CHARS + ' 字，共 ' + intro.fullLength + ' 字；完整内容请看官网赛事页。）'
        : ''),
      sort: 1,
    });
  }

  // 赛程分段（初赛/复赛/A榜/B榜…）——如实照搬官网给的名称。
  // ★ 这里【不显示各段的报名起止时间】：实测有赛事的赛季字段和列表里的报名时间对不上，
  //   与其把两个可能打架的时间都摆出来让读者困惑，不如只写阶段名称、完整时间引导去官网看。
  const seasons = (raw.data && Array.isArray(raw.data.raceSeasons)) ? raw.data.raceSeasons : [];
  const names = seasons.map(s => cleanStr(s && s.seasonName)).filter(Boolean);
  if (names.length) {
    sections.push({
      section_type: 'schedule',
      code: 'seasons',
      title: '赛程阶段',
      content: '官网把这场赛事分成 ' + names.length + ' 个阶段：' + names.join('、') +
               '。（各阶段的具体时间以官网赛事页为准。）',
      sort: 2,
    });
  }

  if (!sections.length) log('        （这场赛事官网没提供正文说明，卡片上会如实写明"请看官网"）');
  return sections;
}

// 数字是否像个正常的赛事编号（天池真实赛事的 raceId 是六位数，
// 而 34/35/41 这种两位数编号是"系列赛"的外壳，详情接口打不开）
function looksLikeRealRaceId(id) {
  return typeof id === 'number' && isFinite(id) && String(id).length >= 5;
}

module.exports = {
  sourceId: 'tianchi',
  sourceName: '阿里天池',

  async collect({ log }) {
    const now = new Date();
    log('  正在读取赛事列表（只取平台标注为"进行中"的）...');

    const url = LIST_API + '?pageNum=1&pageSize=' + PAGE_SIZE + '&isActive=1';
    const listed = await getJson(url, '天池赛事列表');
    if (!listed || listed.success !== true || !listed.data || !Array.isArray(listed.data.list)) {
      throw new Error('天池列表接口返回的内容看不懂：code=' + (listed && listed.code));
    }

    const totalActive = listed.data.total;
    // ★ 只留"确实在进行中"的：
    //   - isSeries=1 的是"系列赛外壳"（如"2026CCKS系列赛"），它自己没有完整的赛事资料，
    //     详情接口实测打不开、报名时间也没有 —— 与其显示一张空卡片，不如不显示。
    //     （这条是实测发现的，不是猜的）
    //
    // ★★ 2026-09-15 用户拍板（D19 改写，见交接单第九版）：
    //     【删掉】原来那条"visualTab 不是 1 就把打榜赛/教学赛一律略过"的规则。
    //     新规矩：只收平台标注"进行中"的，且只要还在报名期内就收进来，
    //             【不另设打榜赛/教学赛的排除规则】。
    //     改的理由（2026-09-12 实测诊断）：那条规则本来就没能稳定拦住打榜赛 ——
    //     名字带【打榜赛】的 532338（截至 2027-05-24）因为 visualTab=1，一直在收。
    //     删掉后多收 3 条在报名期内的（首页 18 场变 21 场）。用户原话："只要是在报名期间内的都抓进去。"
    const skippedSeries = [];
    const candidates = listed.data.list.filter(x => {
      if (x.isSeries === 1 || x.isSeries === true) { skippedSeries.push(cleanStr(x.name) || x.raceId); return false; }
      return true;
    });

    log('  → 平台标注"进行中"的共 ' + totalActive + ' 场，其中 ' + candidates.length + ' 场要收进本站');
    if (skippedSeries.length) log('  → 略过系列赛外壳 ' + skippedSeries.length + ' 个（它们自己不含赛事资料）');
    log('  → 打榜赛/教学赛按用户 2026-09-15 的决定【一并收进来】（只要还在报名期内）');

    // 还能报名的排在最前面 —— 访问者最想看的就是这些
    candidates.sort((a, b) => (a.raceListStatus === 0 ? 0 : 1) - (b.raceListStatus === 0 ? 0 : 1));

    const items = [];
    let detailOk = 0, detailFail = 0;
    const fetchCount = Math.min(candidates.length, MAX_DETAIL_FETCH);
    if (candidates.length > MAX_DETAIL_FETCH) {
      log('  ⚠ 进行中的赛事超过 ' + MAX_DETAIL_FETCH + ' 场，本次只取前 ' + MAX_DETAIL_FETCH +
          ' 场（还能报名的优先），剩下的等下一次采集。');
    }

    for (let i = 0; i < fetchCount; i++) {
      const x = candidates[i];
      const title = cleanStr(x.name) || ('赛事编号 ' + x.raceId);
      log('  [' + (i + 1) + '/' + fetchCount + '] ' + (title.length > 34 ? title.slice(0, 34) + '…' : title));

      await sleep(DELAY_BETWEEN_REQUESTS_MS); // 每次请求之间歇一下

      let raw = null;
      let detailError = null;
      // 系列赛外壳只有两位数编号，详情接口实测返回 TST-SYS-ERROR，不去白跑一趟
      if (looksLikeRealRaceId(x.raceId)) {
        try {
          const d = await getJson(DETAIL_API + '?raceId=' + x.raceId, '赛事详情');
          if (d && d.success === true && d.data) raw = d;
          else detailError = '详情接口返回 code=' + (d && d.code);
        } catch (e) {
          detailError = e.message;
        }
      } else {
        detailError = '这场赛事在官网属于"系列赛"的形式，没有单独的详情资料';
      }
      if (raw) detailOk++; else { detailFail++; log('        → 详情取不到：' + detailError); }

      const race = (raw && raw.data && raw.data.race) || x;
      const signupStart = parseCnTime(race.signupStartTime);
      const signupEnd = parseCnTime(race.signupEndTime);
      const state = computeState(race.raceListStatus, signupStart, signupEnd, now);
      const prize = formatBonus(race.bonus, race.currency);

      const tags = (Array.isArray(race.tagsList) ? race.tagsList : [])
        .map(t => cleanStr(t && t.tagNameCn))
        .filter(Boolean);

      const pageUrl = SITE + 'entrance/' + x.raceId + '/introduction';

      // ---- 如实记录"这份数据哪里不完美"，写在卡片上，不藏着 ----
      const notes = [
        '本条数据来自阿里天池平台的公开接口（包括列表与赛事详情），卡片正文是官网原文的整理，' +
        '截断处已标明。',
      ];
      notes.push('天池的接口没有单独提供"一句话简介"，所以这张卡片上没有摘要 —— ' +
                 '本站不替主办方编一句简介出来，赛事内容请看下面的"赛事介绍"或点按钮去官网。');
      notes.push('天池平台上一场赛事就是一场（不像腾讯开悟那样分好几个赛道），' +
                 '所以卡片上"赛道数"显示为 0 个，不是数据缺失。');
      if (!prize) {
        notes.push('这场赛事官网的奖金字段值为 0，也就是【官网没有公布奖金金额】，' +
                   '所以这里显示"官网未公布"，不是本站漏填。');
      }
      if (state.key === 'open' && signupEnd) {
        notes.push('"正在报名"是天池平台当前标注的状态，报名截止时间以官网赛事页为准。');
      }
      if (detailFail) {
        notes.push('这场赛事的详情资料这次没有取到（' + detailError + '），' +
                   '所以卡片里没有赛事介绍与规则，请点上面的按钮去官网看。');
      }
      notes.push('本站不采集这场赛事的排行榜、参赛队伍与选手成绩信息。');

      items.push({
        id: 'tianchi:' + x.raceId,
        source_id: 'tianchi',
        source_name: '阿里天池',
        source_url: pageUrl,
        code: String(x.raceId),

        // ---- 名称 + 主办方 + 官方链接 ----
        title: title,
        title_en: cleanStr(x.nameEn),
        sub_title: null,
        // ★ 天池是"赛事平台"，平台上每一场比赛的主办方接口里没有单独给。
        //   所以这里只写平台名，不替任何一场比赛编一个主办方出来。
        organizer: '阿里云天池平台（具体主办方见官网赛事页）',
        official_page_url: pageUrl,
        register_url: pageUrl, // 天池的报名入口就在赛事页上（需登录天池账号）

        // ---- 时间 + 状态 ----
        register_start: signupStart,
        register_end: signupEnd,
        competition_start: parseCnTime(race.raceStartTime),
        competition_end: parseCnTime(race.raceEndTime),
        official_status: String(race.raceListStatus === undefined ? '' : race.raceListStatus),
        official_status_text: statusTextOf(race.raceListStatus),
        register_state: state.key,
        register_state_text: state.text,
        days_left: null,

        tag: tags.length ? tags.join(' / ') : null,
        competition_type: 'open',
        prize_pool: prize,
        summary: null,
        track_count: 0,
        tracks: [],
        sections: buildSections(raw, log),
        updated_at: null,
        detail_fetch_ok: !detailFail,
        data_notes: notes.map(n => (n.length > MAX_NOTE_CHARS ? n.slice(0, MAX_NOTE_CHARS) + '…' : n)),
      });
    }

    const openCount = items.filter(i => i.register_state === 'open').length;
    log('  ✔ 共整理出 ' + items.length + ' 场赛事，其中 ' + openCount + ' 场正在报名' +
        '（详情取到 ' + detailOk + ' 场，未取到 ' + detailFail + ' 场）');
    return items;
  },
};

// 把接口的状态编号翻译成人话（写进卡片"官网状态"那一行）
function statusTextOf(code) {
  const known = { 0: '立即报名', 1: '已报名 去参赛', 2: '报名已结束', 3: '未开始', 4: '已结束' };
  if (code === undefined || code === null) return '官网未提供状态编号（本站按报名日期推算）';
  return known[code] ? known[code] + '（天池状态编号 ' + code + '）' : '状态编号 ' + code + '（含义官网未说明）';
}
