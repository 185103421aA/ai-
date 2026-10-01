// ============================================================
// "比赛形式 / 比赛地点"识别器（2026-09-17 第四轮新增）
//
// 【这个文件解决什么问题】
//   用户说："官网上面有写地址的，比如初赛是线上、决赛是在线下上海这种，你也写进去；
//   展示的界面上只写"只有线上 / 线上线下都有 / 只有线下"；另外把比赛地点也加在主界面上，
//   用标签的形式展现。"
//
//   和"地区"那一轮一样：**三个数据源的接口里都没有这个字段**。
//   2026-09-17 复查过三个 collector 的取字段代码（src/collectors/*.js 里
//   没有任何 city / address / location / venue / 地点 / 城市 的读取），
//   所以"去接口里抓一个地点字段"是做不到的。
//
//   但是 —— 这一轮和"地区"那一轮不一样的地方在于：
//   **官网正文里确实写着**，而且是原话。实测抓到的原文例如：
//     · "本次大赛分为线上初赛和线下决赛两个阶段"          （蚂蚁灵波具身大模型挑战赛）
//     · "11 月 13 日 — 11月15日：上海线下决赛"            （同一场，地点写得明明白白）
//     · "将于2026年11月12日至15日在北京召开"              （2026 SMP 全国社会媒体处理大会）
//     · "线下路演 2026年10月 决赛采取现场答辩的评审方式"   （CSIG 图像图形技术挑战赛）
//   所以这个文件做的事是：**把官网自己写出来的"比赛怎么办、在哪儿办"读出来，
//   连同原句一起存下来**，认不出就留空 —— 绝不猜。
//
// 【为什么规则要写得这么严（这一轮踩的坑比"地区"还多）】
//   实测拿 28 条记录全量扫了一遍城市名，结果绝大多数**根本不是比赛地点**：
//     · "以下时间均为北京时间（GMT+8）"      → 这是**时区**，不是地点（出现 6 次以上）
//     · "杭州宇树科技有限公司"                → 公司名
//     · "成都市委人才办" / "重庆市教育委员会"  → 政府机构
//     · "北部区域赛：北京、天津、山东、河北…"  → 这是**区域赛覆盖的省份列表**，不是赛场
//     · "C 类:创响无锡类"                     → 比赛分类名
//     · "上海银行间同业拆放利率（Shibor）"     → 金融指数名
//     · "腾讯北京总部大楼" / "北京站·秋"       → 办公地点 / 巡演站（region.js 也排除这类）
//   如果不加约束地"见到城市名就当地点"，28 条里会有一大半是错的。
//   所以本文件的规矩是：**城市名必须直接贴在"举办/召开/线下/决赛/答辩/路演"这类
//   强地点词旁边才算**，隔了一层的一律不算。
//
// 【输出的四个字段】（会写进 data/competitions.json）
//   venue_form      比赛形式，只有三个值：'线上' / '线上线下' / '线下'；认不出就是 null
//   venue_city      比赛地点（城市名，例如 '上海'）；认不出就是 null
//   venue_where     从官网哪一部分认出来的（'赛事介绍「赛程赛制」' 这种）
//   venue_evidence  官网原句（≤60 字），页面上会摆出来让读者核对
//
// ★ 一个原则：形式（线上/线下）和地点（城市）是**分开认的**，一个认出另一个可以没有。
//   例如"线上大模型API服务"那种不算形式；而一场纯线上的比赛地点本来就是空的。
// ============================================================

// ---------- 一、比赛形式（线上 / 线下 / 线上线下） ----------

