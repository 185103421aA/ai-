// 隔离验证 scheduler.js / launcher.js 对采集子进程退出码与状态的组合判断。
// 不启动真实子进程、不访问官网、不进入 scheduler 的常驻等待循环。
const assert = require('assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const vm = require('vm');

const root = path.resolve(__dirname, '..');
const schedulerSource = fs.readFileSync(path.join(root, 'src', 'scheduler.js'), 'utf8');
const launcherSource = fs.readFileSync(path.join(root, 'src', 'launcher.js'), 'utf8');

function fakeChild(exitCode) {
  const listeners = new Map();
  const child = {
    on(event, fn) {
      listeners.set(event, fn);
      if (event === 'exit') queueMicrotask(() => fn(exitCode));
      return child;
    },
  };
  return child;
}

async function loadScheduler(status, exitCode) {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-hub-scheduler-test-'));
  const output = [];
  try {
    const module = { exports: {} };
    const source = schedulerSource.replace(
      /main\(\)\.catch\(e => \{[\s\S]*$/, 
      'globalThis.auditRunCollect = runCollect;'
    );
    const context = {
      module,
      __dirname: path.join(temp, 'src'),
      process: {
        execPath: process.execPath,
        env: {},
        stdout: { write(text) { output.push(String(text)); } },
      },
      console,
      setTimeout,
      queueMicrotask,
      require(name) {
        if (name === 'child_process') return { spawn() { return fakeChild(exitCode); } };
        if (name === './collect-status.js') return { readStatus() { return status; } };
        return require(name);
      },
    };
    vm.runInNewContext(source, context, { filename: path.join(root, 'src', 'scheduler.js') });
    const result = await context.auditRunCollect();
    return { result, output: output.join('') };
  } finally {
    fs.rmSync(temp, { recursive: true, force: true });
  }
}

async function loadLauncher(status, exitCode) {
  const output = [];
  const module = { exports: {} };
  const source = launcherSource.replace(
    /main\(\)\.then\(code => \{ process\.exitCode = code \|\| 0; \}\)[\s\S]*$/, 
    'globalThis.auditMain = main;'
  );
  const context = {
    module,
    __dirname: path.join(root, 'src'),
    process: {
      execPath: process.execPath,
      argv: ['node', 'launcher.js', 'update'],
    },
    console: {
      log(text) { output.push(String(text)); },
      error(text) { output.push(String(text)); },
    },
    require(name) {
      if (name === 'child_process') return { spawn() { return fakeChild(exitCode); } };
      if (name === './collect-status.js') return { readStatus() { return status; } };
      if (name === './messages.js') return {
        pickLang() { return 'zh'; },
        makeMessages() { return key => key; },
      };
      if (name === './render.js') return { SITE_NAME: '测试站' };
      return require(name);
    },
  };
  vm.runInNewContext(source, context, { filename: path.join(root, 'src', 'launcher.js') });
  const result = await context.auditMain();
  return { result, output: output.join('') };
}

async function main() {
  // 给 VM 启动和事件派发留出边界，模拟“本次采集刚写入的状态”。
  const now = new Date(Date.now() + 10000).toISOString();
  const stale = '2020-01-01T00:00:00.000Z';

  const schedulerPartial = await loadScheduler({ status: 'partial', at: now }, 1);
  assert.equal(schedulerPartial.result, false);
  assert.match(schedulerPartial.output, /有数据源没成功/);

  const schedulerOk = await loadScheduler({ status: 'ok', at: now }, 0);
  assert.equal(schedulerOk.result, true);
  assert.match(schedulerOk.output, /采集完成/);

  const schedulerStale = await loadScheduler({ status: 'partial', at: stale }, 0);
  assert.equal(schedulerStale.result, false);
  assert.match(schedulerStale.output, /状态未确认/);

  const launcherPartial = await loadLauncher({ status: 'partial', at: now }, 1);
  assert.equal(launcherPartial.result, 1);
  assert.match(launcherPartial.output, /updatePartial/);

  const launcherOk = await loadLauncher({ status: 'ok', at: now }, 0);
  assert.equal(launcherOk.result, 0);
  assert.match(launcherOk.output, /updateOk/);

  const launcherStale = await loadLauncher({ status: 'partial', at: stale }, 0);
  assert.equal(launcherStale.result, 0);
  assert.match(launcherStale.output, /updateFail/);

  console.log('PASS scheduler partial/ok/stale 状态分支');
  console.log('PASS launcher partial/ok/stale 状态分支');
}

main().catch(error => {
  console.error('FAIL ' + error.message);
  process.exitCode = 1;
});
