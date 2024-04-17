/* eslint-disable max-lines */
import { EOL } from 'os'
import { dirname, posix, resolve, join } from 'path'
import process from 'process'

import { NetlifyConfig } from '@netlify/build'
import fs, {
  readJSON,
  readdir,
  existsSync,
  copySync,
  writeJSON,
  ensureFileSync,
} from 'fs-extra'
import type { GatsbyConfig, PluginRef } from 'gatsby'
import { v4 as uuidv4 } from 'uuid'

import { checkPackageVersion, findModuleFromBase } from './files'
import type { FunctionList } from './functions'

/**
 * Checks to see if GATSBY_EXCLUDE_DATASTORE_FROM_BUNDLE is enabled
 */
export function shouldSkipBundlingDatastore(): boolean {
  return (
    isEnvSet('GATSBY_EXCLUDE_DATASTORE_FROM_BUNDLE') &&
    Boolean(process.env.DEPLOY_PRIME_URL)
  )
}

export async function spliceConfig({
  startMarker,
  endMarker,
  contents,
  fileName,
}: {
  startMarker: string
  endMarker: string
  contents: string
  fileName: string
}): Promise<void> {
  await fs.ensureFile(fileName)
  const data = await fs.readFile(fileName, 'utf8')
  const [initial = '', rest = ''] = data.split(startMarker)
  const [, final = ''] = rest.split(endMarker)
  const out = [
    initial === EOL ? '' : initial,
    initial.endsWith(EOL) ? '' : EOL,
    startMarker,
    EOL,
    contents,
    EOL,
    endMarker,
    final.startsWith(EOL) ? '' : EOL,
    final === EOL ? '' : final,
  ]
    .filter(Boolean)
    .join('')

  return fs.writeFile(fileName, out)
}

function loadGatsbyConfig({ gatsbyRoot }) {
  const gatsbyConfigFileJS = resolve(gatsbyRoot, 'gatsby-config.js');
  const gatsbyConfigFileTS = resolve(gatsbyRoot, 'gatsby-config.ts');

  let gatsbyConfigFile = '';

  if (existsSync(gatsbyConfigFileJS)) {
    gatsbyConfigFile = gatsbyConfigFileJS;
  } else if (existsSync(gatsbyConfigFileTS)) {
    gatsbyConfigFile = gatsbyConfigFileTS;
  } else {
    return {};
  }

   // eslint-disable-next-line n/global-require, import/no-dynamic-require, @typescript-eslint/no-var-requires
  return require(gatsbyConfigFile) as GatsbyConfig;
}

function hasPlugin(plugins: PluginRef[], pluginName: string): boolean {
  return plugins?.some(
    (plugin) =>
      plugin &&
      (typeof plugin === 'string'
        ? plugin === pluginName
        : plugin.resolve === pluginName),
  )
}

async function checkGatsbyPluginsCompatibility({
  utils,
  gatsbyRoot,
  gatsbyConfig,
}): Promise<void> | never {
  // warn if gatsby-plugin-netlify is missing
  if (hasPlugin(gatsbyConfig.plugins, 'gatsby-plugin-netlify')) {
    if (
      !(await checkPackageVersion(
        gatsbyRoot,
        'gatsby-plugin-netlify',
        '>=4.2.0',
      ))
    ) {
      console.error(
        'The plugin `gatsby-plugin-netlify` does not support DSG, please update to >=4.2.0',
      )
    }
  } else {
    console.error(
      'Please install `gatsby-plugin-netlify` and enable it in your gatsby-config.js. https://www.gatsbyjs.com/plugins/gatsby-plugin-netlify/',
    )
  }

  if (hasPlugin(gatsbyConfig.plugins, 'gatsby-plugin-netlify-cache')) {
    console.error(
      "The plugin 'gatsby-plugin-netlify-cache' is not compatible with the Gatsby build plugin",
    )
    console.error(
      'Please uninstall gatsby-plugin-netlify-cache and remove it from your gatsby-config.js',
    )
    utils.build.failBuild('Incompatible Gatsby plugin installed')
  }
}

export async function checkConfig({ utils, netlifyConfig }): Promise<void> {
  const gatsbyRoot = getGatsbyRoot(netlifyConfig.build.publish)

  let gatsbyConfig: GatsbyConfig | undefined
  try {
    gatsbyConfig = loadGatsbyConfig({
      gatsbyRoot,
    })
  } catch (error) {
    console.error(
      `Could not load gatsby-config.js: ${error.message}\n\nUnable to validate if 'gatsby-plugin-netlify' is setup correctly.`,
    )
  }

  if (gatsbyConfig) {
    await checkGatsbyPluginsCompatibility({
      utils,
      gatsbyConfig,
      gatsbyRoot,
    })
  }

  if (
    netlifyConfig.plugins.some(
      (plugin) => plugin && plugin.package === 'netlify-plugin-gatsby-cache',
    )
  ) {
    console.warn(
      "The plugin 'netlify-plugin-gatsby-cache' is no longer required and should be removed.",
    )
  }
}

