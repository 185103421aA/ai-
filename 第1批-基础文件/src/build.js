// ============================================================
// 生成网页文件：把数据文件（data/competitions.json）变成一张提前做好的网页
//                 存到 public/index.html
//
// 【为什么要提前生成，而不是有人访问时才现做】
//   1. 更快：有人打开网站时，服务器只是"把做好的文件发出去"，不需要现场算
//   2. 更安全：服务器只发一个固定文件，不会因为奇怪请求而报错
//   3. 更适合上线：文件可以交给任何静态网站托管，不一定要一直开着这个程序
//
// 用法：node src\build.js
// 提示：collect.js 采集完之后会自动调用它，平时不用单独跑。
//       但如果你想"数据没变、只想重新画一遍网页"，可以单独跑这个。
// ============================================================

const fs = require('fs');
const path = require('path');
const render = require('./render.js');

function build({ log = console.log } = {}) {
  const data = render.readData();

  // ============================================================
  // 【2026-09-15 修的缺陷】数据文件读不出来时，绝不用提示页把好网页冲掉
  //
  // 以前这里是无条件覆盖的：只要数据文件此刻读不出来（被写坏、被删、写到一半断电），
  // 就把 public\index.html 换成那张"还没有数据"的提示页 —— 一个已经做好的网站
  // 瞬间变成白页，而且提示页上还写着"双击启动网站.bat"（那是给本机看的，上网的人一头雾水）。
  // 实测复现过：15667 字节的好首页 → 595 字节的提示页。
  //
  // 现在的规矩（跟 D11「采集失败不许覆盖好数据」是同一条道理，只是补在"生成网页"这一步）：
  //   磁盘上【已经有】做好的网页 → 一个字节都不动，只打一行提醒；
  //   磁盘上【从来没有过】网页   → 才生成那张"还没有数据"的提示页（首次访问总得给点东西看）。
  const pageExists = fs.existsSync(render.PAGE_FILE);
  const dataBad = !!(data.missing || data.error);

  if (dataBad && pageExists) {
    log('  ⚠ 数据读不出来（' + (data.error || '没有数据文件') + '），');
    log('    为了保护【已经做好的网页】，这次没有重新生成 —— 网页保持原样，刷新看到的还是上一次的内容。');
    log('    等下次采集成功（双击 更新数据.bat）就会自动换成新网页。');
    return { file: render.PAGE_FILE, bytes: fs.statSync(render.PAGE_FILE).size, detailCount: 0, skipped: true };
  }

  // 还没采集过数据（或者数据文件坏了）：也生成一张网页，
  // 但内容就是那页"还没有数据 + 解决办法"。绝不凭空编数据。
  const html = render.renderPage();

  fs.mkdirSync(render.PUBLIC_DIR, { recursive: true });
  fs.writeFileSync(render.PAGE_FILE, html, 'utf8');

  // ---------- 详情子页（子母页结构，2026-09-12 改版新增） ----------
  // 每场"正在报名"的比赛生成一个独立详情页，存到 public\detail\ 下。
  // 【注意】public\detail\ 这个文件夹平时不存在，必须先建（否则写文件直接报错）；
  // 每次生成前把整个 detail 文件夹清掉重建，免得某场比赛截止下线后，
  // 它的旧子页还残留在文件夹里变成"死页"。
  let detailCount = 0;
  let openCount = 0;
  let sitemapWritten = false;
  if (!dataBad) {
    const open = (data.competitions || []).filter(c => c.register_state === 'open');
    openCount = open.length;
    fs.rmSync(render.DETAIL_DIR, { recursive: true, force: true });
    fs.mkdirSync(render.DETAIL_DIR, { recursive: true });
    for (const c of open) {
      fs.writeFileSync(
        path.join(render.DETAIL_DIR, render.detailFileName(c)),
        render.renderDetailPage(c, data.generated_at),
        'utf8'
      );
      detailCount++;
    }

    // ---------- robots.txt / sitemap.xml（给搜索引擎看的两个小文件，2026-09-16 新增） ----------
    // 它们不是"给观众看的网页"，但决定搜索引擎知不知道该收录哪些页 —— 网站马上要给外人看，顺手补上。
    // ★ 放在 public\ 根目录（不是 detail\ 里）：detail\ 每次生成都会整个清空重建，放那儿会被删掉。
    fs.mkdirSync(render.PUBLIC_DIR, { recursive: true });
    fs.writeFileSync(path.join(render.PUBLIC_DIR, 'robots.txt'), render.renderRobots(), 'utf8');
    const sitemap = render.renderSitemap();
    if (sitemap) {
      fs.writeFileSync(path.join(render.PUBLIC_DIR, 'sitemap.xml'), sitemap, 'utf8');
      sitemapWritten = true;
    } else {
      // 没填域名就生成不出绝对地址 —— 宁可少生成一个文件，也不往里编假域名
      log('  ⚠ 没填站点地址（site-config.js 的 siteUrl），这次没有生成 sitemap.xml');
    }
  }

  // 备案号填得不对时，在这里提醒一句（号码本身不会显示到网页上，见 render.js）
  const beian = render.renderFooter();
  for (const w of (beian.warnings || [])) log('  ⚠ ' + w);
  // 号码填好了就顺口报一句，免得主人怀疑"填了到底有没有生效"
  if (beian.html) log('  ✔ 网页底部已挂备案号');

  const sizeKb = Math.round(Buffer.byteLength(html, 'utf8') / 1024 * 10) / 10;
  if (dataBad) {
    log('  ⚠ 数据还不完整（' + (data.error || '没有数据文件') + '），已生成一张"还没有数据"的提示页');
  } else {
    // 措辞对齐改版：首页只陈列"正在报名"的，别再把收录总数说成陈列数（D14）
    log('  ✔ 首页已生成：陈列 ' + openCount + ' 场正在报名的竞赛，' + Math.round(sizeKb) + ' KB');
    log('  ✔ 详情子页已生成：' + detailCount + ' 个（public\\detail\\ 文件夹）');
    if (sitemapWritten) log('  ✔ 给搜索引擎的清单已生成：robots.txt + sitemap.xml');
  }
  return { file: render.PAGE_FILE, bytes: Buffer.byteLength(html, 'utf8'), detailCount };
}

