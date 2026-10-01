// 可传入改动前 collect-status.js，验证故障注入确实能复现旧版问题。
const assert = require('assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const vm = require('vm');

const sourceFile = path.resolve(process.argv[2] || path.join(__dirname, '..', 'src', 'collect-status.js'));
const source = fs.readFileSync(sourceFile, 'utf8');

function scenario(failWrite) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-hub-status-safety-'));
  const srcDir = path.join(root, 'src');
  const dataDir = path.join(root, 'data');
  const statusFile = path.join(dataDir, 'last-collect.json');
  try {
    fs.mkdirSync(srcDir);
    fs.mkdirSync(dataDir);
    fs.writeFileSync(statusFile, JSON.stringify({ status: 'ok', at: 'old' }));
    const before = fs.readFileSync(statusFile);
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
      if (failWrite && target && target.includes('last-collect.json')) {
        fs.writeFileSync(file, '{"status":', 'utf8');
        throw new Error('模拟状态写入中断');
      }
      return fs.writeFileSync(file, ...args);
    };
    const module = { exports: {} };
    vm.runInNewContext(source, {
      module,
      __dirname: srcDir,
      require(name) { return name === 'fs' ? fsProxy : require(name); },
    }, { filename: sourceFile });
    const result = module.exports.writeStatus({ status: 'partial', at: 'new' });
    if (failWrite) {
      assert.equal(result, false);
      assert.equal(Buffer.compare(fs.readFileSync(statusFile), before), 0);
      assert.equal(fs.readdirSync(dataDir).filter(x => x.endsWith('.tmp')).length, 0);
    } else {
      assert.equal(result, true);
      assert.equal(module.exports.readStatus().status, 'partial');
    }
  } finally {
    const prefix = path.join(os.tmpdir(), 'ai-hub-status-safety-');
    if (!root.startsWith(prefix)) throw new Error('拒绝清理非测试目录');
    fs.rmSync(root, { recursive: true, force: true });
  }
}

for (const [name, failWrite] of [['状态写入中断保留旧状态', true], ['状态正常提交', false]]) {
  try {
    scenario(failWrite);
    console.log('PASS ' + name);
  } catch (e) {
    console.error('FAIL ' + name + ': ' + e.message);
    process.exitCode = 1;
  }
}
