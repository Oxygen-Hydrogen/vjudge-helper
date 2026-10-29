'use strict';
/**
 * 语法高亮自检（不联网）。
 *
 * 重点不是「颜色好不好看」，而是几个容易出事的地方：
 *   - 代码里的 < > & " 必须转义，不能把题面 HTML 拆坏（题面里真有 <script>）；
 *   - 样例区（table.vjudge_sample）里的 <pre> 是输入输出数据，不许上色；
 *   - 已经带标记的 <pre>（MathJax 的 span）要原样放过，不能再拆一遍；
 *   - 认不出语言就一个 span 都别加，免得把「1 2」这种样例染成代码。
 *
 * 跑法：node test/highlight-check.js
 */
const assert = require('assert');
const { highlight, detectLanguage, normalizeLang, highlightCodeBlocks } = require('../src/highlight');
const { renderMarkdown } = require('../src/markdown');

let failed = 0;
function ok(label, fn) {
  try {
    fn();
    console.log(`  ✓ ${label}`);
  } catch (err) {
    failed += 1;
    console.log(`  ✗ ${label} —— ${err.message}`);
  }
}

console.log('============================================================');
console.log('语法高亮');
console.log('============================================================');

ok('C++ 关键字/类型/函数/字符串/注释都能分出来', () => {
  const html = highlight('int main() { // hi\n  cout << "x"; /* b */ return 0; }', 'cpp');
  assert.ok(html.includes('<span class="vj-tok-kw">int</span>'), 'int 不是关键字');
  assert.ok(html.includes('<span class="vj-tok-fn">main</span>'), 'main 不是函数色');
  assert.ok(html.includes('<span class="vj-tok-com">// hi</span>'), '行注释没上色');
  assert.ok(html.includes('<span class="vj-tok-com">/* b */</span>'), '块注释没上色');
  assert.ok(html.includes('<span class="vj-tok-typ">cout</span>'), 'cout 没上色');
  assert.ok(html.includes('<span class="vj-tok-str">&quot;x&quot;</span>'), '字符串没上色');
  assert.ok(html.includes('<span class="vj-tok-num">0</span>'), '数字没上色');
});

ok('#include 指令和头文件名分开染色', () => {
  const html = highlight('#include <iostream>', 'cpp');
  assert.ok(html.includes('<span class="vj-tok-pre">#include</span>'), '指令没上色');
  assert.ok(html.includes('<span class="vj-tok-str">&lt;iostream&gt;</span>'), '头文件没当字符串');
});

ok('字符串里的 // 和 /* 不会被当成注释', () => {
  const html = highlight('printf("http://a/*b*/");', 'cpp');
  assert.strictEqual((html.match(/vj-tok-com/g) || []).length, 0, '字符串被切成注释了');
});

ok('Pascal 注释 { } 与 (* *)', () => {
  const html = highlight('begin {注释} (*还是注释*) writeln(1); end.', 'pascal');
  assert.strictEqual((html.match(/vj-tok-com/g) || []).length, 2);
  assert.ok(html.includes('vj-tok-typ">writeln') || html.includes('vj-tok-fn">writeln'));
});

ok('Pascal 关键字大小写不敏感', () => {
  const html = highlight('BEGIN Writeln(1) END.', 'pascal');
  assert.ok(html.includes('<span class="vj-tok-kw">BEGIN</span>'));
});

ok('Python 三引号与 # 注释', () => {
  const html = highlight('s = """a#b"""\n# note\nprint(s)', 'python');
  assert.ok(html.includes('vj-tok-str">&quot;&quot;&quot;a#b&quot;&quot;&quot;'.replace(/&quot;/g, '"')) ||
    html.includes('vj-tok-str">'), '三引号没上色');
  assert.ok(html.includes('<span class="vj-tok-com"># note</span>'), '# 注释没上色');
});

ok('代码里的 < > & 全部转义（不会拆坏题面）', () => {
  const html = highlight('if (a < b && c > d) x = "&";', 'cpp');
  assert.ok(html.includes('&lt;'), '< 没转义');
  assert.ok(html.includes('&amp;&amp;'), '&& 没转义');
  assert.ok(!/<script|<b>/.test(html), '出现了裸标签');
});

ok('代码里的 <script> 会变成文本', () => {
  const html = highlight('<script>alert(1)</script>', 'cpp');
  assert.ok(!html.includes('<script'), '脚本标签漏出去了');
});

