'use strict';
// 兼容层：清理核心已移入插件包 plugin/lib/cleanup.cjs，使插件自包含、可整体移植。
// 这里只做转发，避免出现两份实现。
module.exports = require('../plugin/lib/cleanup.cjs');
