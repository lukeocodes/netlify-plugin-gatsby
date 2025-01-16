import path from 'path'

import type { NetlifyPluginOptions } from '@netlify/build'

import { getGatsbyRoot } from './config'

function getCacheDirs(publish) {
  return [publish, normalizedCacheDir(publish)]
}

export async function saveCache({
  publish,
  utils,
}: {
  publish: string
  utils: NetlifyPluginOptions['utils']
}): Promise<void> {
  const cacheDirs = getCacheDirs(publish)

  // @ts-expect-error - `move` is not in the types, but should be passed through to @netlify/cache-utils that support this option
  if (await utils.cache.save(cacheDirs, { move: true })) {
    utils.status.show({
      title: 'Essential Gatsby Build Plugin ran successfully',
      summary: 'Stored the Gatsby cache to speed up future builds. 🔥',
    })
  } else {
    console.log('No Gatsby build found.')
  }
}

export async function restoreCache({ publish, utils }): Promise<void> {
  const cacheDirs = getCacheDirs(publish)

  if (await utils.cache.restore(cacheDirs)) {
    console.log('Found a Gatsby cache. We’re about to go FAST. ⚡️')
  } else {
    console.log('No Gatsby cache found. Building fresh.')
  }
}

export function normalizedCacheDir(publish: string): string {
  return path.join(getGatsbyRoot(publish), `.cache`)
}