// ★★ 2026-09-17 用户拍板："第一个，出现什么就写什么，比如只出现了到场答辩就写线下，2 同理，写线上。"
//    背景：有些比赛官网**从头到尾不写"线上/线下"这四个字**，但它写了别的、同样说明形式的词。
//    当时的两个例子：
//      · 2026-具身仿真合成挑战赛 / 2026-跨本体具身认知极限联合挑战赛
//        —— 全篇只有"| 决赛 | 现场答辩，…… |"，从没写过"线下"。
//      · CHIP2026-面向生物医学全文的特定患者表型概念识别任务
//        —— 全篇只有"需在线提交预测结果""在线提交评测结果"，从没写过"线上"。
//    原来我把这两种都留空（因为不是原文那两个字），用户看过之后明确要求：**照写**。
//    所以就按"官网出现了哪种说法，就归到哪一边"来判 —— 下面这两张表就是那些说法。
//
// 【为什么不用"见'现场'就算线下"】实测反例（全库扫出来的，不是假想）：
//    · "活动结束后，广小鹅将释放**现场花絮**📹" —— 这是活动花絮，不是比赛形式
//    · "完成模型适配、**现场调试**、真机推理"      —— 这是调机器人，不是"比赛在线下办"
//   "在线"同理："在校学生可点此完成**在线大学生认证**"、"必须来源于阿里云**云端产品**体系"
//   都不是比赛形式。所以这两张表里**只放明确描述比赛/答辩/提交形式的词**，不放单字"现场/在线"。
const ONLINE_ALT = [
  '在线提交', '在线上传', '线上提交', '网上提交', '远程提交',
  '在线参赛', '在线比赛', '在线评测', '在线答辩', '在线评审', '在线完成',
  '线上完成', '线上参赛', '线上比赛', '远程参赛', '远程答辩',
];
const OFFLINE_ALT = [
  '现场答辩', '到场答辩', '现场比赛', '现场决赛', '现场评审', '现场路演',
  '现场参赛', '现场签到', '到场参赛', '到场比赛', '现场比拼', '现场展示',
];

// 在一句话里找"替代说法"，返回 {phrase, index}
function altHit(sentence, list) {
  for (const p of list) {
    const i = sentence.indexOf(p);
    if (i >= 0) return { phrase: p, index: i };
  }
  return null;
}

// 线上/线下后面紧跟这些词，才是在讲"比赛怎么办"
// ★ 必须是"紧跟"，因为"线上大模型API服务"里的"线上"是在讲一个接口，不是讲比赛形式。
const FORM_TARGETS = [
  '初赛', '决赛', '复赛', '半决赛', '总决赛', '选拔赛', '挑战赛', '竞赛', '大赛',
  '赛', '阶段', '环节', '评审', '答辩', '路演', '提交', '参赛', '报名', '举行',
  '举办', '进行', '开展', '颁奖', '黑客马拉松', '空间', '签到', '参与', '测试',
  '评测', '比拼', '竞技', '会场', '同步', '完成', '结合',
];

// 线上后面紧跟这些词，说明它修饰的是"一个系统/接口/服务"，不是比赛形式 —— 排除
const ONLINE_NOT_FORM = [
  '大模型', '模型', 'API', 'api', '服务', '平台', '系统', '工具', '课程',
  '会议', '直播', '渠道', '商城', '训练', '推理', '环境', '文档', '资料',
];

// 判断一句话里有没有"合格的线上/线下"提法
// ★ 2026-09-17 全库逐处核对抓到的漏判：
//   "由线上初赛和【线下真机黑客马拉松】两个阶段组成" —— "线下"后面紧跟的是"真机"，
//   不是形式词，原来这种写法被漏掉了。所以改成：**允许中间隔最多 4 个字**再出现形式词，
//   但"线上/线下"后面如果先出现了 ONLINE_NOT_FORM 里的词，就直接否掉。
const FORM_WINDOW = 4;
// 取"后面这一段"时要够长：窗口 4 个字 + 最长的形式词（"黑客马拉松"/"真机黑客马拉松"）都不止 6 个字。
const FORM_LOOKAHEAD = 16;

function formHitInSentence(sentence, word) {
  let idx = sentence.indexOf(word);
  while (idx >= 0) {
    // “在线上传”包含连续字符“线上”，但它不是字面“线上”一词；
    // 它会由 ONLINE_ALT 的“在线上传”作为线上替代表述处理。
    if (word === '线上' && idx > 0 && sentence[idx - 1] === '在') {
      idx = sentence.indexOf(word, idx + 1);
      continue;
    }
    const after = sentence.slice(idx + word.length, idx + word.length + FORM_LOOKAHEAD);
    // 先看有没有"这不是比赛形式"的坏词挡在前面
    let badAt = -1;
    if (word === '线上') {
      for (const b of ONLINE_NOT_FORM) {
        const p = after.indexOf(b);
        if (p >= 0 && (badAt < 0 || p < badAt)) badAt = p;
      }
    }
    // 再看 4 个字窗口内有没有形式词
    for (let gap = 0; gap <= FORM_WINDOW; gap++) {
      if (badAt >= 0 && gap > badAt) break;            // 坏词在前面 → 不算
      const rest = after.slice(gap);
      if (FORM_TARGETS.some(t => rest.indexOf(t) === 0)) return idx;
    }
    idx = sentence.indexOf(word, idx + 1);
  }
  return -1;
}

