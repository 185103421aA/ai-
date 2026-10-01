// ============================================================
// 打包：把"服务器上要用的那几个文件"打成 1 个 zip
//
// 用法：node deploy\pack.js
//   （平时由 上线准备.bat 自动调用）
//
// 【包里装什么？】
//   1. public\index.html 和 public\detail\*.html  —— "做好的网页"本身（22 张）
//   2. public\robots.txt 和 public\sitemap.xml    —— 给搜索引擎看的两个小文件（2026-09-16 补）
//   为什么别的都不装：
//     · src\        —— 服务器上不跑程序（静态上线路线），装了等于把家底放公网
//     · data\       —— 采集数据留在你自己电脑上，公网只需要网页
//     · site-config.js —— 备案号在生成网页时就已经写进 html 里了
//   所以传上去的东西 = 观众能看到的全部内容，一个多余文件都没有。
//
//   ★【2026-09-16 修的漏洞】以前这里只挑 "index.html + detail\*.html" 两种后缀，
//     于是新加的两个搜索引擎文件（robots.txt / sitemap.xml）【永远打不进去】——
//     网页上做得好好的，传上服务器却是 404，等于白做。现在按"public 根目录下该传的文件"
//     列出来，并加了两条断言：文件不在、或者列表里没有它们，就直接报错，不静默跳过。
//
// 【为什么用 zip 而不是一个个传】
//   24 个文件一个个上传又慢又容易漏（漏一个 detail 子页点击就 404）。
//   打成 1 个包，服务器上右键"解压"就完事。
// ============================================================

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const zlib = require('zlib');
const { spawn } = require('child_process');

const PROJECT_ROOT = path.join(__dirname, '..');
const DEPLOY_DIR = __dirname;
const DIST_DIR = path.join(DEPLOY_DIR, 'dist');
const PUBLIC_DIR = path.join(PROJECT_ROOT, 'public');

function stamp() {
  const d = new Date();
  const p = n => String(n).padStart(2, '0');
  return d.getFullYear() + p(d.getMonth() + 1) + p(d.getDate()) + '-' + p(d.getHours()) + p(d.getMinutes()) + p(d.getSeconds());
}
const sha16 = buf => crypto.createHash('sha256').update(buf).digest('hex').slice(0, 16).toUpperCase();
const sha16File = f => sha16(fs.readFileSync(f));

// public 根目录下"必须一起传上去"的文件（顺序固定，方便比对）
//   ★ 详情子页不在这里，它们由 listSiteFiles 顺着 detail\ 文件夹扫出来。
const PUBLIC_ROOT_FILES = ['index.html', 'robots.txt', 'sitemap.xml'];

// public 根目录下"整个文件夹都要一起传上去"的目录（2026-09-17 新增）
// 【为什么必须写在这】网页这一版开始用主题自带的素材了（public\media\ 下有字体、
//   底图、几个图形）。这些东西【漏传任何一个都是"页面看着少一块"】：
//   字体漏了 → 全站退回系统字体；底图漏了 → 背景变成纯色；图形漏了 → 出现破图。
//   而它们又不像 index.html 那样"少了会有人立刻发现"，所以必须由程序盯着。
//   ★ 交接单第十五版那个坑就是这个道理："改了网页、没重新打包"，传上去的还是旧的。
//   ★ 别往这里放详情页（detail\ 由 listSiteFiles 单独扫，重复列会打两遍）。
const PUBLIC_MEDIA_DIRS = ['media'];

// 把一个目录下的文件全扫出来（含子目录），返回相对 public\ 的路径。
// 顺序【排过序】：清单是给人对着核的，顺序固定才好一行一行比。
function listDirFiles(rootDir, prefix, out) {
  if (!fs.existsSync(rootDir)) return;
  for (const name of fs.readdirSync(rootDir).sort()) {
    const abs = path.join(rootDir, name);
    const rel = prefix + '/' + name;
    if (fs.statSync(abs).isDirectory()) listDirFiles(abs, rel, out);
    else out.push({ abs, rel });
  }
}

