// ============================================================
// 数据源积木块：腾讯开悟 AI Arena
// 网站：https://tencentarena.com/aiarena/zh/match
//
// 这块积木只做两件事：
//   1. 去把页面拿回来，从页面里夹带的数据清单中读出结构化数据
//   2. 把读到的数据"擦干净"，转成全网统一的格式
//
// 它不负责存文件、不负责显示网页。所以将来要换/加数据源，
// 只要新写一块同样长相的积木即可，其它零件不用改。
// ============================================================

const SITE_ORIGIN = 'https://tencentarena.com';
const LIST_URL = SITE_ORIGIN + '/aiarena/zh/match';

// 只采集公开赛事（open）。腾讯开悟站上还挂着 4 场"邀请赛"（invitation），
// 是面向受邀高校/研究所的内部比赛，普通人报不了，且报名时间、奖金全是空的，
// 硬塞进来只会让网页看起来像坏了。想改主意时，把这个改成 ['open', 'invitation'] 即可。
const TYPES_TO_COLLECT = ['open'];

// 两次访问之间歇 1.2 秒。这是刻意放慢的：既是礼貌，也是最有效的自我保护。
const DELAY_BETWEEN_REQUESTS_MS = 1200;
const REQUEST_TIMEOUT_MS = 20000;
const MAX_REQUEST_ATTEMPTS = 2;

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// 把网页文字里夹带的那包数据单独揪出来
function extractEmbeddedData(html) {
  const match = html.match(/<script id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/);
  if (!match) {
    throw new Error(
      '在这个页面的源码里没找到预期的数据区（__NEXT_DATA__）。' +
      '通常意味着网站改版了，或者页面结构变了。原始网页长度=' + html.length
    );
  }
  try {
    return JSON.parse(match[1]);
  } catch (e) {
    throw new Error('找到了数据区，但内容不是合法格式，无法解析：' + e.message);
  }
}

// 访问一个网址，拿回网页文字
async function fetchText(url) {
  let lastError = null;
  for (let attempt = 1; attempt <= MAX_REQUEST_ATTEMPTS; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    try {
      const res = await fetch(url, {
        headers: {
          'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36',
          'accept-language': 'zh-CN,zh;q=0.9',
        },
        signal: controller.signal,
      });
      if (!res.ok) {
        throw new Error('访问 ' + url + ' 返回了错误状态码 ' + res.status);
      }
      return await res.text();
    } catch (error) {
      lastError = error;
      if (attempt < MAX_REQUEST_ATTEMPTS) await sleep(DELAY_BETWEEN_REQUESTS_MS);
    } finally {
      clearTimeout(timer);
    }
  }
  throw new Error('访问 ' + url + ' 失败：' + (lastError && lastError.message ? lastError.message : lastError));
}

// 把空的、没意义的文字统一变成 null，方便后面区分"没有"和"空字符串"
function cleanStr(v) {
  if (typeof v !== 'string') return null;
  const t = v.replace(/[\u200b\u00a0]/g, ' ').trim();
  return t.length ? t : null;
}

// 把腾讯那边的状态词翻译成给普通人看的话
// 注意：这里只做"翻译"，不做"推断"。真正的报名中/已截止判断在 normalize 里另算。
function translateStatus(raw, fallback) {
  const map = {
    ended: '已结束',
    ongoing: '进行中',
    not_started: '未开始',
    invalid: '已失效',
    none: '',
  };
  if (raw && map[raw] !== undefined) return map[raw];
  return fallback || null;
}

// 判断"报名是否还在进行"—— 这是全站唯一需要动脑子的地方
//
// 判断顺序非常重要，第一版就在这里踩过坑：
// 2025 届官网自己写着"已结束"，但它的报名截止日是空的，
// 如果只看日期就会算成"报名中"——那就成了睁眼说瞎话。
// 所以规矩是：官网自己说的状态最权威，日期推算只在官网没表态时兜底。
function computeRegisterState(regStart, regEnd, now, officialStatus) {
  const s = officialStatus ? String(officialStatus).toLowerCase() : null;
  if (s === 'ended') {
    return { key: 'closed', text: '报名已截止（赛事已结束）', daysLeft: null };
  }
  if (s === 'invalid') {
    return { key: 'invalid', text: '本场赛事已失效', daysLeft: null };
  }
  if (!regStart && !regEnd) {
    return { key: 'unknown', text: '官网未公布报名时间', daysLeft: null };
  }
  if (regStart && now < regStart) {
    return { key: 'not_started', text: '报名未开始', daysLeft: null };
  }
  if (regEnd && now > regEnd) {
    return { key: 'closed', text: '报名已截止', daysLeft: null };
  }
  if (regEnd) {
    const days = Math.ceil((regEnd.getTime() - now.getTime()) / 86400000);
    return { key: 'open', text: '报名中', daysLeft: days };
  }
  return { key: 'open', text: '报名中', daysLeft: null };
}

