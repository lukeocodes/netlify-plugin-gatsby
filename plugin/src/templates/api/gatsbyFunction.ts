import { existsSync } from 'fs'
import path from 'path'

import { match as reachMatch } from '@gatsbyjs/reach-router/lib/utils'
import { HandlerEvent } from '@netlify/functions'
import bodyParser from 'co-body'
import multer from 'multer'

import {
  proxyRequest,
  AugmentedGatsbyFunctionResponse,
  AugmentedGatsbyFunctionRequest,
} from './utils'

const parseForm = multer().any()
type MulterReq = Parameters<typeof parseForm>[0]
type MulterRes = Parameters<typeof parseForm>[1]
/**
 * Execute a Gatsby function
 */
// eslint-disable-next-line complexity, max-statements
export async function gatsbyFunction(
  req: AugmentedGatsbyFunctionRequest,
  res: AugmentedGatsbyFunctionResponse,
  event: HandlerEvent,
) {
  // Multipart form data middleware. because co-body can't handle it
  await new Promise((resolve) => {
    // As we're using a fake Express handler we need to ignore the type to keep multer happy
    parseForm(req as unknown as MulterReq, res as unknown as MulterRes, resolve)
  })
  try {
    // If req.body is populated then it was multipart data
    if (
      !req.files &&
      !req.body &&
      req.method !== 'GET' &&
      req.method !== 'HEAD'
    ) {
      req.body = await bodyParser(req as unknown as Request)
    }
  } catch (error) {
    console.log('Error parsing body', error, req)
  }

  const pathFragment = decodeURIComponent(req.url).replace('/api/', '')

  let functions
  try {
    // @ts-ignore This is generated in the user's site
    functions = require('../../../.cache/functions/manifest.json') // eslint-disable-line node/no-missing-require, node/no-unpublished-require
  } catch {
    return {
      statusCode: 404,
      body: 'Could not load function manifest',
    }
  }

  // Check first for exact matches.
  let functionObj = functions.find(
    ({ functionRoute }) => functionRoute === pathFragment,
  )

  if (!functionObj) {
    // Check if there's any matchPaths that match.
    // We loop until we find the first match.
    functions.some((f) => {
      if (f.matchPath) {
        const matchResult = reachMatch(f.matchPath, pathFragment)
        if (matchResult) {
          req.params = matchResult.params
          if (req.params[`*`]) {
            // Backwards compatability for v3
            // TODO remove in v5
            req.params[`0`] = req.params[`*`]
          }
          functionObj = f

          return true
        }
      }

      return false
    })
  }

  if (functionObj) {
    console.log(`Running ${functionObj.functionRoute}`)
    const start = Date.now()
    // During develop, the absolute path is correct, otherwise we need to use a relative path, as we're in a lambda
    const pathToFunction = process.env.NETLIFY_DEV
      ? functionObj.absoluteCompiledFilePath
      : path.join(
          __dirname,
          '..',
          '..',
          '..',
          // ...We got there in the end
          '.cache',
          'functions',
          functionObj.relativeCompiledFilePath,
        )

    if (process.env.NETLIFY_DEV && !existsSync(pathToFunction)) {
      // Functions are sometimes lazily-compiled, so we check and proxy the request if needed
      console.log(
        'No compiled function found. Proxying to gatsby develop server',
      )
      return proxyRequest(event, res)
    }

    try {
      // Make sure it's hot and fresh from the filesystem
      const fn = require(pathToFunction)

      const fnToExecute = (fn && fn.default) || fn

      await Promise.resolve(fnToExecute(req, res))
    } catch (error) {
      console.error(error)
      // Don't send the error if that would cause another error.
      // eslint-disable-next-line max-depth
      if (!res.headersSent) {
        res
          .status(500)
          .send(
            `Error when executing function "${functionObj.originalRelativeFilePath}": "${error.message}"`,
          )
      }
    }

    const end = Date.now()
    console.log(
      `Executed function "/api/${functionObj.functionRoute}" in ${
        end - start
      }ms`,
    )
  } else {
    res.status(404).send('Not found')
  }
}
