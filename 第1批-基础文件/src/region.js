// ============================================================
// "地区 / 参赛范围"识别器（2026-09-17 新增）
//
// 【这个文件解决什么问题】
//   网站上想显示"这场比赛的地区"，但三个数据源【都没有这个字段】。
//   2026-09-17 逐个接口查过，证据如下（字段名逐个列过，不是抽查）：
//     · 阿里天池   列表接口 46 个字段、详情接口 67 个字段 —— 没有任何
//                  region / area / city / province / addr 之类的字段；
//                  它的标签只有"方向"一类（tagType 全是 RACE：机器人、CV、
//                  医疗健康…），★ 没有"地区"这一类标签。
//     · 腾讯开悟   列表页内嵌数据 92 个字段、详情页 94 个字段 —— 也没有。
//     · 腾讯广告算法大赛  接口一共 4+4 个字段（名称 / 状态 / 起止时间）—— 更没有。
//   所以"去官网抓一个地区字段回来"这件事【做不到】—— 官网自己就没这个信息。
//
// 【那这个文件在干什么】
//   退一步：**只读官网自己写出来的话**，从标题和赛事介绍正文里，
//   把官网【明确写着】的地区 / 参赛范围原词抠出来，并且把
//   **这句话的原文一起带回去**（evidence），网页上会把它标出来给读者看。
//   ★ 也就是说：网页上显示的每一处"地区"，读者都能看到它是从哪句话来的。
//   ★ 认不出来的一律【不写】，显示"官网未公布"，绝不猜、绝不留白填词。
//
// 【为什么规则要写得这么严（这是踩过坑的）】
//   2026-09-17 实测：如果只按"文中出现地区词就算"，20 场正在报名的比赛里
//   有 17 场都能撞到词，但绝大多数是噪声，例如：
//     · "由上海交通大学主办"        → 出现"上海"，但那是主办单位所在地，不是参赛范围
//     · "中国中文信息学会"          → 出现"中国"，那是机构名的一部分
//     · "面向全球企业、高校、个人开发者" → 出现"全球"，这个是【真的】参赛范围
//   拿前两种当"地区"就是编数据，所以本文件：
//     ① 只有在【参赛范围语境】里出现的地区词才算（见 SCOPE_CUES）；
//     ② 地区词后面紧跟着机构后缀（学会/大学/公司…）的一律不算；
//     ③ 一个词在标题里出现且构成"全国XX大赛"这种结构，直接算。
//   宁可 20 场里只认出 5 场，也不认错 1 场 —— 这是给外人看的网站。
//
// 【输出的三个字段】（会写进 data/competitions.json）
//   region          识别出来的地区原词（例如 "全国" / "全球" / "川渝"）；认不出就是 null
//   region_evidence 官网原句（截断到 60 字以内），读者可以核对；认不出就是 null
//   region_where    这个词是从哪儿来的（'标题' / '赛事介绍' / '参赛资格'…），
//                   网页上会写"据官网标题"或"据官网赛事介绍"，让人知道该去哪核对
// ============================================================

// ---------- 地区 / 参赛范围词表 ----------
// ★ 顺序 = 优先级。一句话里同时出现多个词时，取最靠前的那个
//   （"全球"比"中国"更说明范围，所以排前面）。
const REGION_WORDS = [
  // 第一档：一眼就知道是"面向哪里的"范围词
  '全球', '国际', '世界', '亚太', '亚洲', '海内外', '海内外', '海外', '港澳台', '两岸',
  '全国', '中国', '国内',
  // 第二档：跨省的"区域"说法（真出现在比赛名里的就是它）
  '川渝', '长三角', '珠三角', '粤港澳', '京津冀', '成渝',
  '东北地区', '华北地区', '华东地区', '华南地区', '华中地区', '西南地区', '西北地区',
  // 第三档：省 / 自治区 / 直辖市 / 特别行政区（★ 这些容易和机构名撞车，所以要过 SCOPE_CUES）
  '北京', '天津', '上海', '重庆',
  '河北', '山西', '辽宁', '吉林', '黑龙江',
  '江苏', '浙江', '安徽', '福建', '江西', '山东', '河南', '湖北', '湖南',
  '广东', '海南', '四川', '贵州', '云南', '陕西', '甘肃', '青海', '台湾',
  '内蒙古', '广西', '西藏', '宁夏', '新疆', '香港', '澳门',
];

