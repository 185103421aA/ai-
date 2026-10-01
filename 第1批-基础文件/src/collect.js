// 采集入口：把各个"数据源积木块"跑一遍，结果统一存进 data/competitions.json
// 将来要加新网站（比如腾讯广告算法大赛），只需在 collectors 目录里加一块，
// 然后在下方的 collectors 数组里加一行即可，其它代码不用动。
//
// ★ 2026-09-11 新增两道"安全闸"（修改原因见交接单第三版 C5 / 第四版 B0，
//   改之前已经用"副本 + 故障注入"实测复现过：官网连不上时会把 5 条好数据
//   和好网页一起弄成空壳，而且没有备份可退）：
//
//   闸一【覆盖前先备份】：写数据文件之前，先把旧的那份复制到 data\_backup\，
//        文件名带日期时间，只留最近几份。"能退回"从一句空话变成真的。
//   闸二【采不到就不许覆盖】：一条竞赛都没采到时（凌晨断网、官网改版都算），
//        【绝不覆盖】已有的数据和网页，保留上一次的好数据，并在网页顶部写明
//        "最近一次采集没成功，以下仍是上一次的数据（采集于 X 月 X 日）"。
//   半失败（只有一个数据源失败）时：失败那个源上一次采到的条目原样留着，
//       并在卡片上标明"这条是上次的数据"，不让它无声消失。
//   另外：半失败时【不再】让程序谎报"采集成功"（退出码/日志都要说实话）。
const fs = require('fs');
const path = require('path');
const { randomUUID } = require('crypto');

const tencentArena = require('./collectors/tencent-arena.js');
const tencentAdAlgo = require('./collectors/tencent-ad-algo.js');
const tianchi = require('./collectors/tianchi.js');
const datafountain = require('./collectors/datafountain.js');
const iflytek = require('./collectors/iflytek.js');
const huaweiCloud = require('./collectors/huawei-cloud.js');
const paddleAiStudio = require('./collectors/paddle-ai-studio.js');
const heywhale = require('./collectors/heywhale.js');
const { build } = require('./build.js');
const { writeStatus } = require('./collect-status.js');
const { findRegion } = require('./region.js');
const { findVenue } = require('./venue.js');

const collectors = [
  tencentArena,
  tencentAdAlgo,
  tianchi,
  datafountain,
  iflytek,
  huaweiCloud,
  paddleAiStudio,
  heywhale,
  // 以后加新数据源：require('./collectors/xxx.js'),
];

const OUT_DIR = path.join(__dirname, '..', 'data');
const OUT_FILE = path.join(OUT_DIR, 'competitions.json');
const LOCK_FILE = path.join(OUT_DIR, '.collect.lock');

// 备份目录：覆盖数据文件之前，旧的那份先复制到这里
const BACKUP_DIR = path.join(OUT_DIR, '_backup');
const KEEP_BACKUPS = 5; // 只保留最近 5 份，避免越积越多

function log(msg) {
  console.log(msg);
}

// 把时间做成能当文件名的样子，例如 20260911-120709（本机时间）
function fileStamp(d = new Date()) {
  const p = n => String(n).padStart(2, '0');
  return String(d.getFullYear()) + p(d.getMonth() + 1) + p(d.getDate()) + '-' +
         p(d.getHours()) + p(d.getMinutes()) + p(d.getSeconds());
}

// 【闸一】覆盖前先备份。
// 返回值：备份文件名（成功）/ null（还没有数据可备份）/ false（备份没做成）
//   返回 false 时调用方必须放弃覆盖 —— 备份都没做成，就更不能冒险动原文件。
function backupCurrentData() {
  if (!fs.existsSync(OUT_FILE)) return null;
  try {
    fs.mkdirSync(BACKUP_DIR, { recursive: true });
    const name = 'competitions.' + fileStamp() + '.' + randomUUID() + '.json';
    const destination = path.join(BACKUP_DIR, name);
    try {
      // 同一秒内多次运行也不能覆盖先前的备份。
      fs.copyFileSync(OUT_FILE, destination, fs.constants.COPYFILE_EXCL);
    } catch (e) {
      if (e.code !== 'EEXIST' && fs.existsSync(destination)) fs.unlinkSync(destination);
      throw e;
    }
    return name;
  } catch (e) {
    log('  ⚠ 备份没做成：' + e.message);
    return false;
  }
}

