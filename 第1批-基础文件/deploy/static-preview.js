// ============================================================
// 纯静态预览：在本地"假装服务器"，看看网页传上去会是什么样
//
// 用法：node deploy\static-preview.js [要预览的目录]
//   不给目录 = 预览项目里的 public\（也就是马上要传上去的那批文件）
//   （平时双击项目根目录的 预览上线效果.bat）
//
// 【★ 2026-09-16 晚新增：手机预览】
//   默认只监听 127.0.0.1 —— 意思是"只有这台电脑自己"能打开，手机从 Wi-Fi 过来是连不上的
//   （这是好事：否则同一个网络里的人都能看见你本机在跑的站）。
//   想让手机也能看，就设一个环境变量 HOST=0.0.0.0 再跑，它会额外听局域网，
//   并把"手机上该输哪个地址"直接印在黑窗口里。
//   （平时双击项目根目录的 手机上预览.bat，它就是把 HOST 设好再调用本文件。）
//   ★ 不设 HOST 时行为【和以前一模一样】，所以 预览上线效果.bat 没有受任何影响。
//
// 【和"启动网站.bat"有什么区别】
//   启动网站.bat  → 跑的是 src\server.js，它会"缺文件就现场补一张"。
//                   那是给你自己用着方便的。
//   这个预览      → 完全不参与生成，只把磁盘上已有的文件发出去，
//                   规则和 deploy\nginx-site.conf 里写给服务器的一模一样。
//                   所以你看的就是"观众会看到的"。
//
// 【四条规则（和服务器一致）】
//   /                   → 发 index.html
//   /detail/x.html      → 必须有这个文件；没有就 404（不会悄悄发首页顶包）
//   其他任何地址        → 有这个文件就发这个文件（robots.txt / sitemap.xml 走这条），没有就发首页
//   地址里带 .. 的      → 400 拒绝（防止有人跳出网站目录翻别的文件）
// 文件类型按后缀给（.txt → text/plain、.xml → application/xml），和 nginx 一致。
// ============================================================

const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');

const PROJECT_ROOT = path.join(__dirname, '..');
const SERVE_DIR = process.argv[2] ? path.resolve(process.argv[2]) : path.join(PROJECT_ROOT, 'public');
const PORT = Number(process.env.PORT || 8001);
// 默认还是 127.0.0.1（只本机）；设 HOST=0.0.0.0 才会额外听局域网（手机预览用）
const HOST = process.env.HOST || '127.0.0.1';
const LOOPBACK_ONLY = (HOST === '127.0.0.1' || HOST === 'localhost' || HOST === '::1');

// 【不写死 text/html，按后缀给类型（2026-09-16 补）】
//   本机这个预览要"和服务器一模一样"，而服务器（nginx）是按文件后缀定类型的：
//     .html → text/html、.txt → text/plain、.xml → application/xml
//   以前这里对什么文件都回 text/html，于是 robots.txt / sitemap.xml 在预览里是错的类型
//   —— 预览说没事、线上可能是另一回事，那就失去"预览"的意义了。
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.xml': 'application/xml; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  // 2026-09-17 新增：网页开始用主题自带的字体、底图和图形了（public\media\ 下）。
  //   服务器上的 nginx 默认就认识这几种后缀，这里补上是为了"预览和线上一致"。
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.ttf': 'font/ttf',
  '.woff2': 'font/woff2',
  '.css': 'text/css; charset=utf-8',
};
function mimeOf(file) {
  return MIME[path.extname(file).toLowerCase()] || 'application/octet-stream';
}

