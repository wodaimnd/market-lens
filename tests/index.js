/**
 * 目录入口兼容垫片。
 *
 * Node >= 20.14 / 22 / 24 的 test runner 把位置参数当 glob 处理，不再把
 * `node --test tests/` 里的目录展开为扫描目录（裸目录会被当成单个测试文件去
 * require，报 MODULE_NOT_FOUND）。这里提供 index.js 目录入口，让
 * `node --test tests/` 作为单文件入口执行时仍能加载全部用例；
 * `node --test "tests/**\/*.test.js"` / `npm test` 则直接跑各测试文件。
 */

import './normalize.test.js'
import './build-catalog.test.js'
import './labels-summary.test.js'
import './install-spec.test.js'
import './install-endpoint.test.js'
import './updates.test.js'
import './upgrade.test.js'
import './sync-diff.test.js'
import './security.test.js'
import './source-config-io.test.js'
import './rules.test.js'
import './op-log.test.js'
import './client-load.test.js'
import './client-mount.test.js'
import './client-install-notice.test.js'
import './client-window.test.js'
import './client-persist.test.js'
import './client-pages.test.js'
import './host-install.test.js'
import './host-mount.test.js'
import './health.test.js'
import './host-logs.test.js'
import './host-rules.test.js'
import './host-selfcheck.test.js'
