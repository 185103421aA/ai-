// ============================================================
// 数据源积木块 6：华为云大赛平台
//
// 接口均为 2026-09-19 实地从官网前端核验后使用：
//   列表：POST /hdcompetitionservice/v1/competition/get-competition-list
//   分类：POST /hdcompetitionservice/v1/competition/tracks
//   技术标签：POST /hdcompetitionservice/v1/competition/technology-list
//   详情：POST /hdcompetitionservice/v1/competition/get-competition-detail
//
// 前端逻辑路径会经过华为云网关前缀，不能把逻辑路径直接拼到域名后。
// 本站只收华为云平台中官方技术标签为 AI、且官网状态为“进行中”或“未开始”的赛事；
// 历史已结束赛事不进入本站。报名状态另按详情里的报名起止时间判断。
// 不采集排行榜、队伍、个人信息和提交记录。
// ============================================================

const SITE = 'https://developer.huaweicloud.com';
const API_BASE = 'https://devdata2.huaweicloud.com/rest/developer/fwdo/rest/developer/servlet';
const LIST_PATH = '/hdcompetitionservice/v1/competition/get-competition-list';
const TRACKS_PATH = '/hdcompetitionservice/v1/competition/tracks';
const TECHNOLOGY_PATH = '/hdcompetitionservice/v1/competition/technology-list';
const DETAIL_PATH = '/hdcompetitionservice/v1/competition/get-competition-detail';

const CATEGORY_ID = 'a849fed4b5fa11ef9f37fa163ebe27b7';
const AI_TECHNOLOGY_ID = '04123b93c1934da1a0c65717a11b7104';
const PAGE_SIZE = 100;
const MAX_DETAIL_FETCH = 40;
const DELAY_BETWEEN_REQUESTS_MS = 700;
const MAX_SECTION_CHARS = 2600;

const HEADERS = {
  accept: 'application/json, text/plain, */*',
  'accept-language': 'zh-CN,zh;q=0.9',
  'content-type': 'application/json',
  referer: SITE + '/competition/list',
  'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/124.0 Safari/537.36',
};

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function cleanStr(value) {
  if (typeof value !== 'string' && typeof value !== 'number') return null;
  const text = String(value)
    .replace(/[\u200b\u200c\u200d\ufeff\u00a0]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return text || null;
}

function cleanText(value) {
  if (typeof value !== 'string') return '';
  return value
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/p\s*>/gi, '\n')
    .replace(/<[^>]*>/g, ' ')
    .replace(/[*#`_]/g, '')
    .replace(/[\u200b\u200c\u200d\ufeff\u00a0]/g, ' ')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n\s*\n\s*\n+/g, '\n\n')
    .trim();
}

function parseCnDate(value, endOfDay) {
  const text = cleanStr(value);
  if (!text) return null;
  if (/([zZ]|[+-]\d{2}:?\d{2})$/.test(text)) {
    const parsed = new Date(text);
    return isNaN(parsed.getTime()) ? null : parsed;
  }
  const match = text.match(/^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})(?:[ T](\d{1,2}):(\d{1,2})(?::(\d{1,2}))?)?/);
  if (!match) {
    const parsed = new Date(text);
    return isNaN(parsed.getTime()) ? null : parsed;
  }
  const date = match[1] + '-' + String(match[2]).padStart(2, '0') + '-' + String(match[3]).padStart(2, '0');
  const time = match[4]
    ? String(match[4]).padStart(2, '0') + ':' + String(match[5] || '00').padStart(2, '0') + ':' + String(match[6] || '00').padStart(2, '0')
    : (endOfDay ? '23:59:59' : '00:00:00');
  const parsed = new Date(date + 'T' + time + '+08:00');
  return isNaN(parsed.getTime()) ? null : parsed;
}

function isoDate(value, endOfDay) {
  const date = parseCnDate(value, endOfDay);
  return date ? date.toISOString() : null;
}

function section(title, content, sort) {
  const text = cleanText(content);
  if (!text) return null;
  return {
    section_type: 'huawei-cloud',
    code: 'huawei-cloud-' + sort,
    title,
    content: text.slice(0, MAX_SECTION_CHARS),
    sort,
  };
}

function collectTrackNames(nodes, output) {
  for (const node of Array.isArray(nodes) ? nodes : []) {
    const id = cleanStr(node && node.id);
    const name = cleanStr(node && node.name);
    if (id && name) output.set(id, name);
    collectTrackNames(node && node.children, output);
  }
}

function statusText(code) {
  return ({ 0: '进行中', 1: '未开始', 2: '已结束' })[Number(code)] || '官网未说明';
}

