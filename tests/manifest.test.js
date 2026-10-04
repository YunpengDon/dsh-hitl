import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { readFileSync, readdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * Guards the package files a DSH profile reads *about* this plugin rather than
 * from it: the manifest the Loader resolves, and the `locale/*.json` resources
 * the plugin list shows.
 *
 * The loader reads `parsed.meta.title` / `parsed.meta.description` from each
 * language file (`app-boot` `package-meta.ts`), and it reaches those files only
 * through the `exports` map. Get either wrong and the plugin still works while
 * its card silently falls back to the bare package name — a defect nobody
 * notices, which is exactly why it is asserted here.
 */
const here = dirname(fileURLToPath(import.meta.url))
const root = join(here, '..')

const manifest = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))

/** Language ids the shipped dictionaries and the browser half both carry. */
const LANGUAGES = ['en', 'zh']

describe('manifest: what a profile reads about this plugin', () => {
  it('keeps a tag-triggered publish workflow wired for trusted publishing', () => {
    const workflow = readFileSync(join(root, '.github', 'workflows', 'release.yml'), 'utf8')
    assert.equal(workflow.includes('tags:'), true, 'the workflow must trigger on version tags')
    assert.equal(workflow.includes('id-token: write'), true, 'OIDC publishing needs the id-token permission')
    assert.equal(workflow.includes('contents: read'), true)
    assert.equal(workflow.includes('npm publish'), true)
    // Provenance is automatic under trusted publishing — but this file *talks*
    // about that, so assert on the publish command, not on the words.
    assert.equal(/npm publish[^\n]*--provenance/.test(workflow), false, 'no --provenance flag on the command')
    // npm matches the configured trusted publisher against this exact filename.
    assert.equal(workflow.includes('release.yml'), true, 'the trusted publisher is configured with this filename')
  })

  it('resolves the resources the Loader asks for by name', () => {
    assert.equal(manifest.name, 'dsh-hitl')
    assert.equal(typeof manifest.description, 'string')
    assert.equal(manifest.exports['.'], './index.js')
    assert.equal(manifest.exports['./client'], './client.js')
    // The locale resources are subpaths: without the pattern the loader cannot
    // resolve them at all, and the card title falls back to the package name.
    assert.equal(manifest.exports['./locale/*.json'], './locale/*.json')
    assert.equal(manifest.files.includes('locale'), true, 'the published files must carry the locale directory')
    assert.equal(manifest.files.includes('client.js'), true)
    assert.equal(manifest.files.includes('lib'), true)
  })

  it('declares the bundle patch and the browser half the bundle needs', () => {
    assert.equal(manifest.dsh.bundle.patch, './cordis.patch.yml')
    assert.equal(manifest.dsh.client.platform, 'web')
    assert.equal(manifest.dsh.client.immediately, true)
    for (const dependency of ['@deepseek-ai/dsh-client-ui-conversation', '@deepseek-ai/dsh-client-ui-session']) {
      assert.equal(manifest.dsh.client.inject.includes(dependency), true, `${dependency} must stay injected`)
    }
  })

  it('gives every shipped language the meta envelope the loader reads', () => {
    const files = readdirSync(join(root, 'locale')).filter(name => name.endsWith('.json'))
    assert.deepEqual(files.map(name => name.slice(0, -5)).sort(), [...LANGUAGES].sort())
    for (const language of LANGUAGES) {
      const resource = JSON.parse(readFileSync(join(root, 'locale', `${language}.json`), 'utf8'))
      assert.equal(typeof resource.meta, 'object', `locale/${language}.json must wrap its copy in "meta"`)
      assert.equal(typeof resource.meta.title, 'string', `locale/${language}.json: meta.title`)
      assert.equal(typeof resource.meta.description, 'string', `locale/${language}.json: meta.description`)
      // A bare top-level title is the shape the loader ignores.
      assert.equal(resource.title, undefined, `locale/${language}.json must not put title at the top level`)
    }
  })
})
