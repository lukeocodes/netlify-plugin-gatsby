// eslint-disable-next-line node/no-unpublished-require
const { buildSite } = require('../../../../helpers')
const { readFileSync } = require('fs')

jest.setTimeout(240_000)
describe('A site using gatsby version with adapters', () => {
  it('successfully builds and disables @netlify/plugin-gatsby and gatsby-plugin-netlify', async () => {
    const {
      success,
      logs: { stdout, stderr },
    } = await buildSite()

    // in CI warnings are outputted to stderr (yikes)
    const fullOutput = stdout + stderr

    if (!success) {
      console.error(fullOutput)
    }

    expect(success).toBeTruthy()

    expect(fullOutput).toContain(
      'Skipping @netlify/plugin-gatsby work, because used Gatsby version supports adapters.',
    )
    expect(fullOutput).toContain('Disabling plugin "gatsby-plugin-netlify"')

    const _redirectsContent = readFileSync('public/_redirects', 'utf8')

    expect(_redirectsContent).not.toContain(
      '# @netlify/plugin-gatsby redirects start',
    )
    expect(_redirectsContent).not.toContain(
      '## Created with gatsby-plugin-netlify',
    )
    expect(_redirectsContent).toContain('# gatsby-adapter-netlify start')
  })
})
