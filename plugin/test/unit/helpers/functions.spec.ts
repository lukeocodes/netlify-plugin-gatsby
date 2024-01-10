import { join } from 'path'
import process from 'process'

import type { NetlifyConfig, NetlifyPluginOptions } from '@netlify/build'
import Chance from 'chance'
import { copy, existsSync } from 'fs-extra'
import { dir as getTmpDir } from 'tmp-promise'

import {
  adjustRequiresToRelative,
  setupImageCdn,
} from '../../../src/helpers/functions'

const SAMPLE_PROJECT_DIR = `${__dirname}/../../../../demo`
const TEST_TIMEOUT = 60_000

const changeCwd = (cwd) => {
  const originalCwd = process.cwd()
  process.chdir(cwd)
  return () => {
    process.chdir(originalCwd)
  }
}

// Move gatsby project from sample project to current directory
const moveGatsbyDir = async () => {
  await copy(SAMPLE_PROJECT_DIR, join(process.cwd()))
}

const chance = new Chance()

describe('setupImageCdn', () => {
  let cleanup
  let restoreCwd

  beforeEach(async () => {
    const tmpDir = await getTmpDir({ unsafeCleanup: true })

    restoreCwd = changeCwd(tmpDir.path)
    // eslint-disable-next-line prefer-destructuring
    cleanup = tmpDir.cleanup
  })

  afterEach(async () => {
    // Cleans up the temporary directory from `getTmpDir()` and do not make it
    // the current directory anymore
    restoreCwd()
    await cleanup()
  }, TEST_TIMEOUT)
  it(
    'successfully creates a functions-internal directory if it does not exist',
    async () => {
      await moveGatsbyDir()
      const constants: NetlifyPluginOptions['constants'] = {
        INTERNAL_FUNCTIONS_SRC: 'demo/.netlify/functions-internal',
        PUBLISH_DIR: 'demo/public',
        FUNCTIONS_DIST: 'demo/.netlify/functions',
        EDGE_FUNCTIONS_DIST: 'demo/.netlify/edge-functions-dist/',
        IS_LOCAL: true,
        NETLIFY_BUILD_VERSION: '9000.0.0',
        SITE_ID: chance.guid(),
      }

      const netlifyConfig: NetlifyConfig = {
        build: {
          command: 'npm run build',
          publish: 'demo/public',
          base: '.',
          environment: {
            GATSBY_CLOUD_IMAGE_CDN: 'true',
          },
          services: {},
          processing: {
            css: {},
            js: {},
            html: {},
            images: {},
          },
        },
        functions: { '*': {} },
        redirects: [],
        headers: [],
        edge_functions: [],
        plugins: [],
      }

      await setupImageCdn({ constants, netlifyConfig })

      const doesDirectoryExist = existsSync(
        join(process.cwd(), 'demo', '.netlify', 'functions-internal'),
      )

      expect(doesDirectoryExist).toEqual(true)
      // Longer timeout for the test is necessary due to the copying of the demo project into the tmp dir
    },
    TEST_TIMEOUT,
  )
})

describe.skip('adjustRequiresToRelative', () => {
  it('skips node builtins', () => {
    expect(adjustRequiresToRelative('require("fs")', __filename)).toBe(
      'require("fs")',
    )
    expect(adjustRequiresToRelative('require("node:fs")', __filename)).toBe(
      'require("node:fs")',
    )
  })

  it('skips already relative', () => {
    expect(adjustRequiresToRelative('require("./sibling")', __filename)).toBe(
      'require("./sibling")',
    )
    expect(
      adjustRequiresToRelative('require("./nested/foo")', __filename),
    ).toBe('require("./nested/foo")')
    expect(adjustRequiresToRelative('require("../parent")', __filename)).toBe(
      'require("../parent")',
    )
  })

  it('handles packages', () => {
    expect(adjustRequiresToRelative('require("node-fetch")', __filename)).toBe(
      `require('./../../../node_modules/node-fetch/lib/index.js')`,
    )
    expect(adjustRequiresToRelative(`require('multer')`, __filename)).toBe(
      `require('./../../../node_modules/multer/index.js')`,
    )
    expect(
      adjustRequiresToRelative('require(`@gatsbyjs/reach-router`)', __filename),
    ).toBe(
      `require('./../../../node_modules/@gatsbyjs/reach-router/dist/index.js')`,
    )
  })
})
