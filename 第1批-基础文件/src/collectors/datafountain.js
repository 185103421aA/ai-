// ============================================================
// 数据源积木块 4：DataFountain（datafountain.cn）
//
// 这块积木使用 DataFountain 官网前端当前实际调用的公开接口：
//   列表：GET /api/competitions
//   详情：GET /api/competitions/{id}
//
// 接口调研时间：2026-09-19。
// 列表接口实测返回 cmpt.competitions / cmpt.total，默认每页 30 条；
// 详情接口实测返回赛事说明、赛程、奖金、标签和主办方。
//
// ★ 官网没有单独可靠的“报名截止时间”字段：
//   isOpenSignup 是“目前可报名”标记，startTime/endTime 是比赛时间。
//   因此不能把 endTime 冒充报名截止时间；本站只把它写进比赛时间，
//   报名截止时间留空，并在 data_notes 里如实说明。
//
// ★ 不采集排行榜、队伍、用户数、提交记录等参赛者信息。
// ============================================================

const API_BASE = 'https://www.datafountain.cn/api/competitions';
const SITE = 'https://www.datafountain.cn';
const MAX_API_PAGE_SIZE = 30; // per_page=100 的现场请求会返回 HTTP 500
const PAGE_SIZE = 30;
const MAX_PAGES = 20;
const MAX_DETAIL_FETCH = 40;
const DELAY_BETWEEN_REQUESTS_MS = 800;
const MAX_SECTION_CHARS = 2600;

const HEADERS = {
  accept: 'application/json, text/plain, */*',
  'accept-language': 'zh-CN,zh;q=0.9',
  referer: SITE + '/competitions',
  'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/124.0 Safari/537.36',
};

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function cleanStr(v) {
  if (typeof v !== 'string') return null;
  const t = v.replace(/[\u200b\u200c\u200d\ufeff\u00a0]/g, ' ').replace(/\s+/g, ' ').trim();
  return t.length ? t : null;
}

function cleanText(v) {
  if (typeof v !== 'string') return '';
  return v
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/p\s*>/gi, '\n')
    .replace(/<[^>]*>/g, ' ')
    .replace(/!\[[^\]]*\]\([^)]*\)/g, ' ')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/[*#`_]/g, '')
    .replace(/[\u200b\u200c\u200d\ufeff\u00a0]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function parseDate(v) {
  if (!v) return null;
  const d = new Date(v);
  return isNaN(d.getTime()) ? null : d;
}

function isoDate(v) {
  const d = parseDate(v);
  return d ? d.toISOString() : null;
}

function dateText(v) {
  const d = parseDate(v);
  return d ? d.toISOString().slice(0, 10) : '官网未公布';
}

function formatReward(value, rewardType) {
  const t = cleanStr(value);
  if (!t || !/\d/.test(t)) return null;
  if (/^\d+(?:\.\d+)?$/.test(t) && Number.isFinite(Number(t))) {
    const n = Number(t);
    if (rewardType === 1) return '¥' + n.toLocaleString('en-US');
    return t;
  }
  return t;
}

function tagsOf(raw) {
  const out = [];
  for (const t of (Array.isArray(raw && raw.tags) ? raw.tags : [])) {
    const name = cleanStr(t && (t.nameCn || t.nameEn));
    if (name && !out.includes(name)) out.push(name);
  }
  for (const t of (Array.isArray(raw && raw.industries) ? raw.industries : [])) {
    const name = cleanStr(t && (t.nameCn || t.nameEn));
    if (name && !out.includes(name)) out.push(name);
  }
  return out;
}

function section(title, content, sort) {
  const text = cleanText(content);
  if (!text) return null;
  return {
    section_type: 'datafountain',
    code: 'datafountain-' + sort,
    title,
    content: text.slice(0, MAX_SECTION_CHARS),
    sort,
  };
}

function sectionsOf(detail) {
  const out = [];
  const description = section('赛事介绍', detail && detail.cmptDescription, 0);
  const dataDescription = section('数据与任务说明', detail && detail.cmptDataDescription, 10);
  const faq = section('常见问题', detail && detail.cmptFaq, 20);
  if (description) out.push(description);
  if (dataDescription) out.push(dataDescription);
  if (faq) out.push(faq);

  const schedules = Array.isArray(detail && detail.schedules) ? detail.schedules : [];
  for (let i = 0; i < schedules.length; i++) {
    const s = schedules[i] || {};
    const title = '赛程：' + (cleanStr(s.title) || ('阶段 ' + (i + 1)));
    const content = dateText(s.startTime) + ' ～ ' + dateText(s.endTime);
    const item = section(title, content, 30 + i);
    if (item) out.push(item);
  }
  return out;
}

async function getJson(url, label) {
  let lastError = null;
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      const res = await fetch(url, { headers: HEADERS });
      if (!res.ok) throw new Error('HTTP ' + res.status);
      const text = await res.text();
      let json;
      try {
        json = JSON.parse(text);
      } catch (e) {
        throw new Error('返回的不是合法 JSON：' + e.message);
      }
      return json;
    } catch (e) {
      lastError = e;
      if (attempt === 1) await sleep(600);
    }
  }
  throw new Error(label + '取不到：' + (lastError && lastError.message ? lastError.message : lastError));
}

