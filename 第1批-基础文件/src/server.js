// ============================================================
// 网站服务：把提前生成好的网页文件发出去
//
// 【上线版的变化】
//   以前：谁打开网页，就现场把数据画成网页（费 CPU，且每次都要重算）
//   现在：网页在采集那一步就已经生成好了（public/index.html），
//         这里只负责"把文件发给浏览器"，又快又稳，还能直接搬去静态托管。
//
// 它自己不去网上抓任何东西，也不改数据，只读文件。
// 所以网站打不开时，问题一定在采集那一步。
// ============================================================

const http = require('http');
const fs = require('fs');
const path = require('path');
const render = require('./render.js');
const { buildDetails } = require('./build.js');

const PAGE_FILE = render.PAGE_FILE;
const PORT = Number(process.env.PORT || 8000);

// 【2026-09-16 修】以前这里对什么文件都回 text/html —— 那是 public\ 根目录下
//   只有 index.html 一个文件的时候写的。加了 robots.txt / sitemap.xml 之后就不对了：
//   搜索引擎拿到的类型是错的。现在按后缀给类型，规则与 deploy\static-preview.js
//   （本机实测过）和服务器上的 nginx 一致。
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.xml': 'application/xml; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  // 2026-09-17 新增：网页开始用主题自带的字体、底图和图形了（public\media\ 下），
  //   这三种后缀以前不在表里，会被当成 application/octet-stream 发出去 ——
  //   浏览器对字体的类型比较挑，类型不对可能整个字体都不加载（页面就退回系统字）。
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.ttf': 'font/ttf',
  '.woff2': 'font/woff2',
  '.css': 'text/css; charset=utf-8',
};
function mimeOf(filePath) {
  return MIME[path.extname(filePath).toLowerCase()] || 'application/octet-stream';
}

// 发一个文件给浏览器。no-store = 每次都要最新的，别让浏览器拿旧缓存。
// 响应头【只在这里写一次】，调用方不要再另写，否则会报"重复写响应头"。
function sendFile(res, filePath) {
  fs.readFile(filePath, (err, buf) => {
    if (err) {
      if (!res.headersSent) {
        res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' });
      }
      res.end('网页文件读不出来：' + err.message);
      return;
    }
    res.writeHead(200, {
      'Content-Type': mimeOf(filePath),
      'Content-Length': buf.length,
      'Cache-Control': 'no-store',
    });
    res.end(buf);
  });
}

// 发一段纯文字给浏览器（用于拒绝非法地址、子页不存在这些情况）
function sendText(res, code, text, extraHeaders = {}) {
  res.writeHead(code, {
    'Content-Type': 'text/plain; charset=utf-8',
    'Cache-Control': 'no-store',
    ...extraHeaders,
  });
  res.end(text);
}

// ============================================================
// 意见信箱的"收件口"（2026-09-17 新增，用户要求）
//
// 【它是什么】网页右下角那个信箱，点了"提交"之后把意见 POST 到 /api/feedback，
//   这里负责把它【一行一条】追加进 data\feedback.jsonl，双击 看意见.bat 就能看。
//
// 【★ 为什么只有本机这一个服务器有收件口】
//   传到服务器上之后，网站是【纯静态】的（nginx 只发文件，没有后台程序），
//   网页自己一个字节也存不下来。所以上线后观众点"提交"是走不通存储这条路的 ——
//   网页里那段脚本会自动退到"打开邮件"（见 src\render.js 的 mailboxJs）。
//   ★ 也就是说：这个收件口【只在双击 启动网站.bat 时有】。这是事实，不是缺陷，
//     但一定要说清楚，免得有人以为"网页上有信箱＝服务器上就能收"。
//   ★ 同理 deploy\static-preview.js（8001 端口那个"模拟上线效果"）【故意不加】这个口：
//     它的职责就是如实模拟"传上去之后的样子"，加了口就不老实了。
//
// 【为什么是 .jsonl（一行一条 JSON）而不是一个大 JSON 数组】
//   追加写一行就行，不需要先把整个文件读出来改完再写回去。两个人同时提交、
//   或者写到一半断电，最多坏掉最后那一行，前面的意见一条都不会丢。
// ============================================================
const FEEDBACK_FILE = path.join(__dirname, '..', 'data', 'feedback.jsonl');
const FEEDBACK_MAX_CHARS = 4000;      // 一条意见最多留这么多字（多出来的截掉，不报错）
const FEEDBACK_MAX_BYTES = 32 * 1024; // 请求体上限：挡住"有人拿它当上传口"的情况

