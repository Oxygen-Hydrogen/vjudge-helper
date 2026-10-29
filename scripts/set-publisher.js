'use strict';

/**
 * 设置发布用的 publisher / repository 信息。
 *
 *   node scripts/set-publisher.js <publisherId> [repositoryUrl]
 *   npm run publisher -- my-name https://github.com/my-name/vjudge-helper
 *
 * publisherId 是 marketplace.visualstudio.com/manage 里创建的那个 ID（不是显示名）。
 */

const fs = require('fs');
const path = require('path');

const pkgPath = path.join(__dirname, '..', 'package.json');

function main() {
  const [, , publisherArg, repoArg] = process.argv;
  if (!publisherArg) {
    console.log('用法: node scripts/set-publisher.js <publisherId> [repositoryUrl]');
    console.log('示例: node scripts/set-publisher.js your-name https://github.com/your-name/vjudge-helper');
    process.exitCode = 1;
    return;
  }

  const publisher = publisherArg.trim();
  if (!/^[a-zA-Z0-9][a-zA-Z0-9-]*$/.test(publisher)) {
    console.error(`publisher 只能包含字母、数字和连字符，且不能以连字符开头：${publisher}`);
    process.exitCode = 1;
    return;
  }

  const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
  const oldPublisher = pkg.publisher;
  pkg.publisher = publisher;

  if (repoArg) {
    const url = repoArg.trim().replace(/\.git$/, '');
    pkg.repository = { type: 'git', url };
    pkg.homepage = `${url}#readme`;
    pkg.bugs = { url: `${url}/issues` };
  }

  fs.writeFileSync(pkgPath, `${JSON.stringify(pkg, null, 2)}\n`, 'utf8');
  console.log(`publisher: ${oldPublisher} -> ${publisher}`);
  if (repoArg) console.log(`repository: ${pkg.repository.url}`);
  console.log('\n下一步：');
  console.log('  1. 在 https://marketplace.visualstudio.com/manage 确认该 publisher 已创建');
  console.log('  2. 准备好 Azure DevOps 的 Personal Access Token（Marketplace > Manage 权限）');
  console.log('  3. 运行: npm run publish');
}

main();
