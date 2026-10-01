// ============================================================
// 数据源积木块 8：和鲸 Heywhale 数据科学竞赛平台
//
// 接口均为 2026-09-20 实地从官网前端 Network 核验后使用：
//   列表：GET /v2/api/competitionsCommunity
//   详情：GET /v2/api/competitions/{competition_id}
//
// 只取官网比赛列表中 Status=1 的当前赛事；系列赛外壳没有独立详情，跳过。
// 比赛 Status 和报名 RegisterEndDate 分开处理。不采集榜单、队伍、个人和提交记录。
// ============================================================

const SITE = 'https://www.heywhale.com';
const LIST_API = SITE + '/v2/api/competitionsCommunity';
const DETAIL_API = SITE + '/v2/api/competitions/';

const PAGE_SIZE = 100;
const CURRENT_STATUS = 1; // 官网前端：进行中
const MAX_DETAIL_FETCH = 80;
const DELAY_BETWEEN_REQUESTS_MS = 700;
const MAX_SECTION_CHARS = 2800;

const DETAIL_TYPE_NAMES = {
  ALGORITHM: '算法赛',
  DATA_ANALYSIS: '数据分析赛',
  SCHEME: '方案/计划类赛事',
  EXERCISE: '练习赛',
  WORKSHOP: '工作坊',
  TRAINING_CAMP: '训练营',
  LIVE: '直播活动',
  OTHER: '其他',
};

const HEADERS = {
  accept: 'application/json, text/plain, */*',
  'accept-language': 'zh-CN,zh;q=0.9',
  referer: SITE + '/home/competition',
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
}

function parseDate(value) {
  const text = cleanStr(value);
  if (!text) return null;
  const date = new Date(text);
  return isNaN(date.getTime()) ? null : date;
}

function isoDate(value) {
  const date = parseDate(value);
  return date ? date.toISOString() : null;
}

function section(title, content, sort) {
  const text = cleanText(content);
  if (!text) return null;
  return {
    section_type: 'heywhale',
    code: 'heywhale-' + sort,
    title,
    content: text.slice(0, MAX_SECTION_CHARS),
    sort,
  };
}

function buildSections(detail) {
  const tabs = Array.isArray(detail && detail.Tabs) ? detail.Tabs : [];
  const sections = tabs
    .filter(tab => {
      const title = cleanStr(tab && tab.Title) || '';
      return title && !/(榜单|排行榜|成绩榜单|队伍|团队|个人提交|提交记录)/.test(title);
    })
    .map((tab, index) => section(cleanStr(tab.Title) || ('赛事说明 ' + (index + 1)), tab.Content, index))
    .filter(Boolean);

  const stages = (Array.isArray(detail && detail.Stages) ? detail.Stages : [])
    .map(stage => {
      const name = cleanStr(stage && stage.Name);
      const start = cleanStr(stage && stage.StartDate);
      return name ? name + (start ? '：' + start : '') : null;
    })
    .filter(Boolean);
  if (stages.length) {
    sections.push(section('赛程阶段', stages.join('\n'), sections.length));
  }
  return sections;
}

function statusText(status) {
  return ({ 0: '未开始', 1: '进行中', 2: '已结束' })[Number(status)] || '官网未说明';
}

function registrationState(listed, detail, now) {
  const end = parseDate((detail && detail.RegisterEndDate) || (listed && listed.RegisterEndDate));
  if (end && now > end) return { state: 'closed', text: '报名已截止', days: 0 };
  if (end && now <= end) return { state: 'open', text: '正在报名', days: Math.max(0, Math.ceil((end - now) / 86400000)) };
  return { state: 'unknown', text: '官网未公布报名截止时间', days: null };
}

async function getJson(url, label) {
  let lastError = null;
  for (let attempt = 1; attempt <= 2; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 20000);
    try {
      const response = await fetch(url, { headers: HEADERS, signal: controller.signal });
      const text = await response.text();
      let json;
      try {
        json = JSON.parse(text);
      } catch (error) {
        throw new Error('返回的不是合法 JSON：' + error.message);
      }
      if (!response.ok) throw new Error('HTTP ' + response.status);
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
      perPage: String(PAGE_SIZE),
      page: String(page),
      CompetitionEventType: '1',
      Status: String(CURRENT_STATUS),
    });
    const json = await getJson(LIST_API + '?' + query.toString(), '和鲸赛事列表');
    if (!json || !Array.isArray(json.data)) throw new Error('列表返回结构变化：没有 data');
    total = Number(json.totalNum) || total;
    all.push(...json.data);
    if (all.length >= total || json.data.length < PAGE_SIZE) break;
    page++;
  }
  return all;
}