// ---------- 二、比赛地点（城市） ----------

// 直辖市 + 省会 + 计划单列市 + 常见办赛城市
const VENUE_CITIES = [
  '北京', '上海', '天津', '重庆',
  '广州', '深圳', '杭州', '南京', '武汉', '成都', '西安', '苏州', '合肥', '长沙',
  '青岛', '厦门', '郑州', '济南', '福州', '大连', '宁波', '无锡', '珠海', '东莞',
  '佛山', '沈阳', '哈尔滨', '昆明', '贵阳', '南昌', '太原', '石家庄', '兰州',
  '乌鲁木齐', '呼和浩特', '南宁', '海口', '长春', '银川', '西宁', '拉萨',
  '嘉兴', '绍兴', '温州', '常州', '南通', '徐州', '烟台', '潍坊', '泉州', '惠州',
  '中山', '江门', '柳州', '桂林', '洛阳', '绵阳', '德阳', '宜宾', '芜湖', '株洲',
];

// 城市名后面紧跟这些，说明它是【机构 / 政府 / 时区 / 站点】的一部分，不是比赛地点
// ★ 这一条是这一轮的关键：没有它，"北京时间""成都市委人才办""杭州宇树科技有限公司"
//   全会被当成长比赛地点。
const CITY_BAD_AFTER = [
  // 机构
  '大学', '学院', '学校', '中学', '公司', '集团', '科技', '研究院', '研究所',
  '实验室', '学会', '协会', '中心', '委员会', '基金会', '银行', '医院', '出版社',
  '报社', '电视台', '园区', '基地', '总部', '分部', '分公司', '办公室',
  // 政府
  '市', '省', '区', '县', '委', '政府', '局', '厅', '办', '管委会', '人才办',
  // 时区 / 时间
  '时间',
  // 巡演站（region.js 也排除"站"）
  '站',
];

// 城市名【后面紧跟】这些词，才算"这是比赛地点"
const CITY_STRONG_AFTER = [
  '线下', '现场', '召开', '举行', '举办', '开赛', '决赛', '复赛', '初赛',
  '答辩', '路演', '颁奖', '会场', '赛场', '比赛', '参赛', '进行', '开展',
  '签到', '收官', '落幕', '启动', '开营', '举办地',
];

// 城市名【前面紧跟】这些词，才算"这是比赛地点"
// ★ 用"在/于 + 时间 + 城市"这种写法也算（"将于2026年11月12日至15日在北京召开"）。
const CITY_STRONG_BEFORE = ['在', '于', '地点', '地点：', '地点:', '城市', '地址'];

// 城市名前面是这些机构词尾的，是机构名的一部分 —— 排除（"上海人工智能实验室"）
const CITY_BAD_BEFORE = ['腾讯', '华为', '阿里', '百度', '字节', '有方（', '（', '(', '新浪', '网易'];

// 判断某个城市名在句子里是不是"真的比赛地点"
function cityHitInSentence(sentence, city) {
  let idx = sentence.indexOf(city);
  while (idx >= 0) {
    const after = sentence.slice(idx + city.length, idx + city.length + 4);
    const before = sentence.slice(Math.max(0, idx - 8), idx);

    const badAfter = CITY_BAD_AFTER.some(b => after.indexOf(b) === 0);
    const badBefore = CITY_BAD_BEFORE.some(b => before.endsWith(b));
    if (!badAfter && !badBefore) {
      const strongAfter = CITY_STRONG_AFTER.some(t => after.indexOf(t) === 0);
      // 前面必须紧挨着"在/于/地点"，且中间不能夹别的字（"在腾讯北京总部"已经被上面的规则挡掉了）
      const strongBefore = CITY_STRONG_BEFORE.some(t => before.endsWith(t));
      if (strongAfter || strongBefore) return idx;
    }
    idx = sentence.indexOf(city, idx + 1);
  }
  return -1;
}

// ---------- 三、公共小工具（与 region.js 同一套写法） ----------