// 出现这些词，说明这句话是在讲"谁能参赛 / 面向谁"—— 只有这样才算数。
// ★ 2026-09-17 干跑踩坑记录：一开始这里放了"开放 / 邀请 / 凡 / 不限"这类词，
//   结果"技术开放日"、"腾讯北京总部大楼"全被当成地区。所以规矩改严了：
//   地区词必须【紧跟在】下面这些提示词后面（12 个字以内），才算数。
const SCOPE_CUES = [
  '面向', '参赛对象', '参赛资格', '报名对象', '报名资格', '参赛范围', '参赛要求',
  '欢迎', '均可参加', '均可报名', '不限', '来自',
];

// 提示词和地区词之间最多隔几个字（"参赛对象：全国高校在校学生"这种要算，
// 但"月24日在腾讯北京总部大楼"这种不算）
const CUE_WINDOW = 12;

// ★ 这些组合是"看着像地区、其实不是"的高频陷阱（2026-09-17 干跑实测抓到的）：
//   "真实世界的检验" → 世界      "腾讯北京总部大楼" → 北京      "北京站技术开放日" → 北京
const BAD_NEIGHBOR = {
  '世界': ['真实', '现实', '虚拟', '数字', '平行', '物理', '新', '全', '大千'],
  '中国': ['特色'],
};
// 地区词后面紧跟这些字，说明是在讲"办公地点 / 巡演站点"，不是在讲参赛范围
const VENUE_SUFFIX = ['站', '总部', '分部', '分公司', '基地', '园区', '大楼', '办公室'];

// 地区词后面紧跟这些字，说明它是某个机构名的一部分，不算地区。
const ORG_SUFFIX = [
  '学会', '协会', '大学', '学院', '学校', '中学', '公司', '集团', '科技',
  '研究院', '研究所', '组委会', '委员会', '基金会', '实验室', '中心', '银行',
  '政府', '电视台', '报社', '出版社', '网', '杯',
];

// 一句话最长保留多少字当证据
const MAX_EVIDENCE_CHARS = 60;

function clean(v) {
  if (typeof v !== 'string') return '';
  return v.replace(/[\u200b-\u200d\ufeff\u00a0]/g, ' ').replace(/\s+/g, ' ').trim();
}

// 把一段长正文切成句子（中文标点 + 换行都算断句）
function splitSentences(text) {
  return clean(text)
    .split(/[。；;！!？?\n\r]+/)
    .map(s => s.trim())
    .filter(s => s.length > 0);
}

// 把一个地区词从"是不是机构名的一部分"里排除掉
function looksLikeOrgName(sentence, word) {
  const i = sentence.indexOf(word);
  if (i < 0) return false;
  const after = sentence.slice(i + word.length, i + word.length + 4);
  for (const suf of ORG_SUFFIX) {
    if (after.indexOf(suf) === 0) return true;
  }
  return false;
}

// 是不是"办公地点 / 巡演站点"（北京站、腾讯北京总部、上海分公司…）
function looksLikeVenue(sentence, word) {
  const i = sentence.indexOf(word);
  if (i < 0) return false;
  const after = sentence.slice(i + word.length, i + word.length + 4);
  for (const suf of VENUE_SUFFIX) {
    if (after.indexOf(suf) === 0) return true;
  }
  return false;
}

// 前面是不是接了"真实 / 现实 / 虚拟"这类词（"真实世界的检验"里的"世界"不是地区）
function hasBadNeighbor(sentence, word) {
  const bad = BAD_NEIGHBOR[word];
  if (!bad) return false;
  const i = sentence.indexOf(word);
  if (i <= 0) return false;
  const before = sentence.slice(Math.max(0, i - 2), i);
  return bad.some(b => before.slice(-b.length) === b);
}

function cut(s) {
  return s.length > MAX_EVIDENCE_CHARS ? s.slice(0, MAX_EVIDENCE_CHARS) + '…' : s;
}

// 取"证据"：短句就整句给；长句（天池的正文经常一整段不带句号）就围着关键词截一段，
// 保证读者看到的证据里一定含那个地区词和它前面的提示词（例如"参赛要求 国内高等院校…"）。
function evidenceAround(sentence, index, wordLen) {
  if (sentence.length <= MAX_EVIDENCE_CHARS) return sentence;
  const start = Math.max(0, index - 10);
  let end = Math.min(sentence.length, index + wordLen + 24);
  // 从提示词前面开始截，但如果这样超过长度上限，就往前压缩
  const from = Math.max(start, 0, end - MAX_EVIDENCE_CHARS);
  if (end - from > MAX_EVIDENCE_CHARS) end = from + MAX_EVIDENCE_CHARS;
  return (from > 0 ? '…' : '') + sentence.slice(from, end) + (end < sentence.length ? '…' : '');
}