function sendFile(res, file) {
  fs.readFile(file, (err, buf) => {
    if (err) {
      res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('文件读不出来：' + err.message);
      return;
    }
    res.writeHead(200, {
      'Content-Type': mimeOf(file),
      'Content-Length': buf.length,
      'Cache-Control': 'no-store',
    });
    res.end(buf);
  });
}
function sendText(res, code, text) {
  res.writeHead(code, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(text);
}

const INDEX = path.join(SERVE_DIR, 'index.html');

const server = http.createServer((req, res) => {
  let clean = (req.url || '/').split('?')[0];
  try { clean = decodeURIComponent(clean); } catch (e) { sendText(res, 400, '非法地址。'); return; }

  if (clean === '/favicon.ico') { res.writeHead(204); res.end(); return; }
  if (clean.includes('..') || clean.includes('\\')) { sendText(res, 400, '非法地址。'); return; }

  // 详情页：只认 /detail/xxx.html，文件不存在就 404
  if (/^\/detail\//.test(clean)) {
    if (!/^\/detail\/[A-Za-z0-9._-]+\.html$/.test(clean)) { sendText(res, 404, '这个详情页不存在。'); return; }
    const f = path.join(SERVE_DIR, 'detail', clean.slice('/detail/'.length));
    if (fs.existsSync(f) && fs.statSync(f).isFile()) sendFile(res, f);
    else sendText(res, 404, '这个详情页不存在（可能比赛已截止下线）。回首页看看别的比赛吧。');
    return;
  }

  // 其余地址：有这个文件就发这个文件，没有就把首页发出去（和本机网站一致）
  const direct = path.join(SERVE_DIR, clean.replace(/^\/+/, ''));
  if (clean !== '/' && fs.existsSync(direct) && fs.statSync(direct).isFile()) { sendFile(res, direct); return; }
  if (fs.existsSync(INDEX)) { sendFile(res, INDEX); return; }
  sendText(res, 404, '网页还没生成好：先双击 上线准备.bat 生成网页。');
});

server.on('error', err => {
  if (err.code === 'EADDRINUSE') {
    console.error('端口 ' + PORT + ' 被占用了（可能上次的预览窗口还没关）。关掉旧窗口再试，');
    console.error('或者改用别的端口：set PORT=8002 && node deploy\\static-preview.js');
  } else {
    console.error('预览启动失败：' + err.message);
  }
  process.exitCode = 1;
});

// 【手机预览用】列出这台电脑所有的局域网地址（跳过 127.0.0.1 这种"自己对自己"的地址）
function lanUrls(port) {
  const out = [];
  const ifs = os.networkInterfaces();
  for (const name of Object.keys(ifs)) {
    for (const a of (ifs[name] || [])) {
      if (a.family === 'IPv4' && !a.internal) out.push({ name: name, url: 'http://' + a.address + ':' + port });
    }
  }
  return out;
}

server.listen(PORT, HOST, () => {
  console.log('');
  console.log('【纯静态预览】正在发送的目录：');
  console.log('  ' + SERVE_DIR);
  console.log('');

  if (LOOPBACK_ONLY) {
    console.log('请用浏览器打开：http://127.0.0.1:' + PORT);
    console.log('');
    console.log('这一页看到的，就是"文件传上服务器之后观众看到的"——没有程序参与，只是把文件发出去。');
    console.log('（要停：点这个黑窗口，按 Ctrl+C，或者直接关掉窗口。）');
    console.log('');
    return;
  }

  // ---------- 手机预览模式（HOST 不是本机时才走这里） ----------
  const urls = lanUrls(PORT);
  console.log('【手机预览模式】这个预览现在也听局域网了，手机可以打开。');
  console.log('');
  if (urls.length) {
    console.log('请让手机连上【和这台电脑同一个 Wi-Fi / 热点】，然后用手机浏览器打开：');
    console.log('');
    for (const u of urls) console.log('      ' + u.url + '      （' + u.name + ' 网卡）');
    console.log('');
    console.log('这台电脑自己看，还是用：http://127.0.0.1:' + PORT);
  } else {
    console.log('★ 没找到局域网地址 —— 这台电脑现在没连 Wi-Fi / 网线，手机连不上。');
    console.log('  最省事的办法：用手机开热点，让这台电脑连上，然后重新双击一次。');
  }
  console.log('');
  console.log('★ 手机打不开的话，按顺序查这三样：');
  console.log('   1) 手机和电脑是不是真在同一个 Wi-Fi / 热点上；');
  console.log('   2) 这台电脑的防火墙有没有放行 —— 第一次会弹"是否允许访问"，要点【允许】；');
  console.log('   3) 地址有没有抄错（端口是 ' + PORT + '，别漏了）。');
  console.log('');
  console.log('★ 安全提醒：现在是同一个网络里的人都能看到这个预览。看完就把窗口关掉。');
  console.log('（要停：点这个黑窗口，按 Ctrl+C，或者直接关掉窗口。）');
  console.log('');
});