function sendJson(res, code, obj, extraHeaders = {}) {
  const body = Buffer.from(JSON.stringify(obj), 'utf8');
  res.writeHead(code, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': body.length,
    'Cache-Control': 'no-store',
    ...extraHeaders,
  });
  res.end(body);
}

function handleFeedback(req, res) {
  const chunks = [];
  let bodyBytes = 0;
  let tooBig = false;
  req.on('data', chunk => {
    if (tooBig) return;
    const chunkBuffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    bodyBytes += chunkBuffer.length;
    if (bodyBytes > FEEDBACK_MAX_BYTES) {
      tooBig = true;
      sendJson(res, 413, { ok: false, error: '写的内容太长了。' });
      return;
    }
    chunks.push(chunkBuffer);
  });
  req.on('end', () => {
    if (tooBig) return;
    const body = Buffer.concat(chunks).toString('utf8');
    let o;
    try {
      o = JSON.parse(body);
    } catch (e) {
      sendJson(res, 400, { ok: false, error: '看不懂提交的内容。' });
      return;
    }
    const text = String((o && o.text) || '').trim().slice(0, FEEDBACK_MAX_CHARS);
    if (text.length < 2) {
      // 和网页上那条提示一个口径：太短的不收（多半是误点）
      sendJson(res, 400, { ok: false, error: '内容太短了。' });
      return;
    }
    const oneLine = s => String(s || '').replace(/[\r\n]+/g, ' ').trim();
    const rec = {
      at: new Date().toISOString(),
      text: text,
      contact: oneLine(o && o.contact).slice(0, 120),
      page: oneLine(o && o.page).slice(0, 200),
      viewport: oneLine(o && o.viewport).slice(0, 40),
      from: (req.socket && req.socket.remoteAddress) ? req.socket.remoteAddress : '',
    };
    try {
      fs.mkdirSync(path.dirname(FEEDBACK_FILE), { recursive: true });
      fs.appendFileSync(FEEDBACK_FILE, JSON.stringify(rec) + '\n', 'utf8');
    } catch (e) {
      sendJson(res, 500, { ok: false, error: '存不进去：' + e.message });
      return;
    }
    console.log('  ✉ 收到一条意见（' + text.length + ' 个字），已存进 data\\feedback.jsonl');
    sendJson(res, 200, { ok: true });
  });
  req.on('error', () => { try { res.end(); } catch (e) { /* 连接断了，什么都不用做 */ } });
}

// 【改版】按请求地址决定发哪个文件：
//   / 或 /index.html        → 首页 public\index.html
//   /detail/xxx.html        → 子页 public\detail\xxx.html（2026-09-12 改版新增）
//   public\ 里现成的其它文件 → 就发那个文件（robots.txt / sitemap.xml，2026-09-16 修）
//   其他任何地址            → 当作首页处理（和服务器上的 nginx、和 static-preview.js 一致）
// 安全闸：地址里带 .. 或 \ 的（想跳出网站目录翻别的文件）一律拒绝。
// 为什么必须分地址：以前这里不看地址，只要有 index.html 就原样发首页 ——
//   那样点"详情"打开 /detail/xxx.html 拿回来的还是首页，子页等于白做。

