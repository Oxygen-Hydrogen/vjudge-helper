'use strict';

/**
 * 发布到 VS Code Marketplace。
 *
 *   npm run publish            # 发布 package.json 里的当前版本
 *   npm run publish -- patch   # 先把版本号 +1（patch/minor/major），再发布
 *
 * 需要环境变量 VSCE_PAT（Azure DevOps 的 Personal Access Token，
 * 权限选 Marketplace > Manage），也可以用 --pat 参数临时传入。
 *
 * 为什么不把 PAT 写进脚本：token 等同于账号权限，不应进仓库。
 */

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const root = path.join(__dirname, '..');
const pkgPath = path.join(root, 'package.json');

function readPkg() {
  return JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
}

function fail(message, hint) {
  console.error(`\n✗ ${message}`);
  if (hint) console.error(hint);
  process.exitCode = 1;
}

function main() {
  const args = process.argv.slice(2);
  const patIndex = args.indexOf('--pat');
  let pat = process.env.VSCE_PAT || process.env.AZURE_DEVOPS_PAT || '';
  if (patIndex >= 0) {
    pat = args[patIndex + 1] || '';
    args.splice(patIndex, 2);
  }
  const bump = args.find((a) => /^(patch|minor|major)$/.test(a)) || '';

  const pkg = readPkg();

  console.log(`扩展：${pkg.publisher}.${pkg.name}@${pkg.version}`);

  if (!fs.existsSync(path.join(root, 'media', 'icon.png'))) {
    fail('缺少 media/icon.png', '运行 npm run icon 生成图标（需要 Pillow：pip install pillow）');
    return;
  }
  if (!fs.existsSync(path.join(root, 'README.md'))) {
    fail('缺少 README.md，Marketplace 会拒绝发布');
    return;
  }
  if (pkg.publisher === 'vjudge-helper') {
    console.log('! publisher 还是占位值 vjudge-helper，如果你已经在 Marketplace 建了自己的 publisher，先运行：');
    console.log('  npm run publisher -- <你的 publisherId>');
  }
  if (!pat) {
    fail(
      '没有找到 Personal Access Token',
      [
        '',
        '  1. 打开 https://dev.azure.com → 右上角 User settings → Personal access tokens → New Token',
        '  2. Scopes 勾选 Marketplace → Manage（其余不用）',
        '  3. 复制 token，然后运行：',
        '       VSCE_PAT=你的token npm run publish',
        '     或  npm run publish -- --pat 你的token',
        '',
      ].join('\n')
    );
    return;
  }

  const hasRepo = !!(pkg.repository && pkg.repository.url);
  if (!hasRepo) {
    console.log('! package.json 没有 repository 字段，Marketplace 页面会缺仓库链接（不影响发布）');
    console.log('  可以补：npm run publisher -- ' + pkg.publisher + ' https://github.com/you/vjudge-helper');
  }

  const vsceArgs = ['--yes', '@vscode/vsce@latest', 'publish', '--no-dependencies', '-p', pat];
  if (bump) vsceArgs.push(bump);
  if (!hasRepo) vsceArgs.push('--allow-missing-repository');

  console.log(`\n> npx ${vsceArgs.slice(1).map((a) => (a === pat ? '***' : a)).join(' ')}\n`);

  const result = spawnSync('npx', vsceArgs, {
    cwd: root,
    stdio: 'inherit',
    shell: process.platform === 'win32',
  });

  if (result.status !== 0) {
    console.error('\n✗ 发布失败，常见原因：');
    console.error('  · PAT 过期 / 权限不足  -> 重新生成 token，Scope 选 Marketplace > Manage');
    console.error(`  · publisher 不匹配      -> publisher 必须是 ${pkg.publisher}，或改成你自己的 ID`);
    console.error('  · 版本已存在            -> npm run publish -- patch');
    process.exitCode = result.status || 1;
    return;
  }

  const after = readPkg();
  const itemName = `${after.publisher}.${after.name}`;
  console.log('\n✓ 发布成功');
  console.log(`  扩展主页: https://marketplace.visualstudio.com/items?itemName=${itemName}`);
  console.log(`  管理页面: https://marketplace.visualstudio.com/manage/publishers/${after.publisher}`);
  console.log(`  （新扩展通常 5~10 分钟后才能被搜到）`);
}

main();
