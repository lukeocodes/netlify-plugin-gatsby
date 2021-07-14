// @ts-check

const path = require('path')
const fs = require('fs-extra')
const { spliceConfig } = require('./helpers/config')

const normalizedCacheDir = (PUBLISH_DIR) =>
  path.normalize(`${PUBLISH_DIR}/../.cache`)

const getCacheDirs = (PUBLISH_DIR) => [
  PUBLISH_DIR,
  normalizedCacheDir(PUBLISH_DIR),
]

const DEFAULT_FUNCTIONS_SRC = 'netlify/functions'

const hasPlugin = (plugins, pluginName) =>
  plugins &&
  plugins.some(
    (plugin) =>
      plugin &&
      (typeof plugin === 'string'
        ? plugin === pluginName
        : plugin.resolve === pluginName),
  )

const loadGatsbyFile = function (utils) {
  const gatsbyConfigFile = path.resolve(process.cwd(), 'gatsby-config.js')
  if (!fs.existsSync(gatsbyConfigFile)) {
    return {}
  }

  try {
    return require(gatsbyConfigFile)
  } catch (error) {
    utils.build.failBuild('Could not load gatsby-config.js', { error })
  }
}

module.exports = {
  async onPreBuild({ constants: { PUBLISH_DIR }, utils, netlifyConfig }) {
    // print a helpful message if the publish dir is misconfigured
    if (!PUBLISH_DIR || process.cwd() === PUBLISH_DIR) {
      utils.build.failBuild(
        `Gatsby sites must publish the public directory, but your site’s publish directory is set to “${PUBLISH_DIR}”. Please set your publish directory to your Gatsby site’s public directory.`,
      )
    }

    const cacheDirs = getCacheDirs(PUBLISH_DIR)

    if (await utils.cache.restore(cacheDirs)) {
      console.log('Found a Gatsby cache. We’re about to go FAST. ⚡️')
    } else {
      console.log('No Gatsby cache found. Building fresh.')
    }

    // warn if gatsby-plugin-netlify is missing
    const pluginName = 'gatsby-plugin-netlify'
    const gatsbyConfig = loadGatsbyFile(utils)

    if (!hasPlugin(gatsbyConfig.plugins, pluginName)) {
      console.warn(
        'Install `gatsby-plugin-netlify` if you would like to support Gatsby redirects. https://www.gatsbyjs.com/plugins/gatsby-plugin-netlify/',
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

    if (
      netlifyConfig.plugins.some(
        (plugin) => plugin && plugin.package === 'netlify-plugin-gatsby-cache',
      )
    ) {
      console.warn(
        "The plugin 'netlify-plugin-gatsby-cache' is no longer required and should be removed.",
      )
    }
  },

  async onBuild({
    constants: { PUBLISH_DIR, FUNCTIONS_SRC = DEFAULT_FUNCTIONS_SRC },
  }) {
    // copying gatsby functions to functions directory
    const compiledFunctions = path.join(
      normalizedCacheDir(PUBLISH_DIR),
      '/functions',
    )
    if (!fs.existsSync(compiledFunctions)) {
      return
    }

    // copying netlify wrapper functions into functions directory
    await fs.copy(
      path.join(__dirname, 'templates'),
      path.join(FUNCTIONS_SRC, 'gatsby'),
    )

    await fs.copy(
      compiledFunctions,
      path.join(FUNCTIONS_SRC, 'gatsby', 'functions'),
    )

    const redirectsPath = path.resolve(`${PUBLISH_DIR}/_redirects`)

    await spliceConfig({
      startMarker: '# @netlify/plugin-gatsby redirects start',
      endMarker: '# @netlify/plugin-gatsby redirects end',
      contents: '/api/* /.netlify/functions/gatsby 200',
      fileName: redirectsPath,
    })

    // add gatsby functions to .gitignore if doesn't exist
    const gitignorePath = path.resolve('.gitignore')

    await spliceConfig({
      startMarker: '# @netlify/plugin-gatsby ignores start',
      endMarker: '# @netlify/plugin-gatsby ignores end',
      contents: `${FUNCTIONS_SRC}/gatsby`,
      fileName: gitignorePath,
    })
  },

  async onPostBuild({ constants: { PUBLISH_DIR }, utils }) {
    const cacheDirs = getCacheDirs(PUBLISH_DIR)

    if (await utils.cache.save(cacheDirs)) {
      utils.status.show({
        title: 'Essential Gatsby Build Plugin ran successfully',
        summary: 'Stored the Gatsby cache to speed up future builds. 🔥',
      })
    } else {
      console.log('No Gatsby build found.')
    }
  },
}