async function getPreviouslyCopiedDatastoreFileName(
  publishDir: string,
  cacheDir: string,
) {
  try {
    const contents = await readJSON(`${cacheDir}/dataMetadata.json`)
    if (contents.fileName) {
      return contents.fileName
    }
  } catch {}

  const publishFiles = await readdir(resolve(publishDir))
  const datastoreMatch = publishFiles.find(
    (file) => file.startsWith('data-') && file.endsWith('.mdb'),
  )

  if (datastoreMatch) {
    return datastoreMatch
  }

  return null
}
/**
 * Copies the contents of the Gatsby datastore file to the public directory in order
 * to be uploaded to the CDN.
 *
 */
export async function createMetadataFileAndCopyDatastore(
  publishDir: string,
  cacheDir: string,
): Promise<void> {
  const data = join(`${cacheDir}/data/datastore/data.mdb`)
  const previousFileName = await getPreviouslyCopiedDatastoreFileName(
    publishDir,
    cacheDir,
  )
  const fileName = previousFileName || `data-${uuidv4()}.mdb`

  ensureFileSync(`${publishDir}/${fileName}`)
  copySync(data, `${publishDir}/${fileName}`)

  const payload = { fileName }
  ensureFileSync(`${cacheDir}/dataMetadata.json`)

  await writeJSON(`${cacheDir}/dataMetadata.json`, payload)
}

export async function modifyConfig({
  netlifyConfig,
  cacheDir,
  neededFunctions,
  isDev,
}: {
  netlifyConfig: NetlifyConfig
  cacheDir: string
  neededFunctions: FunctionList
  isDev?: boolean
}): Promise<void> {
  mutateConfig({ netlifyConfig, cacheDir, neededFunctions })

  const redirectsFileName = join(netlifyConfig.build.publish, '_redirects')

  await spliceConfig({
    startMarker: '# @netlify/plugin-gatsby redirects start',
    endMarker: '# @netlify/plugin-gatsby redirects end',
    contents: neededFunctions.includes('API')
      ? '/api/* /.netlify/functions/__api 200'
      : '',
    fileName: redirectsFileName,
  })

  if (isDev) {
    // removing redirects that possibly were added for builds previously
    // DSG/SSR is fully handled by gatsby dev server and is not even produced in dev

    // this is a bit of a hack - gatsby-plugin-netlify appends redirects before @netlify/plugin-gatsby
    // so we use gatsby-plugin-netlify marker as start and @netlify/plugin-gatsby start marker as end
    await spliceConfig({
      startMarker: '## Created with gatsby-plugin-netlify',
      endMarker: '# @netlify/plugin-gatsby redirects start',
      contents: '',
      fileName: redirectsFileName,
    })
    // this removes redirects produced by adapters in newer gatsby versions
    // while build plugin doesn't do any work during builds when adapters are used
    // adapters don't have hooks for `develop` so they can't clean their redirects
    // so build plugin is handling that as it still runs (just skips most of the work)
    await spliceConfig({
      startMarker: '# gatsby-adapter-netlify start',
      endMarker: '# gatsby-adapter-netlify end',
      contents: '',
      fileName: redirectsFileName,
    })
  }
}

export function mutateConfig({
  netlifyConfig,
  cacheDir,
  neededFunctions,
}: {
  netlifyConfig: NetlifyConfig
  cacheDir: string
  neededFunctions: FunctionList
}): void {
  /* eslint-disable no-underscore-dangle, no-param-reassign */
  if (neededFunctions.includes('API')) {
    netlifyConfig.functions.__api = {
      included_files: [posix.join(cacheDir, 'functions', '**')],
      external_node_modules: ['msgpackr-extract'],
    }
  }

  if (neededFunctions.includes('DSG')) {
    netlifyConfig.functions.__dsg = {
      included_files: [
        'public/404.html',
        'public/500.html',
        posix.join(cacheDir, 'query-engine', '**'),
        posix.join(cacheDir, 'page-ssr', '**'),
        '!**/*.js.map',
      ],
      external_node_modules: ['msgpackr-extract'],
      node_bundler: 'esbuild',
    }

    if (shouldSkipBundlingDatastore()) {
      netlifyConfig.functions.__dsg.included_files.push(
        '.cache/dataMetadata.json',
      )
    } else {
      netlifyConfig.functions.__dsg.included_files.push(
        posix.join(cacheDir, 'data', '**'),
      )
    }
  }

  if (neededFunctions.includes('SSR')) {
    netlifyConfig.functions.__ssr = {
      included_files: [
        'public/404.html',
        'public/500.html',
        posix.join(cacheDir, 'query-engine', '**'),
        posix.join(cacheDir, 'page-ssr', '**'),
        '!**/*.js.map',
      ],
      external_node_modules: ['msgpackr-extract'],
      node_bundler: 'esbuild',
    }

    if (shouldSkipBundlingDatastore()) {
      netlifyConfig.functions.__ssr.included_files.push(
        '.cache/dataMetadata.json',
      )
    } else {
      netlifyConfig.functions.__ssr.included_files.push(
        posix.join(cacheDir, 'data', '**'),
      )
    }
  }
  /* eslint-enable no-underscore-dangle, no-param-reassign */
}