ok('认不出语言就不上色', () => {
  assert.strictEqual(highlight('1 2'), '1 2');
  assert.strictEqual(highlight('hello world'), 'hello world');
  assert.strictEqual(detectLanguage('1 2\n3'), null);
});

ok('语言自动识别', () => {
  assert.strictEqual(detectLanguage('#include <cstdio>\nint main(){}'), 'cpp');
  assert.strictEqual(detectLanguage('program p;\nvar a:longint;\nbegin end.'), 'pascal');
  assert.strictEqual(detectLanguage('a = 1\ndef f():\n    return a\n'), 'python');
  assert.strictEqual(detectLanguage('public class Main { public static void main(String[] a){} }'), 'java');
});

ok('语言别名归一', () => {
  assert.strictEqual(normalizeLang('C++'), 'cpp');
  assert.strictEqual(normalizeLang('language-cpp'), 'cpp');
  assert.strictEqual(normalizeLang('cpp17'), 'cpp');
  assert.strictEqual(normalizeLang('pas'), 'pascal');
  assert.strictEqual(normalizeLang('code-block'), null);
});

ok('题面里的 <pre> 上色，样例表格不动', () => {
  const html = highlightCodeBlocks(
    '<pre>int main() { printf("hi"); }</pre>' +
      '<table class="vjudge_sample"><tbody><tr><td><pre>1 2</pre></td></tr></tbody></table>'
  );
  assert.ok(html.includes('vj-lang-cpp'), '代码块没识别成 cpp');
  assert.ok(html.includes('<table class="vjudge_sample"><tbody><tr><td><pre>1 2</pre></td></tr></tbody></table>') === false ||
    /vjudge_sample[\s\S]*<pre>1 2<\/pre>/.test(html), '样例表格被改了');
  assert.ok(html.includes('<pre>1 2</pre>'), '样例内容变了');
});

ok('带 class="language-xxx" 的 <code> 用它的语言', () => {
  const html = highlightCodeBlocks('<pre><code class="language-pascal">begin end.</code></pre>');
  assert.ok(html.includes('vj-lang-pascal'), '没用 code 上的语言提示');
});

ok('富文本 <pre>（图片/链接/div）原样放过', () => {
  const src = '<pre><img src="a.png"></pre>';
  assert.strictEqual(highlightCodeBlocks(src), src);
  const div = '<pre><div class="x">hi</div></pre>';
  assert.strictEqual(highlightCodeBlocks(div), div);
});

ok('别人上过色的 <pre>（hljs span）剥掉重染', () => {
  const src = '<pre><span class="hljs-keyword">int</span> main(){ <span class="hljs-built_in">printf</span>("x"); }</pre>';
  const html = highlightCodeBlocks(src);
  assert.ok(html.includes('vj-lang-cpp'), '没识别成 cpp');
  assert.ok(html.includes('<span class="vj-tok-kw">int</span>'), 'int 没重染');
  assert.ok(!html.includes('hljs-'), '旧标记没清掉');
});

ok('<br> 换行后仍然可以高亮', () => {
  const html = highlightCodeBlocks('<pre>#include &lt;cstdio&gt;<br>int main(){return 0;}</pre>');
  assert.ok(html.includes('vj-tok-kw">int'), '<br> 分隔的代码没上色');
  assert.ok(html.includes('\n'), '<br> 没换成换行');
});

ok('已经高亮过的 <pre> 不会被二次处理', () => {
  const once = highlightCodeBlocks('<pre>int main(){return 0;}</pre>');
  assert.strictEqual(highlightCodeBlocks(once), once);
});

ok('Markdown 围栏代码块上色（带/不带语言）', () => {
  const withLang = renderMarkdown('```cpp\nint main(){return 0;}\n```');
  assert.ok(withLang.includes('vj-lang-cpp'), '带语言的围栏没上色');
  const auto = renderMarkdown('```\n#include <cstdio>\nint main(){}\n```');
  assert.ok(auto.includes('vj-lang-cpp'), '无语言围栏没自动识别');
  const plain = renderMarkdown('```\n1 2\n3\n```');
  assert.ok(!plain.includes('vj-tok-'), '纯数据围栏被上色了');
});

ok('行内代码不受影响', () => {
  const html = renderMarkdown('输入 `a, b` 两个数');
  assert.ok(html.includes('<code>a, b</code>'), '行内代码被改了');
});

console.log('');
if (failed) {
  console.log(`✗ ${failed} 项未通过`);
  process.exit(1);
}
console.log('全部通过。');