function normalize(listed, detail, now) {
  const source = detail || listed || {};
  const id = cleanStr(listed && (listed._id || listed.id)) || cleanStr(source._id || source.id);
  const title = cleanStr(source.Name || listed.Name) || ('赛事 ' + (id || '未知'));
  const detailType = cleanStr(source.DetailType || listed.DetailType);
  const typeName = DETAIL_TYPE_NAMES[detailType] || (detailType ? '官网类型：' + detailType : '官网未说明类型');
  const pageUrl = SITE + '/home/competition/' + encodeURIComponent(id) + '/content';
  const registration = registrationState(listed, detail, now);
  const award = cleanStr(source.DisplayLabel || listed.DisplayLabel || source.Award || listed.Award);
  const notes = [
    '本条数据来自和鲸 Heywhale 官网公开列表与详情接口；详情正文按官网栏目整理并截断，完整内容请查看官网赛事页。',
    '本站只读取官网 Status=1 的进行中赛事；Status 只表示比赛阶段，报名状态另按官网 RegisterEndDate 判断。',
    '和鲸列表中的系列赛外壳/外部落地页没有独立完整赛事详情，本站按规则跳过，不把关联赛事数组当作独立赛事。',
    '官网奖励字段原样保留，不做人民币换算或单位猜测；Stages 是赛程阶段，不是赛道。',
    '本站不采集排行榜、队伍、个人信息和提交结果记录。',
  ];
  if (!detail) notes.push('这场赛事的详情资料本次没有取到，因此卡片保留列表字段；完整规则请点按钮去官网查看。');

  return {
    id: 'heywhale:' + id,
    source_id: 'heywhale',
    source_name: '和鲸 Heywhale',
    source_url: SITE + '/home/competition',
    code: id,

    title,
    title_en: null,
    sub_title: cleanStr(source.ShortDescription || listed.ShortDescription),
    organizer: '和鲸 Heywhale 数据科学竞赛平台（具体主办方见官网赛事页）',
    official_page_url: pageUrl,
    register_url: pageUrl,

    register_start: null,
    register_end: isoDate(source.RegisterEndDate || listed.RegisterEndDate),
    competition_start: isoDate(source.StartDate || listed.StartDate),
    competition_end: isoDate(source.EndDate || listed.EndDate),
    official_status: source.Status === undefined || source.Status === null ? String(CURRENT_STATUS) : String(source.Status),
    official_status_text: statusText(source.Status === undefined ? CURRENT_STATUS : source.Status),
    register_state: registration.state,
    register_state_text: registration.text,
    days_left: registration.days,

    tag: typeName,
    competition_type: 'open',
    prize_pool: award,
    summary: null,
    track_count: 0,
    tracks: [],
    sections: buildSections(detail),
    updated_at: null,
    detail_fetch_ok: Boolean(detail),
    data_notes: notes,
  };
}

module.exports = {
  sourceId: 'heywhale',
  sourceName: '和鲸 Heywhale',

  async collect({ log }) {
    const now = new Date();
    log('  正在读取和鲸官网标注为“进行中”的赛事列表...');
    const listed = await fetchList();
    const candidates = listed.filter(item => !(item && item.IsSeriesCompetition));
    const skippedSeries = listed.length - candidates.length;
    log('  → 官网当前列表返回 ' + listed.length + ' 条，其中 ' + candidates.length + ' 条有独立赛事详情');
    if (skippedSeries) log('  → 略过 ' + skippedSeries + ' 个系列赛外壳/外部落地页');

    const items = [];
    let detailOk = 0;
    let detailFail = 0;
    const fetchCount = Math.min(candidates.length, MAX_DETAIL_FETCH);
    for (let i = 0; i < fetchCount; i++) {
      const listedItem = candidates[i];
      const id = cleanStr(listedItem && (listedItem._id || listedItem.id));
      log('  [' + (i + 1) + '/' + fetchCount + '] ' + (cleanStr(listedItem && listedItem.Name) || ('赛事 ' + id)).slice(0, 42));
      if (i) await sleep(DELAY_BETWEEN_REQUESTS_MS);

      let detail = null;
      try {
        const json = await getJson(DETAIL_API + encodeURIComponent(id), '赛事详情 ' + id);
        detail = json && json._id ? json : null;
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