function isCurrentCandidate(raw, now) {
  if (!raw || raw.isPublished !== 1 || raw.isOpenSignup !== 1) return false;
  const end = parseDate(raw.endTime);
  return !end || end > now;
}

function normalize(raw, detail, now) {
  const source = detail || raw || {};
  const end = parseDate(source.endTime || raw.endTime);
  const start = parseDate(source.startTime || raw.startTime);
  const title = cleanStr(source.title || raw.title) || ('赛事编号 ' + source.id);
  const organizers = Array.isArray(source.organizers) ? source.organizers : (raw.organizers || []);
  const organizer = organizers.map(x => cleanStr(x && x.name)).filter(Boolean).join(' / ') ||
    'DataFountain 平台（具体主办方见官网赛事页）';
  const reward = formatReward(source.reward || source.totalBonus || raw.reward, source.rewardType || raw.rewardType);
  const tags = tagsOf(source).length ? tagsOf(source) : tagsOf(raw);
  const open = isCurrentCandidate(raw, now);
  const description = cleanText(source.cmptDescription);
  const hasScheduleEndSignal = Array.isArray(source.schedules) &&
    source.schedules.some(s => s && (s.listAEndTime || s.listBEndTime));

  return {
    id: 'datafountain:' + source.id,
    source_id: 'datafountain',
    source_name: 'DataFountain 数据科学竞赛',
    source_url: SITE + '/competitions',
    code: String(source.id),

    title,
    title_en: cleanStr(source.titleEn || raw.titleEn),
    sub_title: cleanStr(source.subTitle || raw.subTitle),
    organizer,
    official_page_url: SITE + '/competitions/' + source.id,
    register_url: SITE + '/competitions/' + source.id,

    // 官网把 startTime/endTime 定义为比赛时间，不把它们冒充报名时间。
    register_start: null,
    register_end: null,
    competition_start: start ? start.toISOString() : null,
    competition_end: end ? end.toISOString() : null,
    official_status: raw.isOpenSignup === 1 ? 'can_signup' : 'cannot_signup',
    official_status_text: raw.isOpenSignup === 1 ? '官网标注可报名' : '官网标注不可报名',
    register_state: open ? 'open' : (end && end <= now ? 'closed' : 'unknown'),
    register_state_text: open ? '正在报名（官网未单独公布报名截止时间）' : '报名状态需以官网为准',
    days_left: null,

    tag: tags.length ? tags.join(' / ') : null,
    competition_type: raw.typeId === 2 ? 'application' : 'open',
    prize_pool: reward,
    summary: description ? description.slice(0, 600) : null,
    track_count: 0,
    tracks: [],
    sections: sectionsOf(source),
    updated_at: null,
    detail_fetch_ok: Boolean(detail),
    data_notes: [
      '本条数据来自 DataFountain 官网公开接口：列表接口 /api/competitions，详情接口 /api/competitions/{id}。',
      '官网公开字段提供的是比赛起止时间和“可报名”标记，没有单独可靠的报名截止时间；本站没有把比赛结束时间冒充报名截止时间。',
      ...(hasScheduleEndSignal ? [
        '详情中存在赛段截止字段（listAEndTime/listBEndTime），但其是否等于报名截止尚未确认；本站不将其自动映射为 register_end。',
      ] : []),
      reward ? '奖金按官网接口原值显示，本站不对外币或非金额奖励做汇率换算。' : '官网接口没有提供可识别的奖金金额，本站显示“官网未公布”。',
      '本站不采集该赛事的排行榜、参赛队伍、用户数量与提交记录。',
    ],
  };
}

