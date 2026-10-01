// ============================================================
// 数据源积木块 7：飞桨 AI Studio（百度飞桨星河社区）
//
// 接口均为 2026-09-19 实地从官网前端 Network 和远程比赛模块核验后使用：
//   列表：GET /studio/match/search
//   详情：POST /studio/match/detail
//
// 列表的 matchStatus=1 是官网当前“报名中”筛选；详情里的 processCode/
// processText 是比赛阶段，两者不是同一个状态体系。报名状态优先看详情里的
// btnSignupText/btnSignupStatus，比赛起止时间不挪作报名起止时间。
// 不采集排行榜、队伍、个人信息和提交记录。
// ============================================================

const SITE = 'https://aistudio.baidu.com';
const LIST_API = SITE + '/studio/match/search';
const DETAIL_API = SITE + '/studio/match/detail';

const PAGE_SIZE = 100;
const MATCH_STATUS = 1; // 官网列表筛选：报名中
const MAX_DETAIL_FETCH = 120;
const DELAY_BETWEEN_REQUESTS_MS = 700;
const MAX_SECTION_CHARS = 2800;

const MATCH_TYPES = {
  1: '飞桨大赛',
  2: '飞桨学习赛',
  3: '新人练习赛',
  4: '千言数据集评测',
  5: '文心智能体大赛',
};