function registrationState(detail, listed, now) {
  const start = parseCnDate(detail && detail.register_start_time, false);
  const end = parseCnDate(detail && detail.register_end_time, true);
  if (start && now < start) {
    return { state: 'not_started', text: '报名尚未开始', days: Math.ceil((start - now) / 86400000) };
  }
  if (end && now > end) {
    return { state: 'closed', text: '报名已截止', days: 0 };
  }
  if (end) {
    return { state: 'open', text: '正在报名', days: Math.max(0, Math.ceil((end - now) / 86400000)) };
  }
  if (cleanStr(listed && listed.registered_status) === 'REGISTERED_CUTOFF') {
    return { state: 'closed', text: '报名已截止（官网状态）', days: 0 };
  }
  return { state: 'unknown', text: '报名状态需以官网为准', days: null };
}

function formatBonus(value, showBonus) {
  const text = cleanStr(value);
  if (!text || text === '0' || showBonus === false) return null;
  return text;
}

function buildSections(detail) {
  const stages = Array.isArray(detail && detail.stages) ? detail.stages : [];
  const stageText = stages.map((stage, index) => {
    const name = cleanStr(stage && stage.stage_name) || ('阶段 ' + (index + 1));
    const start = cleanStr(stage && stage.start_time) || '官网未公布';
    const end = cleanStr(stage && stage.end_time) || '官网未公布';
    return name + '：' + start + ' ～ ' + end;
  }).join('\n');

  return [
    section('赛事简介', detail && detail.brief, 0),
    section('赛事说明', detail && detail.details, 10),
    section('报名条件', detail && detail.register_condition, 20),
    section('赛程阶段', stageText, 30),
  ].filter(Boolean);
}

async function postJson(path, body, label) {
  let lastError = null;
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      const response = await fetch(API_BASE + path, {
        method: 'POST',
        headers: HEADERS,
        body: JSON.stringify(body),
      });
      const text = await response.text();
      let json;
      try {
        json = JSON.parse(text);
      } catch (e) {
        throw new Error('返回的不是合法 JSON：' + e.message);
      }
      if (!response.ok) {
        throw new Error('HTTP ' + response.status + '：' + (json.error_msg || json.message || '接口返回失败'));
      }
      return json;
    } catch (error) {
      lastError = error;
      if (attempt === 1) await sleep(600);
    }
  }
  throw new Error(label + '取不到：' + (lastError && lastError.message ? lastError.message : lastError));
}

async function fetchList(statuses) {
  const all = [];
  let page = 1;
  let total = 0;
  while (page <= 20) {
    const json = await postJson(LIST_PATH, {
      category_id: CATEGORY_ID,
      track_id: '',
      technology_id: AI_TECHNOLOGY_ID,
      statuses,
      limit: PAGE_SIZE,
      offset: page,
      name: '',
    }, '华为云 AI 赛事列表');
    if (!json || !Array.isArray(json.results)) {
      throw new Error('华为云列表返回结构变化：没有 results');
    }
    total = Number(json.total) || total;
    all.push(...json.results);
    if (all.length >= total || json.results.length < PAGE_SIZE) break;
    page++;
  }
  return all;
}

function normalize(listed, detail, trackNames, technologyNames, now) {
  const source = detail || listed || {};
  const urlId = cleanStr(listed && listed.url_id) || cleanStr(source.url_id);
  const competitionId = cleanStr(listed && listed.competition_id) || cleanStr(source.competition_id);
  const title = cleanStr(source.title || listed.title) || ('赛事 ' + (urlId || competitionId));
  const reg = registrationState(detail, listed, now);
  const officialPage = SITE + '/competition/information/' + encodeURIComponent(urlId || competitionId);
  const track = trackNames.get(cleanStr(source.track_id || listed.track_id));
  const technology = technologyNames.get(cleanStr(source.technology_id || listed.technology_id));
  const bonus = formatBonus(source.bonus !== undefined ? source.bonus : listed.bonus, source.is_show_bonus !== false);
  const currentStatus = source.current_status !== undefined ? source.current_status : listed.current_status;
  const detailUpdated = isoDate(source.updated_time, false);

  return {
    id: 'huawei-cloud:' + (competitionId || urlId),
    source_id: 'huawei-cloud',
    source_name: '华为云大赛平台',
    source_url: SITE + '/competition/list',
    code: competitionId || urlId,

    title,
    title_en: null,
    sub_title: cleanStr(listed.brief) && listed.brief !== title ? cleanStr(listed.brief).slice(0, 160) : null,
    organizer: cleanStr(source.organizers || listed.organizers) || '华为云大赛平台（具体主办方见官网赛事页）',
    official_page_url: officialPage,
    register_url: cleanStr(source.link_url || listed.link_url) || officialPage,

    register_start: isoDate(source.register_start_time, false),
    register_end: isoDate(source.register_end_time, true),
    competition_start: isoDate(source.start_time || listed.start_time, false),
    competition_end: isoDate(source.end_time || listed.end_time, true),
    official_status: String(currentStatus === undefined || currentStatus === null ? '' : currentStatus),
    official_status_text: statusText(currentStatus),
    register_state: reg.state,
    register_state_text: reg.text,
    days_left: reg.days,

    tag: [technology || 'AI', track].filter(Boolean).join(' / '),
    competition_type: 'open',
    prize_pool: bonus,
    summary: cleanText(source.brief || listed.brief).slice(0, 600) || null,
    track_count: track ? 1 : 0,
    tracks: track ? [{ code: cleanStr(source.track_id || listed.track_id), title: track, status: 'none' }] : [],
    sections: buildSections(source),
    updated_at: detailUpdated,
    detail_fetch_ok: Boolean(detail),
    data_notes: [
      '本条数据来自华为云大赛平台公开接口：列表与详情均为 POST JSON；接口经过 /rest/developer/fwdo/rest/developer/servlet 网关前缀。',
      '本站按官方 AI 技术标签筛选，并只保留官网状态为“进行中”或“未开始”的赛事；历史已结束赛事不进入本站。',
      '列表中的 url_id 是页面数字 ID，详情接口使用 competition_id UUID；两者不能混用。',
      bonus ? '奖金按官网 bonus 原值显示；接口未提供可确认的币种换算，本站不添加币种符号。' : '官网 bonus 为 0、未展示或未提供可识别金额，本站显示“官网未公布”。',
      '本站不采集排行榜、参赛队伍、用户数量与提交记录。',
    ],
  };
}

