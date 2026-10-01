// 在系统临时目录运行采集入口；不访问官网，也不修改正式数据。
// 可传入改动前 collect.js 路径，确认同一组用例能复现旧问题。
const assert = require('assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const vm = require('vm');

const sourceFile = path.resolve(process.argv[2] || path.join(__dirname, '..', 'src', 'collect.js'));
const source = fs.readFileSync(sourceFile, 'utf8');
const entry = '(async () => {';
if (!source.includes(entry)) throw new Error('找不到采集入口，测试需要更新');
const runnable = source.replace(entry, 'globalThis.auditDone = (async () => {');
const fixedTime = new Date('2026-09-22T15:00:00+08:00').getTime();

function fixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-hub-collect-safety-'));
  const dataDir = path.join(dir, 'data');
  fs.mkdirSync(path.join(dir, 'src'));
  fs.mkdirSync(dataDir);
  const dataFile = path.join(dataDir, 'competitions.json');
  const statusFile = path.join(dataDir, 'last-collect.json');
  fs.writeFileSync(dataFile, JSON.stringify({
    schema_version: 1,
    generated_at: '2026-09-21T00:00:00.000Z',
    source_results: [],
    competitions: [
      { id: 'alpha:1', source_id: 'alpha', title: '原始甲', register_state: 'open' },
      { id: 'beta:1', source_id: 'beta', title: '原始乙', register_state: 'closed' },
    ],
  }));
  fs.writeFileSync(statusFile, JSON.stringify({ status: 'ok', at: '2026-09-21T00:00:00.000Z' }));
  return { dir, dataFile, statusFile };
}

function cleanup(f) {
  const prefix = path.join(os.tmpdir(), 'ai-hub-collect-safety-');
  if (!f.dir.startsWith(prefix)) throw new Error('拒绝清理非测试目录');
  fs.rmSync(f.dir, { recursive: true, force: true });
}

async function run(f, { title, failDataWrite = false, failRename = false, failBeta = false, failStatus = false }) {
  const saved = JSON.parse(fs.readFileSync(f.dataFile, 'utf8'));
  const alpha = saved.competitions.find(x => x.source_id === 'alpha') ||
    { id: 'alpha:1', source_id: 'alpha', register_state: 'open' };
  const collectors = {
    './collectors/tencent-arena.js': {
      sourceId: 'alpha',
      sourceName: '模拟甲',
      async collect() { return [{ ...alpha, title }]; },
    },
    './collectors/tencent-ad-algo.js': {
      sourceId: 'beta',
      sourceName: '模拟乙',
      async collect() {
        if (failBeta) throw new Error('模拟来源失败');
        return [];
      },
    },
  };
  const trackedFds = new Map();
  const fsProxy = Object.create(fs);
  fsProxy.openSync = (file, ...args) => {
    const fd = fs.openSync(file, ...args);
    trackedFds.set(fd, path.resolve(file));
    return fd;
  };
  fsProxy.closeSync = fd => {
    trackedFds.delete(fd);
    return fs.closeSync(fd);
  };
  fsProxy.writeFileSync = (file, ...args) => {
    const target = typeof file === 'number' ? trackedFds.get(file) : path.resolve(file);
    if (failDataWrite && target &&
        (target === f.dataFile || (target.includes('competitions.json') && target.endsWith('.tmp')))) {
      fs.writeFileSync(file, '{"partial":', 'utf8');
      throw new Error('模拟写入中断');
    }
    return fs.writeFileSync(file, ...args);
  };
  fsProxy.renameSync = (from, to) => {
    if (failRename && path.resolve(to) === f.dataFile) throw new Error('模拟提交失败');
    return fs.renameSync(from, to);
  };
  const captured = [];
  let builds = 0;
  const exitListeners = new Set();
  const fakeProcess = {
    pid: process.pid,
    exitCode: 0,
    on(event, fn) { if (event === 'exit') exitListeners.add(fn); return this; },
    once(event, fn) { return this.on(event, fn); },
    off(event, fn) { if (event === 'exit') exitListeners.delete(fn); return this; },
  };
  class FixedDate extends Date {
    constructor(...args) { super(...(args.length ? args : [fixedTime])); }
    static now() { return fixedTime; }
  }
  const localRequire = name => {
    if (name === 'fs') return fsProxy;
    if (name === 'path') return path;
    if (name.startsWith('./collectors/')) {
      return collectors[name] || { sourceId: name, sourceName: name, async collect() { return []; } };
    }
    if (name === './build.js') return { build() { builds++; } };
    if (name === './collect-status.js') return {
      writeStatus(status) {
        if (failStatus) return false;
        fs.writeFileSync(f.statusFile, JSON.stringify(status));
        return true;
      },
    };
    if (name === './region.js') return { findRegion() { return null; } };
    if (name === './venue.js') return { findVenue() { return null; } };
    return require(name);
  };
  const context = {
    require: localRequire,
    __dirname: path.join(f.dir, 'src'),
    process: fakeProcess,
    console: { log: s => captured.push(String(s)), error: s => captured.push(String(s)) },
    Date: FixedDate,
    Buffer,
  };
  vm.runInNewContext(runnable, context, { filename: sourceFile });
  await context.auditDone;
  return { exitCode: fakeProcess.exitCode, builds, output: captured };
}