const HEADERS = {
  accept: 'application/json, text/plain, */*',
  'accept-language': 'zh-CN,zh;q=0.9',
  referer: SITE + '/competition/2/1',
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
  let text = value
    .replace(/!\[[^\]]*\]\([^)]*\)/g, ' ')
    .replace(/<img\b[^>]*>/gi, ' ')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/g, "'")
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/p\s*>/gi, '\n')
    .replace(/<\/div\s*>/gi, '\n')
    .replace(/<[^>]*>/g, ' ')
    .replace(/^\s*#{1,6}\s*/gm, '')
    .replace(/^\s*[-*_]{3,}\s*$/gm, '')
    .replace(/[*_`]/g, '')
    .replace(/[\u200b\u200c\u200d\ufeff\u00a0]/g, ' ')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n\s*\n\s*\n+/g, '\n\n')
    .trim();
  return text;
}

function parseCnDate(value, endOfDay) {
  const text = cleanStr(value);
  if (!text) return null;
  const match = text.match(/^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})(?:[ T](\d{1,2}):(\d{2})(?::(\d{2}))?)?/);
  if (!match) return null;
  const iso = match[1] + '-' + String(match[2]).padStart(2, '0') + '-' + String(match[3]).padStart(2, '0') +
    (match[4]
      ? 'T' + String(match[4]).padStart(2, '0') + ':' + match[5] + ':' + (match[6] || '00') + '+08:00'
      : endOfDay ? 'T23:59:59+08:00' : 'T00:00:00+08:00');
  const date = new Date(iso);
  return isNaN(date.getTime()) ? null : date;
}

function isoDate(value, endOfDay) {
  const date = parseCnDate(value, endOfDay);
  return date ? date.toISOString() : null;
}

function section(tab, index) {
  const content = cleanText(tab && tab.md);
  if (!content) return null;
  const title = cleanStr(tab.tabName) || cleanStr(tab.tabKey) || ('赛事说明 ' + (index + 1));
  return {
    section_type: 'paddle-ai-studio',
    code: 'paddle-ai-studio-' + (cleanStr(tab.tabKey) || index),
    title,
    content: content.slice(0, MAX_SECTION_CHARS),
    sort: index,
  };
}

function buildSections(detail) {
  const allowed = new Set(['introduction', 'task-definition', 'related-material', 'submit-result']);
  return (Array.isArray(detail && detail.matchContent) ? detail.matchContent : [])
    .filter(tab => allowed.has(cleanStr(tab && tab.tabKey)))
    .map((tab, index) => section(tab, index))
    .filter(Boolean);
}

function formatReward(value) {
  const text = cleanStr(value);
  if (!text) return null;
  if (/^[\d,.]+$/.test(text)) return text + '（官网原始奖励字段，币种/单位以官网为准）';
  return text;
}

function statusText(detail, listed) {
  return cleanStr(detail && detail.processText) || cleanStr(listed && listed.processText) || '官网未说明';
}

function registrationState(detail, listed) {
  const buttonStatus = detail && detail.btnSignupStatus;
  const buttonText = cleanStr(detail && detail.btnSignupText);
  if (buttonStatus === 0 || (buttonText && /报名/.test(buttonText) && !/(截止|结束|不可)/.test(buttonText))) {
    return { state: 'open', text: '正在报名', days: null };
  }
  if (buttonText && /(截止|结束|不可)/.test(buttonText)) {
    return { state: 'closed', text: '报名已截止', days: 0 };
  }
  if (cleanStr(listed && listed.processText) === '报名中') {
    return { state: 'open', text: '正在报名（官网列表标注）', days: null };
  }
  return { state: 'unknown', text: '报名状态需以官网为准', days: null };
}

async function getJson(url, options, label) {
  let lastError = null;
  for (let attempt = 1; attempt <= 2; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 20000);
    try {
      const response = await fetch(url, { ...options, signal: controller.signal });
      const text = await response.text();
      let json;
      try {
        json = JSON.parse(text);
      } catch (error) {
        throw new Error('返回的不是合法 JSON：' + error.message);
      }
      if (!response.ok) throw new Error('HTTP ' + response.status);
      if (!json || Number(json.errorCode) !== 0) {
        throw new Error('接口错误 ' + (json && json.errorMsg ? json.errorMsg : '未知错误'));
      }
      return json;
    } catch (error) {
      lastError = error;
      if (attempt === 1) await sleep(800);
    } finally {
      clearTimeout(timer);
    }
  }
  throw new Error(label + '取不到：' + (lastError && lastError.message ? lastError.message : lastError));
}

async function fetchList() {
  const all = [];
  let page = 1;
  let total = 0;
  while (page <= 20) {
    const query = new URLSearchParams({
      p: String(page),
      pageSize: String(PAGE_SIZE),
      matchType: '0',
      matchStatus: String(MATCH_STATUS),
      orderBy: '0',
    });
    const json = await getJson(LIST_API + '?' + query.toString(), { headers: HEADERS }, '飞桨 AI Studio 赛事列表');
    const result = json && json.result;
    if (!result || !Array.isArray(result.data)) throw new Error('列表返回结构变化：没有 result.data');
    total = Number(result.totalCount) || total;
    all.push(...result.data);
    if (all.length >= total || result.data.length < PAGE_SIZE) break;
    page++;
  }
  return all;
}

async function fetchDetail(id) {
  const body = new URLSearchParams({ matchId: String(id) }).toString();
  return getJson(DETAIL_API, {
    method: 'POST',
    headers: { ...HEADERS, 'content-type': 'application/x-www-form-urlencoded; charset=UTF-8' },
    body,
  }, '赛事详情 ' + id);
}

function normalize(listed, detail, now) {
  const source = detail || listed || {};
  const id = cleanStr(listed && listed.id) || cleanStr(source.id);
  const typeName = MATCH_TYPES[Number(listed && listed.matchType)] || '官网未说明赛事类型';
  const title = cleanStr(source.matchName || listed.matchName) || ('赛事 ' + (id || '未知'));
  const pageUrl = SITE + '/competition/detail/' + encodeURIComponent(id) + '/0/introduction';
  const registration = registrationState(detail, listed);
  const tags = cleanStr(source.tags || listed.tags);
  const tag = [typeName, tags].filter(Boolean).join(' / ');
  const reward = formatReward(source.reward !== undefined ? source.reward : listed.reward);
  const officialStatus = source.processCode !== undefined ? source.processCode : listed.processCode;
  const competitionStart = source.startTime || listed.startTime;
  const competitionEnd = source.endTime || listed.endTime;
  const notes = [
    '本条数据来自飞桨 AI Studio 官网公开列表与详情接口；详情正文按官网栏目整理并截断，完整内容请查看官网赛事页。',
    '官网没有提供独立、稳定的报名起止字段；本站不把比赛起止时间当作报名起止时间，因此报名截止天数留空。',
    '本站将官网比赛阶段与报名按钮状态分开记录：比赛状态来自详情 processCode/processText，报名状态来自 btnSignupText/btnSignupStatus。',
    '官网奖励字段可能没有币种或单位；本站保留原始奖励文本，不做人民币换算。',
    '本站不采集排行榜、队伍、个人信息和提交结果记录。',
  ];
  if (!detail) notes.push('这场赛事的详情资料本次没有取到，因此卡片保留列表字段；完整规则请点按钮去官网查看。');

  return {
    id: 'paddle-ai-studio:' + id,
    source_id: 'paddle-ai-studio',
    source_name: '飞桨 AI Studio',
    source_url: SITE + '/competition/2/1',
    code: String(id),

    title,
    title_en: null,
    sub_title: cleanStr(source.matchAbs || listed.matchAbs) && cleanStr(source.matchAbs || listed.matchAbs) !== title
      ? cleanStr(source.matchAbs || listed.matchAbs).slice(0, 160) : null,
    organizer: '百度飞桨 AI Studio 平台（具体主办方见官网赛事页）',
    official_page_url: pageUrl,
    register_url: /^https?:\/\//i.test(cleanStr(source.signupLink) || '') ? cleanStr(source.signupLink) : pageUrl,

    register_start: null,
    register_end: null,
    competition_start: isoDate(competitionStart, false),
    competition_end: isoDate(competitionEnd, true),
    official_status: officialStatus === undefined || officialStatus === null ? '' : String(officialStatus),
    official_status_text: statusText(detail, listed),
    register_state: registration.state,
    register_state_text: registration.text,
    days_left: registration.days,

    tag: tag || null,
    competition_type: 'open',
    prize_pool: reward,
    summary: cleanText(source.matchAbs || listed.matchAbs).slice(0, 600) || null,
    track_count: 0,
    tracks: [],
    sections: buildSections(detail),
    updated_at: isoDate(source.updateTime, false),
    detail_fetch_ok: Boolean(detail),
    data_notes: notes,
  };
}

module.exports = {
  sourceId: 'paddle-ai-studio',
  sourceName: '飞桨 AI Studio',

  async collect({ log }) {
    const now = new Date();
    log('  正在读取官网标注为“报名中”的 AI Studio 赛事列表...');
    const listed = await fetchList();
    const candidates = listed.filter(item => Object.prototype.hasOwnProperty.call(MATCH_TYPES, Number(item && item.matchType)));
    const skipped = listed.length - candidates.length;
    log('  → 官网列表返回 ' + listed.length + ' 条当前赛事，其中 ' + candidates.length + ' 条属于已核对的 AI 赛事类型');
    if (skipped) log('  → 略过 ' + skipped + ' 条官网未在当前类型表中说明的赛事');

    const items = [];
    let detailOk = 0;
    let detailFail = 0;
    const fetchCount = Math.min(candidates.length, MAX_DETAIL_FETCH);
    for (let i = 0; i < fetchCount; i++) {
      const listedItem = candidates[i];
      const id = cleanStr(listedItem.id);
      log('  [' + (i + 1) + '/' + fetchCount + '] ' + (cleanStr(listedItem.matchName) || ('赛事 ' + id)).slice(0, 42));
      if (i) await sleep(DELAY_BETWEEN_REQUESTS_MS);

      let detail = null;
      try {
        const response = await fetchDetail(id);
        detail = response && response.result ? response.result : null;
        if (detail) detailOk++;
        else detailFail++;
      } catch (error) {
        detailFail++;
        log('        → 详情取不到：' + error.message);
      }
      items.push(normalize(listedItem, detail, now));
    }

    const openCount = items.filter(item => item.register_state === 'open').length;
    log('  ✔ 共整理出 ' + items.length + ' 场赛事，其中 ' + openCount + ' 场正在报名' +
      '（详情取到 ' + detailOk + ' 场，未取到 ' + detailFail + ' 场）');
    return items;
  },
};
