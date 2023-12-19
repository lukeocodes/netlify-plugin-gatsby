/* eslint-disable max-lines */
import { NetlifyConfig, NetlifyPluginConstants } from '@netlify/build'
import {
  copy,
  copyFile,
  ensureDir,
  existsSync,
  rm,
  writeFile,
  readFile,
} from 'fs-extra'
import { resolve, join, relative, dirname } from 'pathe'

import { makeApiHandler, makeHandler } from '../templates/handlers'

import { getGatsbyRoot } from './config'

export type FunctionList = Array<'API' | 'SSR' | 'DSG'>

const writeFunction = async ({
  renderMode,
  handlerName,
  appDir,
  functionsSrc,
}) => {
  const source = makeHandler(appDir, renderMode)
  await ensureDir(join(functionsSrc, handlerName))
  await writeFile(join(functionsSrc, handlerName, `${handlerName}.js`), source)
  await copyFile(
    join(__dirname, '..', '..', 'lib', 'templates', 'utils.js'),
    join(functionsSrc, handlerName, 'utils.js'),
  )
}

const adjustRequiresToRelative = async (filesToAdjustRequires: Set<string>) => {
  for (const file of filesToAdjustRequires) {
    const content = await readFile(file, 'utf8')

    const newContent = content.replace(
      /require\(["'`]([^"'`]+)["'`]\)/g,
      (match, request) => {
        console.log({ match, request })
        if (request.startsWith('.')) {
          return match
        }

        const absolutePath = require.resolve(request)
        if (absolutePath === request) {
          // for builtins path will be the same as request
          return match
        }
        const relativePath = relative(dirname(file), absolutePath)
        return `require('./${relativePath}')`
      },
    )

    await writeFile(file, newContent)
  }
}

const writeApiFunction = async ({ appDir, functionDir }) => {
  const source = makeApiHandler(appDir)
  const filesToAdjustRequires = new Set<string>()
  // This is to ensure we're copying from the compiled js, not ts source
  await copy(
    join(__dirname, '..', '..', 'lib', 'templates', 'api'),
    functionDir,
    {
      // this is not actually filtering the files, just collecting copied files
      filter: (_src, dest) => {
        if (/\.[cm]?js$/.test(dest)) {
          filesToAdjustRequires.add(dest)
        }
        return true
      },
    },
  )

  const entryFilePath = join(functionDir, '__api.js')
  filesToAdjustRequires.add(entryFilePath)
  await writeFile(entryFilePath, source)

  await adjustRequiresToRelative(filesToAdjustRequires)
  console.log({ filesToAdjustRequires })
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

  await copyFile(
    join(__dirname, '..', '..', 'src', 'templates', 'ipx.ts'),
    join(constants.INTERNAL_FUNCTIONS_SRC, '_ipx.ts'),
  )

  if (NETLIFY_IMAGE_CDN === `true`) {
    await copyFile(
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