// 腾讯的详情页数据里，赛事详情分成若干"板块"（specials），
// 每个板块有小标题和正文。这里把它们整理成一个好读的列表。
function normalizeSections(specials, sectionType) {
  if (!Array.isArray(specials) || specials.length === 0) return [];
  return specials
    .filter(s => s && s.publish_status !== 'unpublished')
    .map(s => ({
      section_type: sectionType,
      code: cleanStr(s.code),
      title: cleanStr(s.title) || '（无标题）',
      content: cleanStr(s.content),
      sort: typeof s.sort_priority === 'number' ? s.sort_priority : (typeof s.id === 'number' ? s.id : 0),
    }))
    .filter(s => s.content)
    .sort((a, b) => a.sort - b.sort);
}

// 把一条"赛事"数据擦干净
function normalizeMatch(raw, now) {
  const code = cleanStr(raw.code);
  const regStart = cleanStr(raw.register_start_time) ? new Date(raw.register_start_time) : null;
  const regEnd = cleanStr(raw.register_end_time) ? new Date(raw.register_end_time) : null;
  const compStart = cleanStr(raw.competition_start_time) ? new Date(raw.competition_start_time) : null;

  const regState = computeRegisterState(regStart, regEnd, now, raw.status);

  return {
    id: 'tencent-arena:' + code,
    source_id: 'tencent-arena',
    source_name: '腾讯开悟 AI Arena',
    source_url: LIST_URL,
    code,

    // ---- 你要的第 1 类：名称 + 主办方 + 官方链接 ----
    title: cleanStr(raw.title),
    title_en: cleanStr(raw.title_en),
    sub_title: cleanStr(raw.sub_title),
    organizer: '腾讯开悟（腾讯 AI 平台部 / 王者荣耀）',
    official_page_url: SITE_ORIGIN + '/aiarena/zh/match/' + code,
    register_url: cleanStr(raw.external_register_url),

    // ---- 你要的第 2 类：报名截止 + 比赛时间 + 状态 ----
    register_start: regStart ? regStart.toISOString() : null,
    register_end: regEnd ? regEnd.toISOString() : null,
    competition_start: compStart ? compStart.toISOString() : null,
    official_status: cleanStr(raw.status),
    official_status_text: translateStatus(raw.status, null),
    register_state: regState.key,        // 程序自己算的：open / closed / not_started / unknown
    register_state_text: regState.text,  // 给人看的：报名中 / 报名已截止 ...
    days_left: regState.daysLeft,

    // ---- 其它有用的 ----
    tag: cleanStr(raw.tag),
    competition_type: cleanStr(raw.competition_type),
    prize_pool: cleanStr(raw.prize_pool) || cleanStr(raw.total_prize),
    summary: cleanStr(raw.description),
    track_count: Array.isArray(raw.tracks) ? raw.tracks.length : 0,

    // ---- 你要的第 3、4 类（详细规则 / 参赛资格）稍后由详情页补齐 ----
    tracks: [],
    sections: [],
    updated_at: cleanStr(raw.updated_at),
  };
}

// 把一条"赛道"数据擦干净
function normalizeTrack(raw, now) {
  const regStart = cleanStr(raw.register_start_time) ? new Date(raw.register_start_time) : null;
  const regEnd = cleanStr(raw.register_end_time) ? new Date(raw.register_end_time) : null;
  // 赛道以平台侧状态为准；赛道自身 status 常年是 "none"（没意义），所以优先看 platform_status
  const regState = computeRegisterState(regStart, regEnd, now, raw.platform_status || raw.status);

  const buttons = Array.isArray(raw.register_link_bts)
    ? raw.register_link_bts
        .map(b => ({
          text: cleanStr(b.txt) || '报名入口',
          url: cleanStr(b.bt_link),
          note: cleanStr(b.protocol),
        }))
        .filter(b => b.url)
    : [];

  return {
    code: cleanStr(raw.code),
    title: cleanStr(raw.title),
    title_en: cleanStr(raw.title_en),
    status: cleanStr(raw.status),
    platform_status: cleanStr(raw.platform_status),
    prize_pool: cleanStr(raw.prize_pool) || cleanStr(raw.total_prize),
    requirement: cleanStr(raw.description),   // ← 参赛资格（原文就写在这里）
    register_hint: cleanStr(raw.register_hint), // ← 报名方式/流程/材料
    register_buttons: buttons,
    register_start: regStart ? regStart.toISOString() : null,
    register_end: regEnd ? regEnd.toISOString() : null,
    register_state_text: regState.text,
    page_url: SITE_ORIGIN + '/aiarena/zh/match/' + cleanStr(raw.competition_code) + '/' + cleanStr(raw.code),
  };
}

