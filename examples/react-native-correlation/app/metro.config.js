// The app imports ../correlation.js, which lives outside the app folder so that Node tests and the app share
// exactly the same code. Metro only bundles files inside its watch folders, so the parent folder is added.
const path = require('path')
const { getDefaultConfig } = require('expo/metro-config')

const config = getDefaultConfig(__dirname)
config.watchFolders = [path.resolve(__dirname, '..')]
// Resolve packages only from this app's node_modules, never from the workspace above it.
config.resolver.nodeModulesPaths = [path.resolve(__dirname, 'node_modules')]
config.resolver.disableHierarchicalLookup = true

module.exports = config