// 在一段文字里找地区词；★ 必须"紧跟在参赛范围提示词后面"才算
function scanText(text, where) {
  const sentences = splitSentences(text);
  for (const word of REGION_WORDS) {
    for (const s of sentences) {
      const i = s.indexOf(word);
      if (i < 0) continue;
      if (looksLikeOrgName(s, word)) continue;
      if (looksLikeVenue(s, word)) continue;
      if (hasBadNeighbor(s, word)) continue;
      const before = s.slice(Math.max(0, i - CUE_WINDOW), i);
      if (!SCOPE_CUES.some(c => before.indexOf(c) >= 0)) continue;
      return { region: word, evidence: evidenceAround(s, i, word.length), where: where };
    }
  }
  return null;
}

// 标题里出现"全国/全球/国际/世界 + 大赛/挑战赛/竞赛/公开赛"这种结构 —— 直接算，
// 因为这种写法本身就是比赛名的一部分（例如"第十四届全国社会媒体处理大会-…挑战赛"）。
const TITLE_STRONG = ['全球', '国际', '世界', '全国', '亚太', '亚洲', '海内外', '海外', '港澳台', '两岸'];
const TITLE_EVENT = ['大赛', '挑战赛', '竞赛', '公开赛', '比赛', '赛事', '测评', '联赛', '争霸赛', '黑客马拉松'];
const TITLE_REGION = ['川渝', '长三角', '珠三角', '粤港澳', '京津冀', '成渝'];

function scanTitle(title) {
  const t = clean(title);
  if (!t) return null;
  for (const word of TITLE_STRONG.concat(TITLE_REGION)) {
    if (t.indexOf(word) < 0) continue;
    // "中国XX学会主办的比赛"这种，标题里有地区词但它其实是机构名 —— 不算
    if (looksLikeOrgName(t, word)) continue;
    if (looksLikeVenue(t, word)) continue;
    if (hasBadNeighbor(t, word)) continue;
    // 必须同时是个"比赛名"的样子，否则可能是"中国XX学会主办的比赛"这种
    if (!TITLE_EVENT.some(e => t.indexOf(e) >= 0)) continue;
    return { region: word, evidence: cut(t), where: '标题' };
  }
  // 省份名在标题里出现：只认"XX省/XX市/XX区"这种带行政后缀的写法，
  // 避免"上海交通大学…挑战赛"被当成上海地区赛。
  for (const word of REGION_WORDS) {
    const re = new RegExp(word + '(省|市|自治区|特别行政区|地区)');
    if (re.test(t)) return { region: word, evidence: cut(t), where: '标题' };
  }
  return null;
}

// ---------- 对外入口 ----------
// 传一条"已经统一成同一种格式"的赛事记录，返回地区识别结果。
// ★ 只读官网自己写出来的东西：标题、副标题、摘要、赛事介绍/规则正文、赛道的参赛资格。
function findRegion(record) {
  if (!record || typeof record !== 'object') return null;

  // 1) 标题（最可靠：比赛名里写着"全国/国际"就是它）
  const fromTitle = scanTitle(record.title);
  if (fromTitle) return fromTitle;

  // 2) 副标题
  const fromSub = record.sub_title ? scanTitle(record.sub_title) : null;
  if (fromSub) return fromSub;

  // 3) 赛事介绍 / 规则正文（sections 是各数据源正文统一成的同一形状）
  const sections = Array.isArray(record.sections) ? record.sections : [];
  for (const s of sections) {
    const title = clean(s && s.title);
    const hit = scanText(clean(s && s.content), title ? '赛事介绍「' + title + '」' : '赛事介绍');
    if (hit) return hit;
  }

  // 4) 摘要
  const fromSummary = scanText(clean(record.summary), '赛事摘要');
  if (fromSummary) return fromSummary;

  // 5) 赛道里的"参赛资格 / 报名方式"（腾讯开悟这块有）
  const tracks = Array.isArray(record.tracks) ? record.tracks : [];
  for (const t of tracks) {
    const tname = clean(t && t.title);
    const hit = scanText(clean(t && t.requirement), tname ? '参赛资格「' + tname + '」' : '参赛资格');
    if (hit) return hit;
  }

  // 认不出来就是认不出来 —— 绝不猜。
  return null;
}

module.exports = { findRegion, REGION_WORDS };