// 服务器上要用的文件（按相对路径列出来，顺序固定，方便比对）
function listSiteFiles() {
  const out = [];

  // 1) public 根目录下那几个文件（首页 + 两个搜索引擎文件）
  for (const rel of PUBLIC_ROOT_FILES) {
    const abs = path.join(PUBLIC_DIR, rel);
    if (!fs.existsSync(abs)) continue;      // 缺哪个由下面的 pack() 报出来，这里不硬造
    out.push({ abs, rel });
  }

  // 2) 详情子页
  const dir = path.join(PUBLIC_DIR, 'detail');
  if (fs.existsSync(dir)) {
    for (const f of fs.readdirSync(dir).sort()) {
      if (f.toLowerCase().endsWith('.html')) out.push({ abs: path.join(dir, f), rel: 'detail/' + f });
    }
  }

  // 3) 素材（字体 / 底图 / 图形），2026-09-17 新增
  for (const d of PUBLIC_MEDIA_DIRS) {
    listDirFiles(path.join(PUBLIC_DIR, d), d, out);
  }
  return out;
}

// 打包前先查"该有的文件是不是都有"（少了就说清楚少哪个，绝不让它悄悄漏掉）
function checkRequiredFiles() {
  const missing = PUBLIC_ROOT_FILES
    .filter(rel => !fs.existsSync(path.join(PUBLIC_DIR, rel)))
    .map(rel => 'public\\' + rel);
  // 素材目录：整个目录不存在、或者里面一个文件都没有，都算"少了"——
  // 这两种情况打出来的包都会让页面缺字体/缺底图，必须在这里拦住（2026-09-17）
  for (const d of PUBLIC_MEDIA_DIRS) {
    const dir = path.join(PUBLIC_DIR, d);
    const found = [];
    listDirFiles(dir, d, found);
    if (!found.length) missing.push('public\\' + d + '\\（这个文件夹是空的或不存在）');
  }
  return missing;
}

// 用 Windows 自带的 PowerShell 打包（不装任何东西）
function runPowerShell(command) {
  return new Promise(resolve => {
    // stdio 用 inherit：把 PowerShell 的报错原样显示给用户，别吞掉
    const child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', command], { stdio: 'inherit' });
    child.on('error', () => resolve(-1));
    child.on('exit', code => resolve(code === null ? -1 : code));
  });
}

