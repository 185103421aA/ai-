// ============================================================
// 数据源积木块 2：腾讯广告算法大赛
// 网站：https://algo.qq.com/
//
// 这块积木和腾讯开悟那块"长相一样"，也吐"同一种格式"的数据。
// 所以网站那部分代码一行都不用改，它自动就能显示这个新数据源。
//
// 关于这个网站的特殊之处：
//   它的网页是一个空壳（打开只有空白），真正的数据在几个公开的接口里。
//   接口 = 网站后台专门给程序用的"取数窗口"，不用登录、不用密码。
//   实测可用的只读接口：竞赛信息、当前阶段、赛事新闻、赛事视频。
//
// 【刻意不采集的东西】
//   排行榜接口（getCompetitionRank）虽然也是公开的，但它包含
//   参赛队伍名称和选手成绩，属于参赛者信息，所以这块积木不去读它。
// ============================================================

const { randomUUID } = require('crypto');
const API_BASE = 'https://algo.qq.com/api/algo';
const SITE = 'https://algo.qq.com/';

const HEADERS = {
  'Content-Type': 'application/json',
  'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36',
  'accept-language': 'zh-CN,zh;q=0.9',
};

const DELAY_BETWEEN_REQUESTS_MS = 1200;
const REQUEST_TIMEOUT_MS = 20000;
const MAX_REQUEST_ATTEMPTS = 2;

// 接口返回的"阶段编号"翻译。6=已结束 是实测确认的；
// 其余编号没有权威依据，所以老实留空，让程序退回用接口给的文字描述，
// 绝不靠猜来断定比赛状态。
const STAGE_CODE_MAP = { 6: 'ended' };

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

async function callApi(path) {
  let lastError = null;
  for (let attempt = 1; attempt <= MAX_REQUEST_ATTEMPTS; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    try {
      const res = await fetch(API_BASE + path, {
        method: 'POST',
        headers: { ...HEADERS, Requestid: randomUUID() },
        body: '{}',
        signal: controller.signal,
      });
      if (!res.ok) throw new Error('访问接口 ' + path + ' 返回错误状态码 ' + res.status);
      const text = await res.text();
      let json;
      try {
        json = JSON.parse(text);
      } catch (e) {
        throw new Error('接口 ' + path + ' 返回的不是合法数据：' + e.message);
      }
      // 这个网站有个坑：未登录时 HTTP 状态码依然是 200，
      // 真正的"没权限"写在内容里的 code 字段，所以必须看 code，不能只看状态码。
      if (json.code !== 0) {
        throw new Error('接口 ' + path + ' 拒绝了请求：code=' + json.code + ' 说明=' + (json.zhMsg || '无'));
      }
      return json.data;
    } catch (error) {
      lastError = error;
      if (attempt < MAX_REQUEST_ATTEMPTS) await sleep(DELAY_BETWEEN_REQUESTS_MS);
    } finally {
      clearTimeout(timer);
    }
  }
  throw new Error('接口 ' + path + ' 失败：' + (lastError && lastError.message ? lastError.message : lastError));
}

function cleanStr(v) {
  if (typeof v !== 'string') return null;
  const t = v.replace(/[\u200b\u00a0]/g, ' ').trim();
  return t.length ? t : null;
}

// "2025年06月19日" → ISO 时间
function parseCnDate(s) {
  const t = cleanStr(s);
  if (!t) return null;
  const m = t.match(/(\d{4})\D+(\d{1,2})\D+(\d{1,2})/);
  if (!m) return null;
  const d = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
  return isNaN(d.getTime()) ? null : d.toISOString();
}

function computeRegisterState(stageKey, stageDesc, now) {
  if (stageKey === 'ended' || (stageDesc && stageDesc.indexOf('已结束') >= 0)) {
    return { key: 'closed', text: '报名已截止（赛事已结束）', daysLeft: null };
  }
  return { key: 'unknown', text: stageDesc || '官网未公布报名状态', daysLeft: null };
}