const MAX_EVIDENCE_CHARS = 60;

function clean(v) {
  if (typeof v !== 'string') return '';
  return v.replace(/[\u200b-\u200d\ufeff\u00a0]/g, ' ').replace(/\s+/g, ' ').trim();
}

function splitSentences(text) {
  if (typeof text !== 'string') return [];
  return text
    .replace(/[\u200b-\u200d\ufeff\u00a0]/g, ' ')
    // 先切分官网正文原有的换行，再做空白归一化；否则整段正文会变成一句，
    // 证据截断时可能只留下“在线上传”而丢掉另一侧的“现场答辩”。
    .split(/[。；;！!？?\n\r]+/)
    .map(s => clean(s))
    .filter(s => s.length > 0);
}

function cut(s) {
  return s.length > MAX_EVIDENCE_CHARS ? s.slice(0, MAX_EVIDENCE_CHARS) + '…' : s;
}

// 取证据：短句整句给；长句围着关键词截一段，保证证据里一定含那个词
function evidenceAround(sentence, index, wordLen) {
  if (sentence.length <= MAX_EVIDENCE_CHARS) return sentence;
  const start = Math.max(0, index - 12);
  let end = Math.min(sentence.length, index + wordLen + 26);
  const from = Math.max(start, 0, end - MAX_EVIDENCE_CHARS);
  if (end - from > MAX_EVIDENCE_CHARS) end = from + MAX_EVIDENCE_CHARS;
  return (from > 0 ? '…' : '') + sentence.slice(from, end) + (end < sentence.length ? '…' : '');
}

// 把一条记录里"官网自己写的正文"按优先级摊平成 [{text, where}]，
// 顺序和 region.js 保持一致：先标题，再正文，再摘要，最后赛道资格。
function collectTexts(record) {
  const out = [];
  const push = (text, where) => {
    if (typeof text !== 'string') return;
    // 形式识别需要利用官网正文的换行作为句子边界；这里不能调用会压平换行的 clean。
    const t = text.replace(/[\u200b-\u200d\ufeff\u00a0]/g, ' ').trim();
    if (t) out.push({ text: t, where });
  };

  push(record.title, '标题');
  push(record.sub_title, '副标题');

  const sections = Array.isArray(record.sections) ? record.sections : [];
  for (const s of sections) {
    const title = clean(s && s.title);
    push(s && s.content, title ? '赛事介绍「' + title + '」' : '赛事介绍');
  }

  push(record.summary, '赛事摘要');

  const tracks = Array.isArray(record.tracks) ? record.tracks : [];
  for (const t of tracks) {
    const tname = clean(t && t.title);
    push(t && t.requirement, tname ? '参赛资格「' + tname + '」' : '参赛资格');
  }

  return out;
}

// ---------- 四、对外入口 ----------