// ============================================================
// 【2026-09-16 修的第二个漏洞】zip 里的文件夹路径必须是正斜杠 "/"
//
// 【症状】Windows 自带的 Compress-Archive 会把 detail\xxx.html 里的分隔符
//   原样写成反斜杠（字节 0x5C）。在 Windows 上解压看不出任何问题，
//   但服务器是 Linux（腾讯云 + 宝塔面板），Linux 认为反斜杠是【文件名的合法字符】，
//   于是"解压"出来的是一个名叫 detail\xxx.html 的单文件，而不是 detail\ 文件夹
//   → 首页 20 个【详情】按钮全部 404。
// 【为什么必须在这里改】zip 规范规定条目名用 "/" 分隔（4.4.17.1）。
//   .NET 的 ZipFile::CreateFromDirectory 在 Windows 上同样会写成反斜杠，
//   所以不能换一个"打包命令"了事，必须【逐条指定名字】。
// 【本函数做什么】Compress-Archive 打完之后，就地把条目名里的 0x5C 改成 0x2F。
//   反斜杠和正斜杠都是 1 个字节，所以【只改这一个字节，总字节数完全不变】，
//   压缩数据一个字节都不动。本地文件头和中央目录两处都改（zip 里名字存了两份，
//   只改一处会得到一个自相矛盾的包）。
//   改之前逐条核对"本地头的名字 == 中央目录的名字"，对不上就直接报错，
//   绝不猜着改，免得把一个看不懂的包改坏。
// ============================================================
function fixPackZip(zipPath) {
  const buf = fs.readFileSync(zipPath);

  // 1) 找中央目录结尾记录（EOCD），从尾部往前找，签名 0x06054b50
  let eocd = -1;
  for (let i = buf.length - 22; i >= 0 && i > Math.max(0, buf.length - 66000); i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error('找不到 zip 结尾记录，不敢改（包可能没打完整）');

  const count = buf.readUInt16LE(eocd + 10);
  let off = buf.readUInt32LE(eocd + 16);

  // 2) 逐个本地文件头的"名字"位置（中央目录里只记了头在哪，得自己顺着走）
  const localNameOffset = (index) => {
    let o = 0, n = 0;
    while (true) {
      if (o + 4 > buf.length || buf.readUInt32LE(o) !== 0x04034b50) {
        throw new Error('第 ' + index + ' 个本地文件头没找到 @' + o);
      }
      if (n === index) return o + 30;
      const csize = buf.readUInt32LE(o + 18);
      const nlen = buf.readUInt16LE(o + 26);
      const elen = buf.readUInt16LE(o + 28);
      o += 30 + nlen + elen + csize;
      n++;
    }
  };

  // 3) 找出所有"名字里的反斜杠"，并核对两处名字一致
  const hits = [];
  for (let i = 0; i < count; i++) {
    if (buf.readUInt32LE(off) !== 0x02014b50) throw new Error('中央目录签名不对 @' + off);
    const nlen = buf.readUInt16LE(off + 28);
    const elen = buf.readUInt16LE(off + 30);
    const clen = buf.readUInt16LE(off + 32);
    const name = buf.toString('latin1', off + 46, off + 46 + nlen);
    const lno = localNameOffset(i);
    const lname = buf.toString('latin1', lno, lno + nlen);
    if (lname !== name) {
      throw new Error('本地头和中央目录的文件名不一致（' + lname + ' vs ' + name + '），不敢改');
    }
    for (let k = 0; k < nlen; k++) {
      if (name[k] === '\\') hits.push({ cen: off + 46 + k, loc: lno + k, name, at: k });
    }
    off += 46 + nlen + elen + clen;
  }

  // 4) 本来就干净：什么也不做（留着这个判断，以后换打包方式也不会误改）
  if (!hits.length) return { fixed: 0 };

  // 5) 安全阀：整个文件名里只允许出现干净字符，否则宁可报错也不改
  //   ★ 2026-09-17 修：原来是拿"反斜杠【后面】那一段"去匹配、不许再出现反斜杠。
  //     加了 media\ 之后出现了嵌套目录（media\fonts\orbitron-bold.ttf），
  //     这种名字里有两个反斜杠，老写法会直接把一个正常包判成"不敢改"。
  //     现在改成核对整个名字（两个反斜杠都会被换成斜杠，都合法）。
  for (const h of hits) {
    if (!/^[A-Za-z0-9._\-\/\\]+$/.test(h.name)) {
      throw new Error('文件名里有不干净的字符，拒绝改：' + h.name);
    }
  }

  const fixed = Buffer.from(buf);
  for (const h of hits) { fixed[h.cen] = 0x2F; fixed[h.loc] = 0x2F; }  // 0x5C '\' → 0x2F '/'
  const tmp = zipPath + '.fixtmp';
  fs.writeFileSync(tmp, fixed);
  fs.renameSync(tmp, zipPath);   // 先写临时文件再改名，中途失败也不会留下半个包
  return { fixed: hits.length };
}

// ============================================================
// 【2026-09-16 晚新增】包打完之后自己再验一遍
//
// 【为什么要"自己验自己"】第十三版踩过一个坑：清单里的 zip 指纹是在"改分隔符"之前算的，
//   于是清单和磁盘上的包对不上（用户拿它核对传输会以为传坏了）。
//   根子是同一个：**任何"先生成、再加工"的流程，账（清单/指纹/大小）必须在加工完之后再算。**
//   这类错【不会让任何一条自检变红】—— 页面照样对、自检全绿，只有真去开包比对才会露出来。
//
//   所以这里补一道最硬的关：包一旦生成，就【从包里把每个文件解出来，与 public\ 逐字节比一遍】；
//   再回头看清单上写的包名/大小/指纹是不是真的等于磁盘上这个包。
//   对不上就【不认这个包】——把它和清单一起删掉，绝不留在 dist\ 里等人传上去。
//   （这条保证一旦成立，dist\ 里存在的包就一定是"生成那一刻 public\ 的样子"。）
// ============================================================

// 读一个 zip 的条目表（只走中央目录，不往磁盘上解压）
function readZipEntries(zipPath) {
  const buf = fs.readFileSync(zipPath);

  let eocd = -1;
  for (let i = buf.length - 22; i >= 0 && i > Math.max(0, buf.length - 66000); i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error('找不到 zip 结尾记录（EOCD），包可能没打完整');

  const count = buf.readUInt16LE(eocd + 10);
  let off = buf.readUInt32LE(eocd + 16);
  const entries = [];
  for (let i = 0; i < count; i++) {
    if (buf.readUInt32LE(off) !== 0x02014b50) throw new Error('中央目录签名不对 @' + off);
    // ★ 这些长度字段必须在偏移量前移之前读，否则会读到包外面去（第十三版踩过一次 ERR_OUT_OF_RANGE）
    const method = buf.readUInt16LE(off + 10);
    const csize = buf.readUInt32LE(off + 20);
    const usize = buf.readUInt32LE(off + 24);
    const nlen = buf.readUInt16LE(off + 28);
    const elen = buf.readUInt16LE(off + 30);
    const clen = buf.readUInt16LE(off + 32);
    const lho = buf.readUInt32LE(off + 42);
    const nameBuf = buf.subarray(off + 46, off + 46 + nlen);
    entries.push({ nameBuf, name: nameBuf.toString('utf8'), method, csize, usize, lho });
    off += 46 + nlen + elen + clen;
  }
  return { buf, entries };
}

// 从包里把每个文件解出来，与磁盘 public\ 逐字节比对
function verifyPackMatchesDisk(zipPath, { log = () => {} } = {}) {
  const problems = [];
  let z;
  try {
    z = readZipEntries(zipPath);
  } catch (e) {
    return { ok: false, count: 0, identical: 0, sep: null, problems: ['这个包读不了：' + (e && e.message ? e.message : e)] };
  }
  const { buf, entries } = z;

  // 条目名的分隔符（必须是正斜杠，否则 Linux 上解压会散架）
  let backslash = 0, slash = 0;
  for (const e of entries) {
    for (const b of e.nameBuf) { if (b === 0x5C) backslash++; if (b === 0x2F) slash++; }
  }

  let identical = 0;
  for (const e of entries) {
    try {
      if (e.nameBuf.includes(0x5C)) {
        problems.push(e.name + ' 的条目名里有反斜杠（Linux 服务器上会解出一个怪名字的文件）');
        continue;
      }
      if (buf.readUInt32LE(e.lho) !== 0x04034b50) { problems.push(e.name + ' 的本地文件头签名不对'); continue; }
      const lnlen = buf.readUInt16LE(e.lho + 26);
      const lelen = buf.readUInt16LE(e.lho + 28);
      const lname = buf.subarray(e.lho + 30, e.lho + 30 + lnlen);
      if (!lname.equals(e.nameBuf)) { problems.push(e.name + ' 在包里的两个名字（本地头 / 中央目录）不一致'); continue; }

      const dataOff = e.lho + 30 + lnlen + lelen;
      const raw = buf.subarray(dataOff, dataOff + e.csize);
      let out;
      if (e.method === 0) out = raw;
      else if (e.method === 8) out = zlib.inflateRawSync(raw);
      else { problems.push(e.name + ' 用了不认识的压缩方式 ' + e.method); continue; }

      const diskPath = path.join(PUBLIC_DIR, e.name);
      if (!fs.existsSync(diskPath)) { problems.push(e.name + ' 在包里，但 public\\ 里没有这个文件'); continue; }
      if (Buffer.compare(out, fs.readFileSync(diskPath)) === 0) identical++;
      else problems.push(e.name + ' 的内容和 public\\ 里的对不上（包里的不是最新那一版）');
    } catch (err) {
      problems.push(e.name + ' 解不开：' + (err && err.message ? err.message : err));
    }
  }

  // 反方向：public\ 里有、包里却没有的（漏传 → 传上去 404）
  const inPack = new Set(entries.map(e => e.name));
  for (const f of listSiteFiles()) {
    if (!inPack.has(f.rel)) problems.push(f.rel + ' 在 public\\ 里，但没打进包（传上去会 404）');
  }

  return {
    ok: entries.length > 0 && problems.length === 0 && identical === entries.length,
    count: entries.length,
    identical,
    sep: { backslash, slash },
    problems,
  };
}

// 核对清单上写的（包名 / 大小 / 指纹 / 每一行）和磁盘上的包、public\ 是不是一回事
function verifyManifest(manifestPath, zipPath) {
  const problems = [];
  if (!fs.existsSync(manifestPath)) {
    return { ok: false, rows: 0, bad: 0, problems: ['清单文件不存在：' + path.basename(manifestPath)] };
  }
  const text = fs.readFileSync(manifestPath, 'utf8');
  const grab = re => { const m = text.match(re); return m ? m[1] : null; };

  const name = grab(/zip 文件：(.+)/);
  const size = grab(/zip 大小：(\d+)/);
  const hash = grab(/zip 指纹 sha256 前 16 位：([0-9A-F]+)/);
  const actualSize = fs.statSync(zipPath).size;
  const actualHash = sha16File(zipPath);

  if (name !== path.basename(zipPath)) problems.push('清单写的包名是「' + name + '」，实际是「' + path.basename(zipPath) + '」');
  if (String(actualSize) !== size) problems.push('清单写的大小是 ' + size + ' 字节，实际是 ' + actualSize + ' 字节');
  if (actualHash !== hash) problems.push('清单写的指纹是 ' + hash + '，实际是 ' + actualHash + '（清单算早了 —— 第十三版踩过这个坑）');

  const rows = text.split(/\r?\n/).filter(l => / \/ \d+ \/ [0-9A-F]{16}$/.test(l));
  let bad = 0;
  for (const line of rows) {
    const parts = line.split(' / ');
    const rel = parts[0], s = parts[1], h = parts[2];
    const abs = path.join(PUBLIC_DIR, rel);
    if (!fs.existsSync(abs)) { problems.push('清单里的 ' + rel + ' 在 public\\ 里找不到'); bad++; continue; }
    if (String(fs.statSync(abs).size) !== s || sha16File(abs) !== h) {
      problems.push('清单里 ' + rel + ' 的大小/指纹和 public\\ 里的对不上');
      bad++;
    }
  }
  return { ok: problems.length === 0, rows: rows.length, bad, problems };
}

async function pack({ log = console.log } = {}) {
  // 先查"该有的文件少没少"——缺了就直接拒绝打包，别打一个残包出来给人上传
  const missing = checkRequiredFiles();
  if (missing.length) {
    log('  ✘ 这些文件不存在，不能打包：' + missing.join('、'));
    log('    （多半是还没重新生成网页 —— 双击 上线准备.bat 会重画，它会生成 robots.txt 和 sitemap.xml）');
    return { ok: false, missing };
  }

  const files = listSiteFiles();
  if (!files.length) {
    log('  ✘ public 里没有可打包的网页（先双击 上线准备.bat，它会先生成网页）');
    return { ok: false };
  }

  // 再核一遍：robots.txt / sitemap.xml 必须真的在待打包清单里（防止以后有人改坏上面的逻辑）
  const rels = files.map(f => f.rel);
  const notPacked = PUBLIC_ROOT_FILES.filter(r => !rels.includes(r));
  if (notPacked.length) {
    log('  ✘ 该进包的文件没进清单：' + notPacked.join('、') + '（打包脚本出问题了）');
    return { ok: false, missing: notPacked };
  }

  const stage = path.join(DEPLOY_DIR, '.stage-' + stamp());
  fs.rmSync(stage, { recursive: true, force: true });
  fs.mkdirSync(path.join(stage, 'detail'), { recursive: true });
  let bytes = 0;
  for (const f of files) {
    const dest = path.join(stage, f.rel);
    // ★ 先建好它所在的文件夹：素材在 media\ 的子目录里（media\fonts\…），
    //   父目录不存在时 copyFileSync 会直接报错（2026-09-17 加 media 时踩到过）
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.copyFileSync(f.abs, dest);
    bytes += fs.statSync(f.abs).size;
  }

  fs.mkdirSync(DIST_DIR, { recursive: true });
  const name = 'site-' + stamp() + '.zip';
  const zip = path.join(DIST_DIR, name);
  fs.rmSync(zip, { force: true });

  const code = await runPowerShell(
    'Compress-Archive -Path ' + "'" + path.join(stage, '*') + "'" +
    ' -DestinationPath ' + "'" + zip + "'" + ' -Force'
  );
  fs.rmSync(stage, { recursive: true, force: true });

  if (code !== 0 || !fs.existsSync(zip)) {
    log('  ✘ 打包失败（PowerShell 的 Compress-Archive 返回 ' + code + '）');
    return { ok: false, code };
  }

  const zipBytes = fs.statSync(zip).size;
  let zipHash = sha16File(zip);   // 下面改完分隔符会重算一次，所以用 let
  const pageCount = files.filter(f => f.rel.endsWith('.html')).length;
  // 素材文件数（字体 / 底图 / 图形），打进包里也算"必须一起传上去"的东西
  const mediaCount = files.filter(f => PUBLIC_MEDIA_DIRS.some(d => f.rel.indexOf(d + '/') === 0)).length;

  // ★ 把条目名里的反斜杠改成正斜杠（Linux 服务器解压才不会散架），见上面 fixPackZip 的说明
  let fixedCount = 0;
  try {
    fixedCount = fixPackZip(zip).fixed;
  } catch (e) {
    log('  ✘ 打包后的路径分隔符修正失败：' + (e && e.message ? e.message : e));
    log('    （这个包先别用：Linux 服务器解压会把文件夹变成文件名）');
    return { ok: false, reason: 'zip-separator' };
  }

  log('  ✔ 已打包：deploy\\dist\\' + name);
  log('     里面 ' + files.length + ' 个文件（网页 ' + pageCount + ' 张 + robots.txt + sitemap.xml + 素材 ' + mediaCount + ' 个），' +
    '原始共 ' + Math.round(bytes / 1024) + ' KB，压完 ' + Math.round(zipBytes / 1024) + ' KB');
  // ★ 指纹必须在上面那次"改分隔符"之后再算：改的是条目名字节，包内容会变，
  //   先算的指纹和磁盘上的包对不上（用户拿它核对传输会以为传坏了）。
  zipHash = sha16File(zip);
  log('     指纹 sha256 前 16 位：' + zipHash);
  if (fixedCount > 0) {
    log('     ✔ 已把包内 ' + fixedCount + ' 处路径分隔符从反斜杠改成正斜杠（Linux 服务器解压需要）');
  }

  // 附一份清单文本，供以后核对（不放进 zip 里，免得给服务器添多余文件）
  const lines = [
    'AI赛事备忘录 · 上线包清单',
    '生成时间：' + new Date().toLocaleString('zh-CN'),
    'zip 文件：' + name,
    'zip 大小：' + zipBytes + ' 字节',
    'zip 指纹 sha256 前 16 位：' + zipHash,
    '文件个数：' + files.length + '（网页 ' + pageCount + ' 张 + robots.txt + sitemap.xml + 素材 ' + mediaCount + ' 个；原始共 ' + bytes + ' 字节）',
    '路径分隔符：' + (fixedCount > 0 ? ('已把 ' + fixedCount + ' 处反斜杠改成正斜杠，可在 Linux 上正常解压') : '本来就是正斜杠'),
    '',
    '相对路径 / 字节 / sha256 前 16 位',
  ];
  for (const f of files) {
    lines.push(f.rel + ' / ' + fs.statSync(f.abs).size + ' / ' + sha16File(f.abs));
  }
  const manifest = path.join(DIST_DIR, name.replace(/\.zip$/, '.manifest.txt'));
  fs.writeFileSync(manifest, lines.join('\r\n') + '\r\n', 'utf8');
  log('     清单：deploy\\dist\\' + path.basename(manifest));

  // ★ 包和清单都写完了，立刻自己复验一遍（见上面 readZipEntries 那段说明）。
  //   对不上就把这个包【撤掉】——宁可这次没有包，也不留一个看不懂的包在 dist\ 里等人传。
  const vPack = verifyPackMatchesDisk(zip);
  const vMan = verifyManifest(manifest, zip);
  if (!vPack.ok || !vMan.ok) {
    log('  ✘ 打包后的自动复验【没通过】，这个包已撤掉，别用它：');
    for (const p of vPack.problems.slice(0, 5)) log('      · ' + p);
    for (const p of vMan.problems.slice(0, 5)) log('      · ' + p);
    fs.rmSync(zip, { force: true });
    fs.rmSync(manifest, { force: true });
    return { ok: false, reason: 'self-verify', problems: vPack.problems.concat(vMan.problems) };
  }
  log('     ✔ 自动复验通过：把包里 ' + vPack.count + ' 个文件解出来，与 public\\ 逐字节相同（' +
    vPack.identical + '/' + vPack.count + '），清单也和这个包对得上');

  return { ok: true, zip, name, zipBytes, zipHash, count: files.length, pageCount, bytes };
}

module.exports = {
  pack, listSiteFiles, checkRequiredFiles, PUBLIC_ROOT_FILES,
  readZipEntries, verifyPackMatchesDisk, verifyManifest,
};

if (require.main === module) {
  pack().then(r => { process.exitCode = r.ok ? 0 : 1; })
    .catch(e => {
      console.error('打包时报错：' + (e && e.stack ? e.stack : e));
      process.exitCode = 1;
    });
}