module.exports = {
  sourceId: 'huawei-cloud',
  sourceName: '华为云大赛平台',

  async collect({ log }) {
    const now = new Date();
    log('  正在读取华为云大赛平台的 AI 赛事分类与技术标签...');

    const [tracksJson, technologyJson] = await Promise.all([
      postJson(TRACKS_PATH, { category_id: CATEGORY_ID }, '华为云赛事分类'),
      postJson(TECHNOLOGY_PATH, { category_id: CATEGORY_ID }, '华为云技术标签'),
    ]);
    const trackNames = new Map();
    collectTrackNames(tracksJson && tracksJson.results, trackNames);
    const technologyNames = new Map(
      (technologyJson && Array.isArray(technologyJson.technologyList) ? technologyJson.technologyList : [])
        .map(item => [cleanStr(item && item.id), cleanStr(item && item.name)])
        .filter(item => item[0] && item[1])
    );

    log('  正在读取官网标注为“进行中/未开始”的 AI 赛事列表...');
    const listedAll = [];
    for (const status of ['0', '1']) {
      const listed = await fetchList(status);
      listedAll.push(...listed);
    }

    const unique = new Map();
    for (const item of listedAll) {
      const key = cleanStr(item && item.competition_id) || cleanStr(item && item.url_id);
      if (key && !unique.has(key)) unique.set(key, item);
    }
    const candidates = [...unique.values()];
    log('  → AI 标签下筛出 ' + candidates.length + ' 场未结束赛事');

    const items = [];
    let detailOk = 0;
    let detailFail = 0;
    const fetchCount = Math.min(candidates.length, MAX_DETAIL_FETCH);
    if (candidates.length > MAX_DETAIL_FETCH) {
      log('  ⚠ 候选超过详情上限 ' + MAX_DETAIL_FETCH + ' 条，本次只取前 ' + MAX_DETAIL_FETCH + ' 条。');
    }

    for (let i = 0; i < fetchCount; i++) {
      const listed = candidates[i];
      const title = cleanStr(listed.title) || cleanStr(listed.url_id) || '未命名赛事';
      log('  [' + (i + 1) + '/' + fetchCount + '] 正在取详情：' + (title.length > 42 ? title.slice(0, 42) + '…' : title));
      if (i > 0) await sleep(DELAY_BETWEEN_REQUESTS_MS);

      let detail = null;
      try {
        const detailJson = await postJson(DETAIL_PATH, {
          competition_id: listed.competition_id,
        }, '华为云赛事详情');
        if (detailJson && Array.isArray(detailJson.results) && detailJson.results[0]) {
          detail = detailJson.results[0];
          detailOk++;
        } else {
          throw new Error('详情返回没有 results[0]');
        }
      } catch (error) {
        detailFail++;
        log('        → 详情取不到：' + error.message + '；保留列表字段');
      }
      items.push(normalize(listed, detail, trackNames, technologyNames, now));
    }

    log('  ✔ 华为云整理出 ' + items.length + ' 场，其中 ' +
      items.filter(item => item.register_state === 'open').length + ' 场正在报名' +
      '（详情取到 ' + detailOk + ' 场，未取到 ' + detailFail + ' 场）');
    return items;
  },
};
