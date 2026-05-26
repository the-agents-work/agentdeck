// Monorepo-aware Metro config — adds the workspace root to watchFolders so the
// dev server picks up changes in packages/. Inherits all Expo defaults.
const { getDefaultConfig } = require("expo/metro-config");
const path = require("node:path");

const config = getDefaultConfig(__dirname);

const workspaceRoot = path.resolve(__dirname, "../..");
config.watchFolders = [...(config.watchFolders ?? []), workspaceRoot];

module.exports = config;