// 比赛形式：把整条记录扫一遍，看"合格的线上"和"合格的线下"各有没有出现过。
// ★ 两边都有 = 线上线下（这就是用户说的"初赛线上、决赛线下"那种）；
//   只有一边 = 那一侧；都没有 = null（页面上写"官网未公布"）。
function findVenueForm(record) {
  if (!record || typeof record !== 'object') return null;
  const texts = collectTexts(record);

  // ★ 四条槽分开记：字面说法（"线上/线下"）和替代说法（"现场答辩/在线提交"）**分开存**，
  //   最后【字面优先】。为什么：替代说法往往是旁枝末节的句子，例如
  //     "交互式 Demo：需要在比赛现场展示可运行的 Demo…"（欧莱雅）
  //     "1. 方案综述材料一份（PPT格式），用作现场展示。"（CSIG）
  //   而字面说法那句才是真正说明赛制的：
  //     "线下决赛共计 14 支队伍"、"5. 线下路演 … 决赛采取现场答辩的评审方式"
  //   如果混在一起取"第一句碰上的"，读者看到的证据就会变得又长又弱。
  let onLit = null, offLit = null, onAlt = null, offAlt = null, bothLit = null, bothAny = null;

  for (const { text, where } of texts) {
    for (const s of splitSentences(text)) {
      const iOn = formHitInSentence(s, '线上');
      const iOff = formHitInSentence(s, '线下');
      const aOn = altHit(s, ONLINE_ALT);
      const aOff = altHit(s, OFFLINE_ALT);
      const litOn = iOn >= 0, litOff = iOff >= 0;
      const anyOn = litOn || !!aOn, anyOff = litOff || !!aOff;

      if (litOn && litOff && !bothLit) {
        bothLit = { where, evidence: evidenceAround(s, Math.min(iOn, iOff), 6) };
      }
      if (anyOn && anyOff && !bothAny) {
        const pos = Math.min(litOn ? iOn : aOn.index, litOff ? iOff : aOff.index);
        bothAny = { where, evidence: evidenceAround(s, pos, 6) };
      }
      if (litOn && !onLit) onLit = { where, evidence: evidenceAround(s, iOn, 2) };
      if (litOff && !offLit) offLit = { where, evidence: evidenceAround(s, iOff, 2) };
      if (aOn && !onAlt) onAlt = { where, evidence: evidenceAround(s, aOn.index, aOn.phrase.length) };
      if (aOff && !offAlt) offAlt = { where, evidence: evidenceAround(s, aOff.index, aOff.phrase.length) };
    }
  }

  const online = onLit || onAlt;      // 线上那一边：字面优先，没有再退回替代说法
  const offline = offLit || offAlt;   // 线下那一边：同上
  if (!online && !offline) return null;

  if (online && offline) {
    // 两边都有 = 线上线下。
    // 证据优先用"一句话里两边都写了"的那种（"分为线上初赛和线下决赛两个阶段"）；
    // 如果两边分散在两句话里，就把两句都摆出来（中间用 ／ 隔开）——
    // ★ 必须两句都摆：自检要求"写了线上线下，证据里就得两边都有依据"。
    if (bothLit) return { form: '线上线下', where: bothLit.where, evidence: bothLit.evidence };
    if (bothAny) return { form: '线上线下', where: bothAny.where, evidence: bothAny.evidence };
    return {
      form: '线上线下',
      where: online.where,
      // 两边出现在不同句子时不能从头硬截断，否则常会把后一边的关键词截掉，
      // 造成“线上线下”标签有值、证据却只剩一边。每段各保留一份完整的短证据。
      evidence: online.evidence + ' ／ ' + offline.evidence,
    };
  }
  const one = online || offline;
  return { form: online ? '线上' : '线下', where: one.where, evidence: one.evidence };
}

// 比赛地点：城市名必须紧贴"举办/召开/线下/决赛/答辩/路演"这类强地点词才算
function findVenueCity(record) {
  if (!record || typeof record !== 'object') return null;
  const texts = collectTexts(record);

  // ★ 先扫正文（sections），再扫标题/摘要 —— 地点几乎都写在"赛程赛制"正文里，
  //   标题里出现的城市多半是机构名（"上海交通大学…挑战赛"）。
  const ordered = texts.slice().sort((a, b) => (a.where === '标题' ? 1 : 0) - (b.where === '标题' ? 1 : 0));

  for (const { text, where } of ordered) {
    for (const s of splitSentences(text)) {
      for (const city of VENUE_CITIES) {
        const i = cityHitInSentence(s, city);
        if (i >= 0) return { city, where, evidence: evidenceAround(s, i, city.length) };
      }
    }
  }
  return null;
}

// 一次把四件事都认出来（collect.js 调这个）
// ★ 「形式」和「地点」各自留一份证据和出处 —— 不能共用一份。
//   2026-09-17 实测踩到的：蚂蚁灵波那场，形式是从"本次大赛分为线上初赛和线下决赛两个阶段"
//   认出来的，而地点"上海"在【另一句】"11月13日—11月15日：上海线下决赛"里。
//   如果只留一份证据却拿它去证明两件事，就会出现"地点=上海，但证据里没有上海"——
//   那正是自检里"证据对不上"要拦的东西。所以拆成两份。
function findVenue(record) {
  const form = findVenueForm(record);
  const city = findVenueCity(record);
  if (!form && !city) return null;
  return {
    form: form ? form.form : null,
    formWhere: form ? form.where : null,
    formEvidence: form ? form.evidence : null,
    city: city ? city.city : null,
    cityWhere: city ? city.where : null,
    cityEvidence: city ? city.evidence : null,
  };
}

module.exports = {
  findVenue, findVenueForm, findVenueCity, formHitInSentence,
  VENUE_CITIES, ONLINE_ALT, OFFLINE_ALT,
};