// 数据成功提交后才清理旧备份；失败的写入仍可退回原有历史版本。
function pruneBackups() {
  try {
    const olds = fs.readdirSync(BACKUP_DIR)
      .filter(f => /^competitions\.\d{8}-\d{6}(?:\.[0-9a-f-]{36})?\.json$/.test(f))
      .map(name => ({ name, mtime: fs.statSync(path.join(BACKUP_DIR, name)).mtimeMs }))
      .sort((a, b) => a.mtime - b.mtime || a.name.localeCompare(b.name));
    for (const old of olds.slice(0, Math.max(0, olds.length - KEEP_BACKUPS))) {
      fs.unlinkSync(path.join(BACKUP_DIR, old.name));
    }
  } catch (e) {
    log('  ⚠ 清理旧备份失败：' + e.message);
  }
}

// 先写同目录临时文件，再原子替换。任何写入/同步/重命名失败都保留旧数据。
function writeDataAtomically(payload) {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const tempFile = path.join(OUT_DIR, '.competitions.json.' + randomUUID() + '.tmp');
  let fd;
  try {
    fd = fs.openSync(tempFile, 'wx');
    fs.writeFileSync(fd, JSON.stringify(payload, null, 2), 'utf8');
    fs.fsyncSync(fd);
    fs.closeSync(fd);
    fd = undefined;
    fs.renameSync(tempFile, OUT_FILE);
  } catch (e) {
    if (fd !== undefined) {
      try { fs.closeSync(fd); } catch (_) { /* 不遮盖原始错误 */ }
    }
    try { if (fs.existsSync(tempFile)) fs.unlinkSync(tempFile); } catch (_) { /* 稍后人工清理 */ }
    throw e;
  }
}

// 整轮采集独占运行，防止人工更新与定时任务互相覆盖数据、状态和网页。
// 异常断电可能留下锁文件；此时宁可拒绝覆盖，也不要自动猜测并删锁。
function acquireRunLock() {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  let fd;
  try {
    fd = fs.openSync(LOCK_FILE, 'wx');
    fs.writeFileSync(fd, JSON.stringify({ pid: process.pid, at: new Date().toISOString() }));
    fs.closeSync(fd);
  } catch (e) {
    if (fd !== undefined) {
      try { fs.closeSync(fd); } catch (_) { /* 保留原始错误 */ }
      try { fs.unlinkSync(LOCK_FILE); } catch (_) { /* 稍后人工核对 */ }
    }
    if (e.code === 'EEXIST') {
      throw new Error('已有采集任务正在运行（或上次异常退出留下锁文件）：' + LOCK_FILE);
    }
    throw e;
  }
  let held = true;
  const release = () => {
    if (!held) return;
    held = false;
    try { fs.unlinkSync(LOCK_FILE); } catch (e) {
      log('  ⚠ 采集锁清理失败，请人工核对：' + e.message);
    }
  };
  process.once('exit', release);
  return () => {
    process.off('exit', release);
    release();
  };
}

// 读上一次的数据文件（半失败时要从这里把失败数据源的条目留下来）
function readPreviousData() {
  try {
    const d = JSON.parse(fs.readFileSync(OUT_FILE, 'utf8'));
    return (d && typeof d === 'object') ? d : null;
  } catch (e) {
    return null;
  }
}

// 数据定下来之后，把网页重新画一遍。
// 生成网页失败不算采集失败：数据已经安全存好了，网页下次还能再生成。
function rebuildPage() {
  log('');
  log('---------------------------------------------');
  log('正在把数据画成网页文件...');
  log('---------------------------------------------');
  try {
    build({ log });
  } catch (e) {
    log('  ✘ 生成网页失败：' + (e && e.message ? e.message : e));
    log('    （数据已经存好了，网页可以稍后单独跑 src\\build.js 重新生成）');
  }
}