// ---------- 只重画整套详情子页（B2 新增，server.js 的"整批子页被删"兜底用） ----------
// 动作和 build() 里生成子页的那一段完全一样：清空 public\detail\ 重新生成。
// 两个故意的差别：
//   1. 绝不动首页 —— 兜底场景里首页多半还是好的；
//   2. 数据坏了/还没有数据时一张子页都不写、也不动任何已有文件，
//      绝不能把已有的好网页冲掉（D11 / D14）。
function buildDetails({ log = console.log } = {}) {
  const data = render.readData();
  if (data.missing || data.error) {
    log('  ⚠ 数据还不完整（' + (data.error || '没有数据文件') + '），详情子页一张都没生成');
    return { detailCount: 0 };
  }
  const open = (data.competitions || []).filter(c => c.register_state === 'open');
  fs.rmSync(render.DETAIL_DIR, { recursive: true, force: true });
  fs.mkdirSync(render.DETAIL_DIR, { recursive: true });
  let detailCount = 0;
  for (const c of open) {
    fs.writeFileSync(
      path.join(render.DETAIL_DIR, render.detailFileName(c)),
      render.renderDetailPage(c, data.generated_at),
      'utf8'
    );
    detailCount++;
  }
  log('  ✔ 详情子页已重新生成：' + detailCount + ' 个（public\\detail\\ 文件夹）');
  return { detailCount };
}

module.exports = { build, buildDetails };

// 被当作命令直接跑时才执行（被 collect.js 引用时不会重复执行）
if (require.main === module) {
  try {
    build();
    console.log('网页文件位置：' + render.PAGE_FILE);
  } catch (e) {
    console.error('生成网页失败：' + (e && e.stack ? e.stack : e));
    process.exitCode = 1;
  }
}
