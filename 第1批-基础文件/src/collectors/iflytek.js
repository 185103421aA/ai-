// ============================================================
// 数据源积木块 5：科大讯飞 iFLYTEK AI 开发者大赛
//
// 接口均为 2026-09-19 实地从官网前端核验后使用：
//   列表：GET /2020/ai-contest/api/contests/contests-list
//   详情：GET /2020/ai-contest/api/page-data/{contest_flag}
//
// 官网列表接口同时返回历史赛事和当前赛事；本站只接入算法赛、应用赛，
// 并保留官网状态为“未开始/进行中”的赛事。报名状态另按官网报名起止日期计算，
// 不把“进行中”误当成“仍可报名”。不采集排行榜、队伍或参赛者信息。
// ============================================================

const LIST_API = 'https://challenge.xfyun.cn/2020/ai-contest/api/contests/contests-list';
const DETAIL_API = 'https://challenge.xfyun.cn/2020/ai-contest/api/page-data/';
const SITE = 'https://challenge.xfyun.cn';
const MAX_DETAIL_FETCH = 120;
const DELAY_BETWEEN_REQUESTS_MS = 700;
const MAX_SECTION_CHARS = 3000;

const HEADERS = {
  accept: 'application/json, text/plain, */*',
  'accept-language': 'zh-CN,zh;q=0.9',
  referer: SITE + '/competition',
  'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/124.0 Safari/537.36',
};

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function cleanStr(v) {
  if (typeof v !== 'string' && typeof v !== 'number') return null;
  const t = String(v).replace(/[\u200b\u200c\u200d\ufeff\u00a0]/g, ' ').replace(/\s+/g, ' ').trim();
  return t.length ? t : null;
}

function cleanText(v) {
  if (typeof v !== 'string') return '';
  return v
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/<br\s*\/?\s*>/gi, '\n')
    .replace(/<\/p\s*>/gi, '\n')
    .replace(/<[^>]*>/g, ' ')
    .replace(/!\[[^\]]*\]\([^)]*\)/g, ' ')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/[*#`_]/g, '')
    .replace(/[\u200b\u200c\u200d\ufeff\u00a0]/g, ' ')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n\s*\n\s*\n+/g, '\n\n')
    .trim();
}

function parseCnDate(value, endOfDay) {
  const s = cleanStr(value);
  if (!s || /^1999-09-09/.test(s)) return null;
  const m = s.match(/^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})/);
  if (!m) {
    const d = new Date(s);
    return isNaN(d.getTime()) ? null : d;
  }
  const iso = m[1] + '-' + String(m[2]).padStart(2, '0') + '-' + String(m[3]).padStart(2, '0') +
    (endOfDay ? 'T23:59:59+08:00' : 'T00:00:00+08:00');
  const d = new Date(iso);
  return isNaN(d.getTime()) ? null : d;
}

function isoDate(value, endOfDay) {
  const d = parseCnDate(value, endOfDay);
  return d ? d.toISOString() : null;
}

function realDate(value) {
  const s = cleanStr(value);
  return Boolean(s && !/^1999-09-09/.test(s) && parseCnDate(s));
}

function section(title, content, sort) {
  const text = cleanText(content);
  if (!text) return null;
  return {
    section_type: 'iflytek',
    code: 'iflytek-' + sort,
    title,
    content: text.slice(0, MAX_SECTION_CHARS),
    sort,
  };
}

function findBlockData(detail, key) {
  const blocks = detail && detail.data && Array.isArray(detail.data.blocks) ? detail.data.blocks : [];
  for (const block of blocks) {
    const data = block && block.data;
    if (data && typeof data === 'object' && Object.prototype.hasOwnProperty.call(data, key)) return data[key];
  }
  return null;
}

function basicData(detail) {
  const blocks = detail && detail.data && Array.isArray(detail.data.blocks) ? detail.data.blocks : [];
  return blocks.find(block => block && block.data && block.data.name_basic_problem)?.data || {};
}

function formatBonus(value, flag) {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return null;
  const symbol = flag === 'SMAIC' || flag === 'ai-general-2024' ? '$' : '¥';
  return symbol + (n * 10000).toLocaleString('en-US');
}

function typeName(type) {
  return type === 'application' ? '应用赛' : '算法赛';
}

function statusName(status) {
  return ({ '0': '未开始', '1': '已完赛', '2': '进行中' })[String(status)] || '官网未说明';
}

function registrationState(start, end, officialStatus, now) {
  if (start && now < start) return { state: 'not_started', text: '报名尚未开始', days: Math.ceil((start - now) / 86400000) };
  if (end && now > end) return { state: 'closed', text: '报名已截止', days: 0 };
  if (end) return { state: 'open', text: '正在报名', days: Math.max(0, Math.ceil((end - now) / 86400000)) };
  if (officialStatus === '2') return { state: 'open', text: '正在报名（官网未公布报名截止时间）', days: null };
  return { state: 'unknown', text: '报名状态需以官网为准', days: null };
}