module.exports = {
  sourceId: 'tencent-arena',
  sourceName: '腾讯开悟 AI Arena',

  async collect({ log }) {
    const now = new Date();
    log('  正在访问赛事列表页...');
    const listHtml = await fetchText(LIST_URL);
    const listData = extractEmbeddedData(listHtml);
    const initial = listData?.props?.pageProps?.initialData;
    if (!initial) {
      throw new Error('列表页的数据区里没有 initialData，网站结构可能变了');
    }

    const allMatches = []
      .concat(Array.isArray(initial.recentMatches) ? initial.recentMatches : [])
      .concat(Array.isArray(initial.pastMatches) ? initial.pastMatches : []);

    log('  列表页里共有 ' + allMatches.length + ' 场赛事记录');

    const wanted = allMatches.filter(
      m => m && cleanStr(m.code) && TYPES_TO_COLLECT.includes(cleanStr(m.competition_type))
    );
    log('  其中属于公开赛、准备采集的有 ' + wanted.length + ' 场');

    const results = [];
    for (let i = 0; i < wanted.length; i++) {
      const raw = wanted[i];
      const code = cleanStr(raw.code);
      log('  [' + (i + 1) + '/' + wanted.length + '] 正在取详情：' + (cleanStr(raw.title) || code));

      const item = normalizeMatch(raw, now);

      // 详情页里才有赛道的完整信息（参赛资格、报名方式、规则说明）
      try {
        await sleep(DELAY_BETWEEN_REQUESTS_MS);
        const detailHtml = await fetchText(SITE_ORIGIN + '/aiarena/zh/match/' + code);
        const detailData = extractEmbeddedData(detailHtml);
        const md = detailData?.props?.pageProps?.initialData?.matchDetail;

        if (md) {
          // 用详情页的数据补全列表页缺的字段（详情页更全）
          if (cleanStr(md.prize_pool) || cleanStr(md.total_prize)) {
            item.prize_pool = cleanStr(md.prize_pool) || cleanStr(md.total_prize);
          }
          if (!item.summary) item.summary = cleanStr(md.description);
          if (!item.register_url) item.register_url = cleanStr(md.external_register_url);
          if (!item.register_start && cleanStr(md.register_start_time)) item.register_start = new Date(md.register_start_time).toISOString();
          if (!item.register_end && cleanStr(md.register_end_time)) item.register_end = new Date(md.register_end_time).toISOString();
          if (!item.competition_start && cleanStr(md.competition_start_time)) item.competition_start = new Date(md.competition_start_time).toISOString();

          // 详情页的报名/开赛时间可能补齐了，重新算一次报名状态
          const restarted = computeRegisterState(
            item.register_start ? new Date(item.register_start) : null,
            item.register_end ? new Date(item.register_end) : null,
            now,
            item.official_status
          );
          item.register_state = restarted.key;
          item.register_state_text = restarted.text;
          item.days_left = restarted.daysLeft;

          item.tracks = Array.isArray(md.tracks)
            ? md.tracks.filter(t => t && cleanStr(t.publish_status) !== 'unpublished').map(t => normalizeTrack(t, now))
            : [];
          item.sections = normalizeSections(md.specials, 'match');
          item.track_count = item.tracks.length;

          log('        → 拿到 ' + item.tracks.length + ' 个赛道，' + item.sections.length + ' 个介绍板块');
        } else {
          log('        → 详情页没找到 matchDetail，只保留列表页信息');
        }
        item.detail_fetch_ok = true;
      } catch (err) {
        // 单场赛事的详情失败，不影响其它赛事。如实标注，绝不编造。
        item.detail_fetch_ok = false;
        item.detail_error = err && err.message ? err.message : String(err);
        log('        → 详情页采集失败：' + item.detail_error);
      }

      results.push(item);
    }

    // 按年份从新到旧排（没有年份的排在最后）
    results.sort((a, b) => {
      const ya = String(a.code || '').match(/(\d{4})/);
      const yb = String(b.code || '').match(/(\d{4})/);
      return (yb ? Number(yb[1]) : 0) - (ya ? Number(ya[1]) : 0);
    });

    return results;
  },
};