module.exports = {
  sourceId: 'tencent-ad-algo',
  sourceName: '腾讯广告算法大赛',

  async collect({ log }) {
    const now = new Date();

    log('  正在读取竞赛基本信息...');
    const info = await callApi('/getCompetitionInfo');
    await sleep(DELAY_BETWEEN_REQUESTS_MS);

    log('  正在读取当前赛程阶段...');
    let stage = null;
    try {
      stage = await callApi('/getCurrentStageInfo');
    } catch (e) {
      log('        → 赛程阶段取不到：' + e.message);
    }
    await sleep(DELAY_BETWEEN_REQUESTS_MS);

    log('  正在读取赛事新闻...');
    let news = [];
    try {
      news = await callApi('/getCompetitionNews');
    } catch (e) {
      log('        → 赛事新闻取不到：' + e.message);
    }

    const stageKey = stage && STAGE_CODE_MAP[stage.code] ? STAGE_CODE_MAP[stage.code] : null;
    const stageDesc = cleanStr(stage && stage.desc);
    const regState = computeRegisterState(stageKey, stageDesc, now);

    const newsList = (Array.isArray(news) ? news : [])
      .map(n => ({
        title: cleanStr(n.title),
        content: cleanStr(n.content),
        url: cleanStr(n.link),
        date: parseCnDate(n.date),
      }))
      .filter(n => n.title);

    // 这条赛事官网没有"赛事简介"接口，只有新闻。
    // 所以这里只把新闻当作"动态"，不冒充规则说明。
    const sections = newsList.slice(0, 8).map((n, i) => ({
      section_type: 'news',
      code: 'news-' + i,
      title: n.title,
      content: [n.content, n.date ? '发布：' + new Date(n.date).toLocaleDateString('zh-CN', { timeZone: 'Asia/Shanghai' }) : null, n.url]
        .filter(Boolean).join('\n'),
      sort: i,
    }));

    const item = {
      id: 'tencent-ad-algo:main',
      source_id: 'tencent-ad-algo',
      source_name: '腾讯广告算法大赛',
      source_url: SITE,
      code: 'tencent-ad-algo',

      // ---- 名称 + 主办方 + 官方链接 ----
      title: cleanStr(info.nameZh),
      title_en: cleanStr(info.nameEn),
      sub_title: null,
      organizer: '腾讯广告',
      official_page_url: SITE,
      register_url: SITE, // 这个赛事的报名入口就是官网首页

      // ---- 时间 + 状态 ----
      // 注意：接口给的是"整个赛程"的起止时间，不是单独的报名截止时间。
      // 所以这里如实放在"比赛时间"栏，绝不冒充"报名截止"。
      register_start: null,
      register_end: null,
      competition_start: stage && cleanStr(stage.startTime) ? new Date(stage.startTime.replace(' ', 'T') + '+08:00').toISOString() : null,
      competition_end: stage && cleanStr(stage.endTime) ? new Date(stage.endTime.replace(' ', 'T') + '+08:00').toISOString() : null,
      official_status: stageKey || String(info.status),
      official_status_text: stageDesc || '未知',
      register_state: regState.key,
      register_state_text: regState.text,
      days_left: regState.daysLeft,

      tag: null,
      competition_type: 'open',
      prize_pool: null, // 这个接口不提供，绝不从别处抄来充数
      summary: '腾讯广告主办的全模态序列生成式推荐算法大赛。' +
               '（本条数据来自该赛事官网的公开接口，官网未通过接口提供赛事简介与奖金信息。）',
      track_count: 0,
      tracks: [],
      sections,
      updated_at: null,
      // 官网前端只调用了聚合接口，没有独立详情请求；不能把新闻接口冒充详情成功。
      detail_fetch_ok: false,
      // 如实记下"名实可能不符"和"没有独立详情"这两件事，不替主办方下结论
      data_notes: [
        '官网前端公开接口没有独立赛事详情请求；本站只取得赛事信息、当前阶段和新闻，故 detail_fetch_ok 记为 false。',
        '官网接口返回的赛事名称是「' + (cleanStr(info.nameZh) || '未知') + '」，' +
        '但赛程日期显示为 ' + (stage && stage.startTime ? stage.startTime : '未知') +
        ' 至 ' + (stage && stage.endTime ? stage.endTime : '未知') + '。' +
        '名称与日期可能不一致，本站如实照搬，未作推断。',
        '该赛事官网未通过公开接口提供报名截止时间与奖金金额，故本站显示为「官网未公布」。',
        '本站不采集该赛事的参赛队伍与选手成绩信息。',
      ],
    };

    log('  → 名称：' + item.title);
    log('  → 赛程：' + (item.competition_start || '未公布') + ' ~ ' + (item.competition_end || '未公布'));
    log('  → 状态：' + item.register_state_text);
    log('  → 动态：' + newsList.length + ' 条（页面展示前 8 条）');

    return [item];
  },
};