const tests = [
  ['写入中断保留旧文件', async f => {
    const before = fs.readFileSync(f.dataFile);
    const result = await run(f, { title: '新记录', failDataWrite: true });
    assert.equal(result.exitCode, 1);
    assert.equal(Buffer.compare(fs.readFileSync(f.dataFile), before), 0);
    assert.equal(JSON.parse(fs.readFileSync(f.statusFile)).status, 'ok');
  }],
  ['提交失败保留旧文件并清理临时文件', async f => {
    const before = fs.readFileSync(f.dataFile);
    const result = await run(f, { title: '新记录', failRename: true });
    assert.equal(result.exitCode, 1);
    assert.equal(Buffer.compare(fs.readFileSync(f.dataFile), before), 0);
    assert.equal(fs.readdirSync(path.dirname(f.dataFile)).filter(x => x.endsWith('.tmp')).length, 0);
  }],
  ['同秒备份不覆盖', async f => {
    await run(f, { title: '第一次' });
    const backupDir = path.join(f.dir, 'data', '_backup');
    const first = fs.readdirSync(backupDir).filter(x => x.startsWith('competitions.') && x.endsWith('.json'));
    assert.equal(first.length, 1);
    const originalBackup = fs.readFileSync(path.join(backupDir, first[0]));
    await run(f, { title: '第二次' });
    const after = fs.readdirSync(backupDir).filter(x => x.startsWith('competitions.') && x.endsWith('.json'));
    assert.equal(after.length, 2);
    assert.deepEqual(fs.readFileSync(path.join(backupDir, first[0])), originalBackup);
  }],
  ['部分失败返回非零', async f => {
    const result = await run(f, { title: '新记录', failBeta: true });
    assert.equal(JSON.parse(fs.readFileSync(f.statusFile)).status, 'partial');
    assert.equal(result.exitCode, 1);
  }],
  ['状态写入失败不重建网页', async f => {
    const before = fs.readFileSync(f.statusFile);
    const result = await run(f, { title: '新记录', failStatus: true });
    assert.equal(result.exitCode, 1);
    assert.equal(result.builds, 0);
    assert.equal(Buffer.compare(fs.readFileSync(f.statusFile), before), 0);
  }],
  ['已有运行锁时拒绝覆盖', async f => {
    const before = fs.readFileSync(f.dataFile);
    const lockFile = path.join(f.dir, 'data', '.collect.lock');
    fs.writeFileSync(lockFile, 'held');
    const result = await run(f, { title: '新记录' });
    assert.equal(result.exitCode, 1);
    assert.equal(Buffer.compare(fs.readFileSync(f.dataFile), before), 0);
    assert.equal(fs.readFileSync(lockFile, 'utf8'), 'held');
  }],
];

(async () => {
  let failed = 0;
  for (const [name, test] of tests) {
    const f = fixture();
    try {
      await test(f);
      console.log('PASS ' + name);
    } catch (e) {
      failed++;
      console.error('FAIL ' + name + ': ' + e.message);
    } finally {
      cleanup(f);
    }
  }
  process.exitCode = failed ? 1 : 0;
})();