function normalize(raw, detail, now) {
  const basic = basicData(detail);
  const flag = cleanStr(raw.contest_flag);
  const title = cleanStr(raw.name_basic_problem || raw.contest_name || basic.name_basic_problem) || ('赛事 ' + flag);
  const registerStartValue = raw.registerBegin_basic_problem || basic.registerBegin_basic_problem;
  const registerEndValue = raw.registerEnd_basic_problem || basic.registerEnd_basic_problem;
  const registerStart = parseCnDate(registerStartValue, false);
  const registerEnd = parseCnDate(registerEndValue, true);
  const competitionStartValue = basic.prelimBegin_basic_problem || raw.registerBegin_basic_problem;
  const competitionEndValue = basic.finalEnd_basic_problem || basic.semiFinalEnd_basic_problem ||
    basic.prelimEnd_basic_problem || raw.registerEnd_basic_problem;
  const officialPage = /^https?:\/\//i.test(cleanStr(raw.external_link) || '')
    ? cleanStr(raw.external_link)
    : SITE + '/topic/info?type=' + encodeURIComponent(flag);
  const reg = registrationState(registerStart, registerEnd, raw.status, now);
  const intro = findBlockData(detail, 'detail_intro_problem');
  const faq = findBlockData(detail, 'faq_faq_problem');
  const tag = [cleanStr(raw.industry), typeName(raw.type_basic_problem)].filter(Boolean).join(' / ');
  const summary = cleanText(basic.desc_basic_problem || raw.desc_basic_problem || raw.contest_name);
  const updated = cleanStr(raw.update_time || raw.publish_time);

  return {
    id: 'iflytek:' + flag,
    source_id: 'iflytek',
    source_name: '科大讯飞 iFLYTEK AI开发者大赛',
    source_url: SITE + '/competition',
    code: flag,

    title,
    title_en: null,
    sub_title: cleanStr(raw.contest_name) && raw.contest_name !== title ? cleanStr(raw.contest_name) : null,
    organizer: cleanStr(basic.sponsorName_basic_problem || raw.sponsorName_basic_problem) || '科大讯飞',
    official_page_url: officialPage,
    register_url: officialPage,

    register_start: registerStart ? registerStart.toISOString() : null,
    register_end: registerEnd ? registerEnd.toISOString() : null,
    competition_start: isoDate(competitionStartValue, false),
    competition_end: isoDate(competitionEndValue, true),
    official_status: String(raw.status),
    official_status_text: statusName(raw.status),
    register_state: reg.state,
    register_state_text: reg.text,
    days_left: reg.days,

    tag: tag || null,
    competition_type: raw.type_basic_problem === 'application' ? 'application' : 'open',
    prize_pool: formatBonus(basic.bonus_basic_problem || raw.bonus_basic_problem, flag),
    summary: summary ? summary.slice(0, 600) : null,
    track_count: 0,
    tracks: [],
    sections: [
      section('赛事介绍与参赛规则', intro, 0),
      section('常见问题', faq, 10),
    ].filter(Boolean),
    updated_at: updated && parseCnDate(updated) ? parseCnDate(updated).toISOString() : null,
    detail_fetch_ok: Boolean(detail),
    data_notes: [
      '本条数据来自科大讯飞官网公开接口：列表接口 /2020/ai-contest/api/contests/contests-list，详情接口 /2020/ai-contest/api/page-data/{contest_flag}。',
      '官网状态 0/1/2 对应官网前端的“未开始/已完赛/进行中”；本站报名状态另外按官网报名起止日期计算。',
      '奖金按官网接口的“万元”数值换算为展示金额；美元赛事保留美元符号。',
      '本站不采集排行榜、参赛队伍、用户数量与提交记录。',
    ],
  };
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

module.exports = {
  sourceId: 'iflytek',
  sourceName: '科大讯飞 iFLYTEK AI开发者大赛',

  async collect({ log }) {
    const now = new Date();
    log('  正在读取科大讯飞官网公开竞赛列表...');
    const json = await getJson(LIST_API, '科大讯飞竞赛列表');
    const all = json && json.data && Array.isArray(json.data.list) ? json.data.list :
      (json && json.data && Array.isArray(json.data) ? json.data : []);
    if (!all.length) throw new Error('科大讯飞列表返回结构变化：没有 data.list');

    const seen = new Set();
    const candidates = all.filter(raw => {
      const typeOk = raw && (raw.type_basic_problem === 'algorithem' || raw.type_basic_problem === 'application');
      const statusOk = raw && (String(raw.status) === '0' || String(raw.status) === '2');
      const flag = cleanStr(raw && raw.contest_flag);
      if (!typeOk || !statusOk || !flag || seen.has(flag)) return false;
      seen.add(flag);
      return true;
    });
    log('  → 官网列表实测返回 ' + all.length + ' 条；筛出算法赛/应用赛且官网状态为未开始或进行中的候选 ' + candidates.length + ' 条');

    const items = [];
    const fetchCount = Math.min(candidates.length, MAX_DETAIL_FETCH);
    for (let i = 0; i < fetchCount; i++) {
      const raw = candidates[i];
      log('  [' + (i + 1) + '/' + fetchCount + '] 正在取详情：' + (cleanStr(raw.name_basic_problem) || raw.contest_flag));
      if (i > 0) await sleep(DELAY_BETWEEN_REQUESTS_MS);
      let detail = null;
      try {
        const detailJson = await getJson(DETAIL_API + encodeURIComponent(raw.contest_flag), '科大讯飞赛事详情');
        if (detailJson && detailJson.data) detail = detailJson;
      } catch (e) {
        log('        → 详情取不到：' + e.message + '；保留列表字段');
      }
      items.push(normalize(raw, detail, now));
    }
    if (candidates.length > MAX_DETAIL_FETCH) {
      log('  ⚠ 候选超过详情上限 ' + MAX_DETAIL_FETCH + ' 条，本次只取前 ' + MAX_DETAIL_FETCH + ' 条。');
    }
    log('  ✔ 科大讯飞整理出 ' + items.length + ' 场，其中 ' + items.filter(x => x.register_state === 'open').length + ' 场正在报名');
    return items;
  },
};
