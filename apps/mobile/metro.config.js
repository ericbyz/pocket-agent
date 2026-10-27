const { getDefaultConfig } = require('expo/metro-config')
const path = require('path')

// pnpm monorepo：让 Metro 能解析 workspace 里的 @pocket-agent/protocol
const projectRoot = __dirname
const workspaceRoot = path.resolve(projectRoot, '../..')

const config = getDefaultConfig(projectRoot)
config.watchFolders = [workspaceRoot]
config.resolver.nodeModulesPaths = [
  path.resolve(projectRoot, 'node_modules'),
  path.resolve(workspaceRoot, 'node_modules'),
]

module.exports = config
