import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * Guards the two READMEs against the drift this repository keeps fixing by hand:
 * a screenshot that moved, a language link that points nowhere, and an appendix
 * whose line counts or test counts describe a file as it was three edits ago.
 *
 * The counts exist for readers deciding where to start reading; a stale number
 * is a small lie that costs a reader real time, so each one is asserted against
 * the filesystem instead of trusted.
 */
const root = join(dirname(fileURLToPath(import.meta.url)), '..')

/** The English README is the package's front page; the Chinese one is its twin. */
const READMES = [
  { language: 'en', file: 'README.md', other: 'README.zh.md', suffix: '-en' },
  { language: 'zh', file: 'README.zh.md', other: 'README.md', suffix: '-cn' },
]

const read = relative => readFileSync(join(root, relative), 'utf8')
/** Line count by the `wc -l` convention: the number of newline characters. */
const lineCount = relative => read(relative).split('\n').length - 1

/** Every repository path a basename could name, so the appendix may spell either. */
function locate(name) {
  const candidates = [name, join('lib', name), join('tests', name), join('locale', name), join('docs', name)]
  return candidates.find(candidate => existsSync(join(root, candidate))) ?? name
}

/** The file-structure appendix: the one text block that lists `client.js` and its size. */
function appendixTree(text) {
  const blocks = text.split('```').filter((_block, index) => index % 2 === 1)
  const tree = blocks.find(block => block.includes('client.js') && block.includes('index.js'))
  assert.notEqual(tree, undefined, 'the appendix file-structure block is missing')
  const rows = new Map()
  const testCounts = new Map()
  for (const line of tree.split('\n')) {
    const row = /^[│├└─\s]*([\w.\-]+\.(?:js|json|yml|svg|md))\s+(\d+)\b/.exec(line)
    if (row === null) continue
    rows.set(row[1], Number(row[2]))
    const tests = /[（(](\d+)[）)]/.exec(line)
    if (tests !== null && row[1].endsWith('.test.js')) testCounts.set(row[1], Number(tests[1]))
  }
  return { rows, testCounts }
}

describe('docs: the English and Chinese READMEs', () => {
  it('links each language to the other', () => {
    for (const readme of READMES) {
      const text = read(readme.file)
      assert.equal(text.includes(`](${readme.other})`), true, `${readme.file} must link to ${readme.other}`)
      assert.equal(existsSync(join(root, readme.other)), true, `${readme.other} must exist`)
    }
    // The language line belongs in the header, before the first section.
    for (const readme of READMES) {
      const header = read(readme.file).split('\n').slice(0, 8).join('\n')
      assert.equal(header.includes(readme.other), true, `${readme.file} must offer the switch near the top`)
    }
  })

  it('shows every screenshot, and only its own language', () => {
    const referenced = new Set()
    const available = new Set(readdirSync(join(root, 'docs')))
    for (const readme of READMES) {
      const images = [...read(readme.file).matchAll(/!\[[^\]]*\]\((docs\/[^)]+)\)/g)].map(match => match[1])
      assert.equal(images.length, 4, `${readme.file} must place all four screenshots`)
      for (const image of images) {
        const name = image.slice('docs/'.length)
        assert.equal(available.has(name), true, `${readme.file} references a missing screenshot: ${image}`)
        assert.equal(name.endsWith(`${readme.suffix}.png`), true, `${readme.file} must use its ${readme.suffix} screenshots`)
        referenced.add(name)
      }
    }
    for (const name of available) {
      assert.equal(referenced.has(name), true, `docs/${name} is shipped but never shown`)
    }
  })

  it('keeps both file-structure appendixes identical and true to disk', () => {
    const trees = READMES.map(readme => appendixTree(read(readme.file)))
    const [english, chinese] = trees
    assert.deepEqual([...chinese.rows], [...english.rows], 'the two appendixes must declare the same sizes')
    for (const [name, claimed] of english.rows) {
      const path = locate(name)
      assert.equal(existsSync(join(root, path)), true, `the appendix lists a file that is gone: ${name}`)
      assert.equal(lineCount(path), claimed, `${path} is ${lineCount(path)} lines, the appendix says ${claimed}`)
    }
    // The READMEs are listed without a size on purpose: their own length would
    // change with every edit that keeps the number honest, which has no fixed point.
    const tree = read('README.md').split('```').filter((_b, i) => i % 2 === 1).find(b => b.includes('client.js'))
    for (const name of ['README.md', 'README.zh.md']) {
      assert.equal(tree.includes(name), true, `the appendix must list ${name}`)
    }
  })

  it('keeps the per-file test counts honest', () => {
    for (const readme of READMES) {
      const { testCounts } = appendixTree(read(readme.file))
      assert.equal(testCounts.size, readdirSync(join(root, 'tests')).filter(name => name.endsWith('.test.js')).length)
      for (const [name, claimed] of testCounts) {
        const declared = (read(join('tests', name)).match(/^\s*it\(/gm) ?? []).length
        assert.equal(claimed, declared, `${name}: the appendix says ${claimed} cases, the file declares ${declared}`)
      }
    }
  })

  it('keeps the screenshot folder shipped', () => {
    const manifest = JSON.parse(read('package.json'))
    assert.equal(manifest.files.includes('docs'), true, '`docs` must be published with the screenshots')
    assert.equal(manifest.files.includes('README.zh.md'), true, 'the Chinese README must be published too')
  })
})