// 【2026-09-16 修】public\ 根目录下"现成的其它文件"（现在就是 robots.txt 和 sitemap.xml）。
//   原来这里的路由只认 / 、/index.html 和 /detail/xxx.html，别的地址一律当首页 ——
//   那是这两个文件还不存在时写的。结果 /robots.txt 和 /sitemap.xml 都被首页顶了包：
//   HTTP 实测拿到的是 20451 字节的首页 HTML，而不是那 66 / 2730 字节的真文件，
//   而线上（nginx 的 try_files $uri）和 deploy\static-preview.js 都是正确发真文件的 ——
//   "本机网站"和"上线预览"表现不一致，会让本地验收的结论不可信。
//   返回 null = public\ 里没有这个文件，交给下面的"缺文件兜底 / 当首页"逻辑处理。
function resolvePublicFile(urlPath) {
  const rel = urlPath.replace(/^\/+/, '');
  if (!rel) return null;
  // 安全闸：同路由入口那条，这里再拦一次（解析前后都不许出现 .. 或 \）
  if (rel.includes('..') || rel.includes('\\')) return null;
  const abs = path.join(render.PUBLIC_DIR, rel);
  // 双保险：拼出来的路径必须真的落在 public\ 里面，否则宁可当它不存在
  const rootWithSep = render.PUBLIC_DIR.endsWith(path.sep) ? render.PUBLIC_DIR : render.PUBLIC_DIR + path.sep;
  if (!abs.startsWith(rootWithSep)) return null;
  try {
    return fs.statSync(abs).isFile() ? abs : null;
  } catch (e) {
    return null;
  }
}

// public\detail\ 里还有没有子页。目录不存在（或读不了）→ 当作一张子页都不剩。
function detailDirHasPages() {
  try {
    return fs.readdirSync(render.DETAIL_DIR).some(f => f.toLowerCase().endsWith('.html'));
  } catch (e) {
    return false;
  }
}