module.exports = {
  sourceId: 'datafountain',
  sourceName: 'DataFountain 数据科学竞赛',

  async collect({ log }) {
    const now = new Date();
    const all = [];
    let total = 0;

    if (PAGE_SIZE > MAX_API_PAGE_SIZE) {
      throw new Error('DataFountain 接口分页上限已被突破：per_page=' + PAGE_SIZE +
        '，现场验证的安全上限为 ' + MAX_API_PAGE_SIZE);
    }

    log('  正在读取 DataFountain 公开竞赛列表（每页 ' + PAGE_SIZE + ' 条）...');
    for (let page = 1; page <= MAX_PAGES; page++) {
      const url = API_BASE + '?search=&type=0&tagCode=&indCode=&page=' + page +
        '&per_page=' + PAGE_SIZE + '&sort=default&raceId=0&cmptStatus=-1';
      const json = await getJson(url, 'DataFountain 第 ' + page + ' 页');
      if (!json || !json.cmpt || !Array.isArray(json.cmpt.competitions)) {
        throw new Error('DataFountain 列表返回结构变化：没有 cmpt.competitions');
      }
      total = Number(json.cmpt.total) || total;
      all.push(...json.cmpt.competitions);
      if (all.length >= total || json.cmpt.competitions.length < PAGE_SIZE) break;
      await sleep(DELAY_BETWEEN_REQUESTS_MS);
    }

    const candidates = all.filter(x => isCurrentCandidate(x, now));
    log('  → 官网公开列表共 ' + all.length + ' / ' + total + ' 条；当前可报名且未结束的候选为 ' + candidates.length + ' 条');

    const items = [];
    const fetchCount = Math.min(candidates.length, MAX_DETAIL_FETCH);
    if (candidates.length > MAX_DETAIL_FETCH) {
      log('  ⚠ 当前候选超过 ' + MAX_DETAIL_FETCH + ' 条，本次只取前 ' + MAX_DETAIL_FETCH + ' 条详情。');
    }

    for (let i = 0; i < fetchCount; i++) {
      const raw = candidates[i];
      log('  [' + (i + 1) + '/' + fetchCount + '] 正在取详情：' + (cleanStr(raw.title) || raw.id));
      await sleep(DELAY_BETWEEN_REQUESTS_MS);
      let detail = null;
      try {
        const json = await getJson(API_BASE + '/' + raw.id, 'DataFountain 赛事详情');
        if (json && json.id) detail = json;
      } catch (e) {
        log('        → 详情取不到：' + e.message + '；保留列表字段');
      }
      items.push(normalize(raw, detail, now));
    }

    log('  ✔ DataFountain 整理出 ' + items.length + ' 场，其中 ' +
      items.filter(x => x.register_state === 'open').length + ' 场正在报名');
    return items;
  },
};