export async function getNeededFunctions(
  cacheDir: string,
): Promise<FunctionList> {
  if (!existsSync(join(cacheDir, 'functions'))) return []

  const neededFunctions = overrideNeededFunctions(
    await readFunctionSkipFile(cacheDir),
  )

  const functionList = Object.keys(neededFunctions).filter(
    (name) => neededFunctions[name] === true,
  ) as FunctionList

  if (functionList.length === 0) {
    console.log('Skipping Gatsby Functions and SSR/DSG support')
  } else {
    console.log(`Enabling Gatsby ${functionList.join('/')} support`)
  }

  return functionList
}

async function readFunctionSkipFile(cacheDir: string) {
  try {
    // read skip file from gatsby-plugin-netlify
    return await fs.readJson(join(cacheDir, '.nf-skip-gatsby-functions'))
  } catch (error) {
    // missing skip file = all functions needed
    // empty or invalid skip file = no functions needed
    return error.code === 'ENOENT' ? { API: true, SSR: true, DSG: true } : {}
  }
}

function overrideNeededFunctions(neededFunctions) {
  const skipAll = isEnvSet('NETLIFY_SKIP_GATSBY_FUNCTIONS')
  const skipAPI = isEnvSet('NETLIFY_SKIP_API_FUNCTION')
  const skipSSR = isEnvSet('NETLIFY_SKIP_SSR_FUNCTION')
  const skipDSG = isEnvSet('NETLIFY_SKIP_DSG_FUNCTION')

  return {
    API: skipAll || skipAPI ? false : neededFunctions.API,
    SSR: skipAll || skipSSR ? false : neededFunctions.SSR,
    DSG: skipAll || skipDSG ? false : neededFunctions.DSG,
  }
}

function isEnvSet(envVar: string) {
  return process.env[envVar] === 'true' || process.env[envVar] === '1'
}

export function getGatsbyRoot(publish: string): string {
  return resolve(dirname(publish))
}

export function shouldSkip(publishDir: string): boolean {
  if (typeof process.env.NETLIFY_SKIP_GATSBY_BUILD_PLUGIN !== 'undefined') {
    return isEnvSet('NETLIFY_SKIP_GATSBY_BUILD_PLUGIN')
  }

  const siteRoot = getGatsbyRoot(publishDir)

  let shouldSkipResult = false

  try {
    const gatsbyPath = findModuleFromBase({
      paths: [siteRoot],
      candidates: ['gatsby/package.json'],
    })
    if (gatsbyPath) {
      const gatsbyPluginUtilsPath = findModuleFromBase({
        paths: [gatsbyPath, siteRoot],
        candidates: ['gatsby-plugin-utils'],
      })

      // eslint-disable-next-line import/no-dynamic-require, n/global-require, @typescript-eslint/no-var-requires
      const { hasFeature } = require(gatsbyPluginUtilsPath)

      if (hasFeature(`adapters`)) {
        shouldSkipResult = true
      }
    }
  } catch {
    // ignore
  }

  process.env.NETLIFY_SKIP_GATSBY_BUILD_PLUGIN = shouldSkipResult
    ? 'true'
    : 'false'

  if (shouldSkipResult) {
    console.log(
      'Skipping @netlify/plugin-gatsby work, because used Gatsby version supports adapters.',
    )
  }

  return shouldSkipResult
}

export function checkNetlifyImageCdn({
  netlifyConfig,
}: {
  netlifyConfig: NetlifyConfig
}): void {
  /* eslint-disable no-param-reassign */
  const { NETLIFY_IMAGE_CDN } = netlifyConfig.build.environment

  if (NETLIFY_IMAGE_CDN === 'true') {
    netlifyConfig.build.environment.GATSBY_CLOUD_IMAGE_CDN = 'true'
  }
  /* eslint-enable no-param-reassign */
}
/* eslint-enable max-lines */
