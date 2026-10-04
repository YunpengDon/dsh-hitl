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

const LANDING_PAGE = 'https://yunpengdon.github.io/dsh-hitl-landing/'

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

  it('sends the reader to the landing page instead of shipping screenshots', () => {
    // The four screenshots used to be the bulk of the published tarball. They
    // live on the landing page now (its own repository carries them, in both
    // languages), so the READMEs must link it and must not reference a local
    // copy — and the package must not carry one either.
    const manifest = JSON.parse(read('package.json'))
    assert.equal(manifest.files.includes('docs'), false, 'screenshots must stay out of the tarball')
    for (const readme of READMES) {
      const text = read(readme.file)
      assert.equal(text.includes(LANDING_PAGE), true, `${readme.file} must link the landing page`)
      assert.equal(
        /!\[[^\]]*\]\(docs\//.test(text), false,
        `${readme.file} must not embed a local screenshot`,
      )
      const header = text.split('\n').slice(0, 8).join('\n')
      assert.equal(header.includes(LANDING_PAGE), true, `${readme.file} must offer the tour near the top`)
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

  it('publishes both READMEs and keeps the screenshot sources in the repository only', () => {
    const manifest = JSON.parse(read('package.json'))
    assert.equal(manifest.files.includes('README.zh.md'), true, 'the Chinese README must be published too')
    // The landing page's own repository carries the screenshots, so a second
    // copy inside the package would only double the download for every install.
    assert.equal(manifest.files.includes('docs'), false, 'screenshot sources must stay out of the tarball')
  })
})
