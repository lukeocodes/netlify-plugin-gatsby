import path, { dirname, join } from 'path'
import process from 'process'

import { NetlifyPluginOptions } from '@netlify/build'
import { stripIndent } from 'common-tags'
import { existsSync } from 'fs-extra'
import fetch from 'node-fetch'

import { normalizedCacheDir, restoreCache, saveCache } from './helpers/cache'
import {
  checkConfig,
  mutateConfig,
  shouldSkipFunctions,
  spliceConfig,
  createDatastoreMetadataFile,
} from './helpers/config'
import { patchFile, relocateBinaries } from './helpers/files'
import { deleteFunctions, writeFunctions } from './helpers/functions'
import { checkZipSize } from './helpers/verification'

const DEFAULT_FUNCTIONS_SRC = 'netlify/functions'

export async function onPreBuild({
  constants,
  utils,
  netlifyConfig,
}): Promise<void> {
  const { PUBLISH_DIR } = constants
  // Print a helpful message if the publish dir is misconfigured
  if (!PUBLISH_DIR || process.cwd() === path.resolve(PUBLISH_DIR)) {
    utils.build.failBuild(
      `Gatsby sites must publish the "public" directory, but your site’s publish directory is set to “${PUBLISH_DIR}”. Please set your publish directory to your Gatsby site’s "public" directory.`,
    )
  }
  await restoreCache({ utils, publish: PUBLISH_DIR })

  await checkConfig({ utils, netlifyConfig })
}

// eslint-disable-next-line max-statements
export async function onBuild({
  constants,
  netlifyConfig,
}: NetlifyPluginOptions): Promise<void> {
  const {
    PUBLISH_DIR,
    FUNCTIONS_SRC = DEFAULT_FUNCTIONS_SRC,
    INTERNAL_FUNCTIONS_SRC,
  } = constants
  const cacheDir = normalizedCacheDir(PUBLISH_DIR)

  if (
    INTERNAL_FUNCTIONS_SRC &&
    existsSync(path.join(FUNCTIONS_SRC, 'gatsby'))
  ) {
    console.log(stripIndent`
    Detected the function "${path.join(
      FUNCTIONS_SRC,
      'gatsby',
    )}" that seem to have been generated by an old version of the Essential Gatsby plugin. 
The plugin no longer uses this and it should be deleted to avoid conflicts.\n`)
  }

  if (shouldSkipFunctions(cacheDir)) {
    await deleteFunctions(constants)
    return
  }
  const compiledFunctionsDir = path.join(cacheDir, '/functions')

  if (process.env.LOAD_GATSBY_LMDB_DATASTORE_FROM_CDN === 'true') {
    console.log('Creating site data metadata file')
    await createDatastoreMetadataFile(PUBLISH_DIR)
  }

  await writeFunctions({ constants, netlifyConfig })

  mutateConfig({ netlifyConfig, cacheDir, compiledFunctionsDir })

  const root = dirname(netlifyConfig.build.publish)
  await patchFile(root)
  await relocateBinaries(root)

  // Editing _redirects so it works with ntl dev
  spliceConfig({
    startMarker: '# @netlify/plugin-gatsby redirects start',
    endMarker: '# @netlify/plugin-gatsby redirects end',
    contents: '/api/* /.netlify/functions/__api 200',
    fileName: join(netlifyConfig.build.publish, '_redirects'),
  })
}

export async function onPostBuild({
  constants: { PUBLISH_DIR, FUNCTIONS_DIST },
  utils,
}): Promise<void> {
  await saveCache({ publish: PUBLISH_DIR, utils })
  for (const func of ['api', 'dsg', 'ssr']) {
    await checkZipSize(path.join(FUNCTIONS_DIST, `__${func}.zip`))
  }
}

export async function onSuccess() {
  // Pre-warm the lambdas as downloading the datastore file can take a while
  if (process.env.LOAD_GATSBY_LMDB_DATASTORE_FROM_CDN === 'true') {
    const controller =  new globalThis.AbortController()
    const timeout = setTimeout(() => {
      controller.abort();
    }, 5000);

    for (const func of ['api', 'dsg', 'ssr']) {
      const url = path.join(process.env.URL, '.netlify/functions', `__${func}`)
      console.log(`Sending pre-warm request to: ${url}`)

      try {
        await fetch(url, {signal: controller.signal})
      } catch(err) {
        console.log('Pre-warm request was aborted', err);
      } finally {
        clearTimeout(timeout);
      }
    }
  }
}
