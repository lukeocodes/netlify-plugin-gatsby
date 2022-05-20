/* eslint-disable max-lines */
import process from 'node:process'
import { resolve, join } from 'path'

import { copy, readJSON } from 'fs-extra'
import { dir as getTmpDir } from 'tmp-promise'
import { validate } from 'uuid'

import {
  createMetadataFileAndCopyDatastore,
  mutateConfig,
  shouldSkipBundlingDatastore,
} from '../../../src/helpers/config'

const SAMPLE_PROJECT_DIR = `${__dirname}/../../../../demo`
const TEST_TIMEOUT = 20_000

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

describe('shouldSkipBundlingDatastore', () => {
  afterEach(() => {
    delete process.env.GATSBY_EXCLUDE_DATASTORE_FROM_BUNDLE
  })

  it('returns true', () => {
    process.env.GATSBY_EXCLUDE_DATASTORE_FROM_BUNDLE = 'true'
    expect(shouldSkipBundlingDatastore()).toEqual(true)

    process.env.GATSBY_EXCLUDE_DATASTORE_FROM_BUNDLE = '1'
    expect(shouldSkipBundlingDatastore()).toEqual(true)
  })

  it('returns false', () => {
    process.env.GATSBY_EXCLUDE_DATASTORE_FROM_BUNDLE = 'false'
    expect(shouldSkipBundlingDatastore()).toEqual(false)

    process.env.GATSBY_EXCLUDE_DATASTORE_FROM_BUNDLE = '0'
    expect(shouldSkipBundlingDatastore()).toEqual(false)

    delete process.env.GATSBY_EXCLUDE_DATASTORE_FROM_BUNDLE
    expect(shouldSkipBundlingDatastore()).toEqual(false)
  })
})

/* eslint-disable no-underscore-dangle */
describe('mutateConfig', () => {
  const cacheDir = '.cache'
  const neededFunctions = ['API', 'DSG', 'SSR']
  let netlifyConfig, defaultArgs

  beforeEach(() => {
    netlifyConfig = {
      functions: {
        __api: null,
        __dsg: null,
        __ssr: null,
      },
    }
    defaultArgs = {
      netlifyConfig,
      neededFunctions,
      cacheDir,
    }
  })

  afterEach(() => {
    delete process.env.GATSBY_EXCLUDE_DATASTORE_FROM_BUNDLE
  })

  it('includes the dataMetadata file containing gatsby datastore info when GATSBY_EXCLUDE_DATASTORE_FROM_BUNDLE is enabled', () => {
    process.env.GATSBY_EXCLUDE_DATASTORE_FROM_BUNDLE = 'true'
    mutateConfig(defaultArgs)

    expect(netlifyConfig.functions.__api).toStrictEqual({
      included_files: [`${cacheDir}/functions/**`],
      external_node_modules: ['msgpackr-extract'],
    })
    expect(netlifyConfig.functions.__ssr).toStrictEqual(
      netlifyConfig.functions.__dsg,
    )

    expect(netlifyConfig.functions.__dsg).toStrictEqual({
      included_files: [
        'public/404.html',
        'public/500.html',
        `${cacheDir}/query-engine/**`,
        `${cacheDir}/page-ssr/**`,
        '!**/*.js.map',
        'public/dataMetadata.json',
      ],
      external_node_modules: ['msgpackr-extract'],
      node_bundler: 'esbuild',
    })
  })

  it('does not include the dataMetadata file containing gatsby datastore info when GATSBY_EXCLUDE_DATASTORE_FROM_BUNDLE is disabled and bundles datastore into lambdas', () => {
    process.env.GATSBY_EXCLUDE_DATASTORE_FROM_BUNDLE = 'false'
    mutateConfig(defaultArgs)

    expect(netlifyConfig.functions.__api).toStrictEqual({
      included_files: [`${cacheDir}/functions/**`],
      external_node_modules: ['msgpackr-extract'],
    })
    expect(netlifyConfig.functions.__ssr).toStrictEqual(
      netlifyConfig.functions.__dsg,
    )
    expect(netlifyConfig.functions.__dsg).toStrictEqual({
      included_files: [
        'public/404.html',
        'public/500.html',
        `${cacheDir}/query-engine/**`,
        `${cacheDir}/page-ssr/**`,
        '!**/*.js.map',
        `${cacheDir}/data/**`,
      ],
      external_node_modules: ['msgpackr-extract'],
      node_bundler: 'esbuild',
    })
  })

  it('does not include the dataMetadata file containing gatsby datastore info when GATSBY_EXCLUDE_DATASTORE_FROM_BUNDLE is undefined and bundles datastore into lambdas', () => {
    mutateConfig(defaultArgs)

    expect(netlifyConfig.functions.__api).toStrictEqual({
      included_files: [`${cacheDir}/functions/**`],
      external_node_modules: ['msgpackr-extract'],
    })
    expect(netlifyConfig.functions.__ssr).toStrictEqual(
      netlifyConfig.functions.__dsg,
    )
    expect(netlifyConfig.functions.__dsg).toStrictEqual({
      included_files: [
        'public/404.html',
        'public/500.html',
        `${cacheDir}/query-engine/**`,
        `${cacheDir}/page-ssr/**`,
        '!**/*.js.map',
        `${cacheDir}/data/**`,
      ],
      external_node_modules: ['msgpackr-extract'],
      node_bundler: 'esbuild',
    })
  })
})
/* eslint-enable no-underscore-dangle */

describe('createMetadataFileAndCopyDatastore', () => {
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
  })
  it(
    'successfully creates a metadata file',
    async () => {
      await moveGatsbyDir()
      const publishDir = resolve('public')

      await createMetadataFileAndCopyDatastore(publishDir)

      const contents = await readJSON(`${publishDir}/dataMetadata.json`)

      const { fileName } = contents
      expect(fileName).toEqual(expect.stringContaining('data-'))

      const uuidId = fileName.slice(
        fileName.indexOf('-') + 1,
        fileName.indexOf('.mdb'),
      )
      expect(validate(uuidId)).toEqual(true)
      // Longer timeout for the test is necessary due to the copying of the demo project into the tmp dir
    },
    TEST_TIMEOUT,
  )
})
/* eslint-enable max-lines */
