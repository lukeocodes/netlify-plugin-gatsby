/* eslint-disable max-lines */
import { NetlifyConfig, NetlifyPluginConstants } from '@netlify/build'
import { copy, ensureDir, existsSync, rm, writeFile, readFile } from 'fs-extra'
import { resolve, join, relative, dirname } from 'pathe'

import { makeApiHandler, makeHandler } from '../templates/handlers'

import { getGatsbyRoot } from './config'

export type FunctionList = Array<'API' | 'SSR' | 'DSG'>

/**
 * Adjust package imports in functions we produce to be relative. Those imported packages should always be dependencies
 * of `@netlify/plugin-gatsby` and we can't rely on those imports being resolvable by accident (i.e. npm hoisting deps
 * of this plugin in root node_modules)
 */
export const adjustRequiresToRelative = (
  template: string,
  outputLocation: string,
): string =>
  // built files use CJS so targeting require here despite source files using ESM
  template.replace(/require\(["'`]([^"'`]+)["'`]\)/g, (match, request) => {
    if (request.startsWith('.')) {
      return match
    }

    let absolutePath
    try {
      absolutePath = dirname(require.resolve(`${request}/package.json`))
    } catch {}

    if (!absolutePath) {
      absolutePath = require.resolve(request)
    }

    if (absolutePath === request) {
      // for builtins path will be the same as request
      return match
    }
    const relativePath = `./${relative(dirname(outputLocation), absolutePath)}`
    return `require('${relativePath}')`
  })

const adjustFilesRequiresToRelative = async (
  filesToAdjustRequires: Set<string>,
) => {
  for (const file of filesToAdjustRequires) {
    await writeFile(
      file,
      adjustRequiresToRelative(await readFile(file, 'utf8'), file),
    )
  }
}

const writeFileWithRelativeRequires = (
  outputPath: string,
  source: string,
): Promise<void> =>
  writeFile(outputPath, adjustRequiresToRelative(source, outputPath))

const copyWithRelativeRequires = async (
  src: string,
  dest: string,
): Promise<void> => {
  const filesToAdjustRequires = new Set<string>()
  await copy(src, dest, {
    filter: (_filterSrc, filterDest) => {
      if (/\.[cm]?js$/.test(filterDest)) {
        filesToAdjustRequires.add(filterDest)
      }
      return true
    },
  })
  await adjustFilesRequiresToRelative(filesToAdjustRequires)
}

const writeApiFunction = async ({ appDir, functionDir }) => {
  const source = makeApiHandler(appDir)
  // This is to ensure we're copying from the compiled js, not ts source
  await copyWithRelativeRequires(
    join(__dirname, '..', '..', 'lib', 'templates', 'api'),
    functionDir,
  )
  await writeFileWithRelativeRequires(join(functionDir, '__api.js'), source)
}

const writeFunction = async ({
  renderMode,
  handlerName,
  appDir,
  functionsSrc,
}) => {
  const source = makeHandler(appDir, renderMode)
  await ensureDir(join(functionsSrc, handlerName))
  await writeFileWithRelativeRequires(
    join(functionsSrc, handlerName, `${handlerName}.js`),
    source,
  )
  await copyWithRelativeRequires(
    join(__dirname, '..', '..', 'lib', 'templates', 'utils.js'),
    join(functionsSrc, handlerName, 'utils.js'),
  )
}

export const writeFunctions = async ({
  constants,
  netlifyConfig,
  neededFunctions,
}: {
  constants: NetlifyPluginConstants
  netlifyConfig: NetlifyConfig
  neededFunctions: FunctionList
}): Promise<void> => {
  const { PUBLISH_DIR, INTERNAL_FUNCTIONS_SRC } = constants
  const siteRoot = getGatsbyRoot(PUBLISH_DIR)
  const functionDir = resolve(INTERNAL_FUNCTIONS_SRC, '__api')
  const appDir = relative(functionDir, siteRoot)

  if (neededFunctions.includes('SSR')) {
    await writeFunction({
      renderMode: 'SSR',
      handlerName: '__ssr',
      appDir,
      functionsSrc: INTERNAL_FUNCTIONS_SRC,
    })
  }

  if (neededFunctions.includes('DSG')) {
    await writeFunction({
      renderMode: 'DSG',
      handlerName: '__dsg',
      appDir,
      functionsSrc: INTERNAL_FUNCTIONS_SRC,
    })
  }

  await setupImageCdn({ constants, netlifyConfig })

  if (neededFunctions.includes('API')) {
    await writeApiFunction({ appDir, functionDir })
  }
}

export const setupImageCdn = async ({
  constants,
  netlifyConfig,
}: {
  constants: NetlifyPluginConstants
  netlifyConfig: NetlifyConfig
}) => {
  const { GATSBY_CLOUD_IMAGE_CDN, NETLIFY_IMAGE_CDN } =
    netlifyConfig.build.environment

  if (
    NETLIFY_IMAGE_CDN !== `true` &&
    GATSBY_CLOUD_IMAGE_CDN !== '1' &&
    GATSBY_CLOUD_IMAGE_CDN !== 'true'
  ) {
    return
  }

  await ensureDir(constants.INTERNAL_FUNCTIONS_SRC)

  await copyWithRelativeRequires(
    join(__dirname, '..', '..', 'src', 'templates', 'ipx.ts'),
    join(constants.INTERNAL_FUNCTIONS_SRC, '_ipx.ts'),
  )

  if (NETLIFY_IMAGE_CDN === `true`) {
    await copyWithRelativeRequires(
      join(__dirname, '..', '..', 'src', 'templates', 'image.ts'),
      join(constants.INTERNAL_FUNCTIONS_SRC, '__image.ts'),
    )

    netlifyConfig.redirects.push(
      {
        from: '/_gatsby/image/:unused/:unused2/:filename',
        // eslint-disable-next-line id-length
        query: { u: ':url', a: ':args', cd: ':cd' },
        to: '/.netlify/functions/__image/image_query_compat?url=:url&args=:args&cd=:cd',
        status: 301,
        force: true,
      },
      {
        from: '/_gatsby/image/*',
        to: '/.netlify/functions/__image',
        status: 200,
        force: true,
      },
    )
  } else if (
    GATSBY_CLOUD_IMAGE_CDN === '1' ||
    GATSBY_CLOUD_IMAGE_CDN === 'true'
  ) {
    netlifyConfig.redirects.push(
      {
        from: `/_gatsby/image/:unused/:unused2/:filename`,
        // eslint-disable-next-line id-length
        query: { u: ':url', a: ':args' },
        to: `/.netlify/builders/_ipx/image_query_compat/:args/:url/:filename`,
        status: 301,
        force: true,
      },
      {
        from: '/_gatsby/image/*',
        to: '/.netlify/builders/_ipx',
        status: 200,
        force: true,
      },
    )
  }

  netlifyConfig.redirects.push(
    {
      from: `/_gatsby/file/:unused/:filename`,
      // eslint-disable-next-line id-length
      query: { u: ':url' },
      to: `/.netlify/functions/_ipx/file_query_compat/:url/:filename`,
      status: 301,
      force: true,
    },
    {
      from: '/_gatsby/file/*',
      to: '/.netlify/functions/_ipx',
      status: 200,
      force: true,
    },
  )
}

export const deleteFunctions = async ({
  INTERNAL_FUNCTIONS_SRC,
}: NetlifyPluginConstants): Promise<void> => {
  for (const func of ['__api', '__ssr', '__dsg']) {
    const funcDir = resolve(INTERNAL_FUNCTIONS_SRC, func)
    if (existsSync(funcDir)) {
      await rm(funcDir, { recursive: true, force: true })
    }
  }
}
/* eslint-enable max-lines */