const server = http.createServer((req, res) => {
  const clean = (req.url || '/').split('?')[0];

  if (clean.includes('..') || clean.includes('\\')) { sendText(res, 400, '非法地址。'); return; }

  // 反馈接口只接受 POST。若让 GET 落入下面的静态文件兜底，会返回首页 200，
  // 让调用方误以为接口调用成功；明确返回 405，避免接口语义含糊。
  if (clean === '/api/feedback' && req.method !== 'POST') {
    sendJson(res, 405, { ok: false, error: '意见接口只接受 POST 请求。' }, { Allow: 'POST' });
    return;
  }

  // 意见信箱的收件口（2026-09-17 新增）。放在静态发文件之前，
  // 因为它是"收东西"，不是"发文件"。别的 POST 地址一律 404，不假装能收。
  if (req.method === 'POST') {
    if (clean === '/api/feedback') { handleFeedback(req, res); return; }
    sendText(res, 404, '这个地址不收东西。');
    return;
  }

  // 静态文件只接受 GET / HEAD。其它方法不能悄悄拿到首页，
  // 否则客户端会把“没有执行任何操作”误判成请求成功。
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    sendText(res, 405, '这个静态地址只接受 GET 或 HEAD 请求。', { Allow: 'GET, HEAD' });
    return;
  }

  if (clean === '/favicon.ico') { res.writeHead(204); res.end(); return; }

  const isDetail = /^\/detail\/[A-Za-z0-9._-]+\.html$/.test(clean);

  // 【2026-09-16 修】/detail/ 开头、但不是一张合法子页地址的（例如 /detail/ 本身、
  //   /detail/xxx.txt）→ 直接 404，和 deploy\static-preview.js、服务器上的 nginx 一致。
  //   以前这种地址会悄悄把首页发出去顶包，本机看到的和线上看到的不是一回事。
  if (/^\/detail\//.test(clean) && !isDetail) { sendText(res, 404, '这个详情页不存在。'); return; }

  // 非详情页的地址：先看 public\ 里有没有这个现成文件（robots.txt / sitemap.xml 走这条），
  // 只有 / 和 /index.html 才直接当首页；都没有就当首页（与 nginx / 预览一致）。
  const file = isDetail
    ? path.join(render.DETAIL_DIR, clean.slice('/detail/'.length))
    : ((clean === '/' || clean === '/index.html') ? PAGE_FILE : (resolvePublicFile(clean) || PAGE_FILE));

  // 已经有提前生成好的网页 → 直接发出去（上线后的正常路径）
  if (fs.existsSync(file)) {
    sendFile(res, file);
    return;
  }

  // 【B2 修复】缺文件兜底：缺哪个只重画哪个，不再整套重写。
  // （以前：访问一个不存在的子页，也会把首页 + 18 个子页全部重写一遍，白干。）
  // 三条分支：
  //   甲 缺的是首页 → 只重画首页，public\detail\ 里一个文件都不动；
  //   乙 缺的是子页、detail 文件夹里还有别的子页 → 只重画请求的那一张
  //      （只认"正在报名"的比赛；数据里没有这场/这场已截止/数据坏了 → 画不出来，
  //        什么都不写，直接落到底下的 404。已截止的比赛不重新长出子页，D23）；
  //   丙 缺的是子页、detail 文件夹整个没了（或一张子页都不剩）→ 整批被删的迹象，
  //      仍把全部子页整套重建（保住"整批被删也能自愈"的兜底；首页不动）。
  try {
    if (!isDetail) {
      // （甲）缺首页：只重画首页。
      //   ★ 2026-09-15 加闸：renderPage() 在数据文件读不出来时会返回"还没有数据"的提示页，
      //     若无条件写下去，就成了"服务器自己绕开 build.js 的闸把首页冲成白页"。
      //     所以只在首页【确实不存在】时才现场补一张（同 build.js 的规矩）。
      if (!fs.existsSync(render.PAGE_FILE)) {
        fs.mkdirSync(render.PUBLIC_DIR, { recursive: true });
        fs.writeFileSync(render.PAGE_FILE, render.renderPage(), 'utf8');
      }
    } else if (detailDirHasPages()) {
      // （乙）缺一张子页、别的子页还在：只重画请求的这一张
      const data = render.readData();
      const c = (data.missing || data.error) ? null : (data.competitions || []).find(x =>
        x.register_state === 'open' && render.detailFileName(x) === clean.slice('/detail/'.length));
      if (c) {
        fs.mkdirSync(render.DETAIL_DIR, { recursive: true });
        fs.writeFileSync(
          path.join(render.DETAIL_DIR, render.detailFileName(c)),
          render.renderDetailPage(c, data.generated_at),
          'utf8'
        );
      }
    } else {
      // （丙）子页一张都不剩：整套重建全部子页（build.js 的新导出，不动首页）
      buildDetails({ log: () => {} });
    }
    if (fs.existsSync(file)) {
      sendFile(res, file);
      return;
    }
    // 重建后还是找不到：子页地址写错（或那场比赛已截止下线）时才会走到这里
    sendText(res, 404, isDetail
      ? '这个详情页不存在（可能比赛已截止下线）。回首页看看别的比赛吧。'
      : '网页还没生成好，刷新一次试试。');
  } catch (e) {
    res.writeHead(500, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end('<h1>网站出错了</h1><pre>' + String(e.stack || e).replace(/</g, '&lt;') + '</pre>');
  }
});

server.on('error', err => {
  if (err.code === 'EADDRINUSE') {
    console.error('端口 ' + PORT + ' 被占用了（可能你之前开的网站还没关）。');
    console.error('解决办法：关掉之前的黑窗口，或者用别的端口启动，例如在命令行里执行：set PORT=8081 && node src\\server.js');
  } else {
    console.error('服务器启动失败：' + err.message);
  }
  process.exitCode = 1;
});

server.listen(PORT, '127.0.0.1', () => {
  const url = 'http://127.0.0.1:' + PORT;
  console.log('');
  console.log('网站已经开好了，请用浏览器打开：' + url);
  console.log('（如果浏览器没自动弹出，就把上面这个地址复制到浏览器地址栏）');
  if (!fs.existsSync(PAGE_FILE)) {
    console.log('');
    console.log('提醒：还没生成过网页文件，刚才这次是现场临时做的。');
    console.log('      想要提前生成好的版本，先跑一次采集：node src/collect.js');
  }
  console.log('');
  console.log('要停止网站：点这个黑窗口，按 Ctrl+C，或者直接关掉窗口。');
});