(async () => {
  const releaseLock = acquireRunLock();
  try {
  const startedAt = new Date();
  const competitions = [];
  const sourceResults = [];
  const bySource = new Map(); // source_id → 这次采到的条目（按源分开，方便处理半失败）

  for (const c of collectors) {
    log('');
    log('---------------------------------------------');
    log('数据源：' + c.sourceName);
    log('---------------------------------------------');
    try {
      const items = await c.collect({ log });
      for (const item of items) competitions.push(item);
      bySource.set(c.sourceId, items);
      sourceResults.push({
        source_id: c.sourceId,
        source_name: c.sourceName,
        status: 'ok',
        count: items.length,
        error: null,
      });
      log('  ✔ 成功拿到 ' + items.length + ' 条竞赛信息');
    } catch (err) {
      // 重要原则：某个数据源失败，绝不用假数据顶替，只如实记录失败原因。
      sourceResults.push({
        source_id: c.sourceId,
        source_name: c.sourceName,
        status: 'failed',
        count: 0,
        error: err && err.message ? err.message : String(err),
      });
      log('  ✘ 失败：' + (err && err.message ? err.message : err));
      log('    （不会用假数据填补，这条空白会如实记录在网页上）');
    }
  }

  const prev = readPreviousData();
  const prevComps = (prev && Array.isArray(prev.competitions)) ? prev.competitions : [];
  const prevGeneratedAt = (prev && prev.generated_at) ? prev.generated_at : null;

  // 一个原本有数据的来源突然返回空数组，不能当成成功：
  // 这通常意味着接口改版、参数失效或解析失配，必须走失败源保留旧数据的保护路径。
  for (const c of collectors) {
    const result = sourceResults.find(s => s.source_id === c.sourceId);
    const fresh = bySource.get(c.sourceId) || [];
    const hadBefore = prevComps.filter(x => x.source_id === c.sourceId).length;
    if (result && result.status === 'ok' && fresh.length === 0 && hadBefore > 0) {
      result.status = 'failed';
      result.error = '本次采集返回空结果，但上次存在 ' + hadBefore + ' 条数据，已按疑似接口异常处理';
      log('  ✘ ' + c.sourceName + '：本次返回空结果，但上次有 ' + hadBefore +
        ' 条，已按失败源处理并保留旧数据。');
    }
  }

  const failedSources = sourceResults.filter(s => s.status === 'failed');
  const failedIds = new Set(failedSources.map(s => s.source_id));
  const failedInfo = failedSources.map(s => ({
    source_id: s.source_id,
    source_name: s.source_name,
    error: s.error,
  }));

  // 顺带提醒一件事：某个数据源"没报错、但一条都没采到"，而上一次它明明有数据。
  // 这种情况多半是官网改版了（不是真的没比赛），日志里必须说清楚，不能悄悄放过。
  for (const c of collectors) {
    const fresh = bySource.get(c.sourceId) || [];
    const hadBefore = prevComps.filter(x => x.source_id === c.sourceId).length;
    if (fresh.length === 0 && hadBefore > 0 && !failedIds.has(c.sourceId)) {
      log('');
      log('  ⚠ ' + c.sourceName + '：这次既没报错、也一条都没采到，而上次有 ' +
          hadBefore + ' 条 —— 很可能是官网改版了，请人工看一眼。');
    }
  }

  // ==================================================================
  // 【闸二】一条竞赛都没采到 → 绝不用空数据覆盖已有的好数据
  // ==================================================================
  if (competitions.length === 0) {
    const statusSaved = writeStatus({
      status: 'no_data',
      at: new Date().toISOString(),
      keep_generated_at: prevGeneratedAt,
      failed_sources: failedInfo,
      retained_sources: [],
      note: null,
    });

    log('');
    log('=============================================');
    log('★ 本次一条竞赛信息都没采到，为避免把已有的好数据弄坏：');
    log('  【没有覆盖】' + OUT_FILE);
    if (prev) {
      log('  网站仍然显示上一次的数据（采集于 ' + prevGeneratedAt + '），');
      log('  网页顶部会写明"最近一次采集没成功，以下仍是上一次的数据"。');
    } else {
      log('  本机还没有历史数据，网页会显示"还没有数据"和解决办法。');
    }
    log('=============================================');

    if (statusSaved) rebuildPage(); // 状态写入失败时保留旧网页，避免显示错误结果
    else log('  ✘ 采集状态未能保存，网页未重建，请检查 data 目录。');
    process.exitCode = 1;
    return;
  }

  // ==================================================================
  // 采到东西了：半失败时，把失败那个源上一次的条目原样留下
  // ==================================================================
  const finalCompetitions = [];
  const retainedSources = [];

  for (const c of collectors) {
    const fresh = bySource.get(c.sourceId) || [];

    if (fresh.length > 0 || !failedIds.has(c.sourceId)) {
      // 这次采到了，或者这个源本来就没失败 → 用这次的结果
      for (const item of fresh) finalCompetitions.push(item);
      continue;
    }

    // 这个源这次失败了：把上一次它的条目原样留着，并标明"这是上次的数据"
    const kept = prevComps.filter(x => x.source_id === c.sourceId);
    for (const item of kept) {
      finalCompetitions.push(Object.assign({}, item, { retained_from: prevGeneratedAt }));
    }
    if (kept.length > 0) {
      retainedSources.push({
        source_id: c.sourceId,
        source_name: c.sourceName,
        count: kept.length,
        from_generated_at: prevGeneratedAt,
      });
      log('');
      log('  ↑ ' + c.sourceName + ' 这次失败了，已把上一次的 ' + kept.length +
          ' 条原样保留（网页上会标明"这条是上次的数据"）。');
    } else {
      log('');
      log('  ↑ ' + c.sourceName + ' 这次失败了，而且上一次也没有它的数据，只能留空。');
    }
  }

  // ==================================================================
  // 【地区 / 参赛范围】（2026-09-17 新增）
  //
  // 三个官网【都没有"地区"这个字段】—— 2026-09-17 逐个接口查过：
  //   天池列表 46 个字段 + 详情 67 个字段、腾讯开悟列表 92 + 详情 94、
  //   广告算法大赛 4+4 个字段，没有任何 region/city/province 之类的字段；
  //   天池的标签也只有"方向"一类（tagType 全是 RACE），没有"地区"标签。
  // 所以这里退一步：只从官网【自己写出来的字】（标题 / 副标题 / 赛事介绍正文 /
  // 参赛资格）里，把官网明确写着的地区原词认出来，并把原句一起存下来当证据；
  // 认不出来的就如实留空，网页上显示"官网未公布"—— 绝不猜、绝不用空话填。
  //
  // ★ 规则和"为什么规则要这么严"写在 src/region.js 开头。
  // ★ 这一步放在最后（对所有要写进文件的记录统一跑一遍），
  //   这样"某个源这次失败了、沿用上次数据"的那几条也能一并补上地区。
  // ==================================================================
  let regionHit = 0;
  for (const item of finalCompetitions) {
    const found = findRegion(item);
    item.region = found ? found.region : null;
    item.region_where = found ? found.where : null;
    item.region_evidence = found ? found.evidence : null;
    if (found) regionHit++;
  }
  log('');
  log('【地区 / 参赛范围】' + regionHit + ' / ' + finalCompetitions.length +
      ' 条从官网原文里认出了地区；其余 ' + (finalCompetitions.length - regionHit) +
      ' 条官网没写，如实留空（网页上显示"官网未公布"，绝不猜）。');

  // ==================================================================
  // 【比赛形式 / 比赛地点】（2026-09-17 第四轮新增，用户要求）
  //
  // 用户说："官网上面有写地址的，比如初赛是线上、决赛是在线下上海这种，你也写进去；
  //   展示的界面上只写'只有线上 / 线上线下都有 / 只有线下'；另外把比赛地点也加到主界面上。"
  //
  // 和"地区"一样：三个 collector 里【没有任何 city / address / location / venue 的读取】
  // （2026-09-17 复查过 src/collectors/*.js），所以接口拿不到。
  // 但官网【正文里确实写着原话】，例如：
  //   "本次大赛分为线上初赛和线下决赛两个阶段"、"11月13日—11月15日：上海线下决赛"
  //   "将于2026年11月12日至15日在北京召开"
  // 所以这里从官网原文里认，认不出如实留空。
  //
  // ★ 规则、以及"为什么城市名不能见一个算一个"（北京时间是时区、成都市委是机构…）
  //   写在 src/venue.js 开头。★ 放在"地区"之后、写文件之前，理由同地区。
  // ==================================================================
  let formHit = 0, cityHit = 0;
  for (const item of finalCompetitions) {
    const found = findVenue(item);
    item.venue_form = found ? found.form : null;
    item.venue_form_where = found ? found.formWhere : null;
    item.venue_form_evidence = found ? found.formEvidence : null;
    item.venue_city = found ? found.city : null;
    item.venue_city_where = found ? found.cityWhere : null;
    item.venue_city_evidence = found ? found.cityEvidence : null;
    if (found && found.form) formHit++;
    if (found && found.city) cityHit++;
  }
  log('');
  log('【比赛形式】' + formHit + ' / ' + finalCompetitions.length +
      ' 条从官网原文里认出了比赛形式（只有线上 / 线上线下 / 只有线下）；其余官网没写，如实留空。');
  log('【比赛地点】' + cityHit + ' / ' + finalCompetitions.length +
      ' 条从官网原文里认出了比赛城市；其余官网没写，如实留空（绝不拿机构名/时区当地点）。');

  const payload = {
    schema_version: 1,
    generated_at: new Date().toISOString(),
    elapsed_ms: Date.now() - startedAt.getTime(),
    source_results: sourceResults,
    competitions: finalCompetitions,
  };
  // ---- 【闸一】覆盖之前先备份 ----
  const backupName = backupCurrentData();
  if (backupName === false) {
    // 备份没做成 → 宁可这次不更新，也不冒险覆盖
    const statusSaved = writeStatus({
      status: 'no_data',
      at: new Date().toISOString(),
      keep_generated_at: prevGeneratedAt,
      failed_sources: failedInfo,
      retained_sources: [],
      note: '这次采集的数据【没有保存】：覆盖前的自动备份没做成，为了不冒险动原文件，只好放弃这次更新。',
    });
    log('');
    log('=============================================');
    log('★ 备份失败 → 为了安全【没有覆盖】数据文件，这次的新数据不保存。');
    log('  网站仍然显示上一次的数据。请检查 data\\_backup 目录能不能写入。');
    log('=============================================');
    if (statusSaved) rebuildPage();
    else log('  ✘ 采集状态未能保存，网页未重建，请检查 data 目录。');
    process.exitCode = 1;
    return;
  }
  if (backupName) {
    log('');
    log('（覆盖前已把旧数据备份到 data\\_backup\\' + backupName + '）');
  }

  writeDataAtomically(payload);
  pruneBackups();

  // 记下这次采集的真实结局，网页和定时任务的日志都照它来说实话
  const statusSaved = writeStatus({
    status: failedSources.length > 0 ? 'partial' : 'ok',
    at: payload.generated_at,
    keep_generated_at: null,
    failed_sources: failedInfo,
    retained_sources: retainedSources,
    note: null,
  });

  if (!statusSaved) {
    log('  ✘ 数据已保存，但采集状态未能保存；网页未重建，请检查 data 目录。');
    process.exitCode = 1;
    return;
  }

  rebuildPage();

  log('');
  log('=============================================');
  log('采集结束：共 ' + finalCompetitions.length + ' 条竞赛信息' +
      (retainedSources.length > 0
        ? '（其中 ' + retainedSources.reduce((n, s) => n + s.count, 0) + ' 条是上次的、原样保留）'
        : ''));
  log('已保存到：' + OUT_FILE);
  log('数据源情况：' + sourceResults.map(s => s.source_name + '=' + s.status + '(' + s.count + ')').join('，'));
  if (failedSources.length > 0) {
    log('★ 注意：有数据源失败，网页顶部会写明这件事。');
    process.exitCode = 1;
  }
  log('=============================================');
  } finally {
    releaseLock();
  }
})().catch(err => {
  console.error('采集程序意外出错：' + (err && err.stack ? err.stack : err));
  process.exitCode = 1;
});
